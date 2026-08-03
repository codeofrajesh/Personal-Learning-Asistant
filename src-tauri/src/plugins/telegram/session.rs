//! Telegram session management.
//!
//! Wraps `grammers_session::SqliteSession` for persistent auth state across restarts.
//! Session file lives at `app_data_dir/tg.session` (same dir as `ple.db`).
//!
//! In-flight login state (phone → code → 2FA) is held here, not in the session file,
//! so a partially-completed login can't survive a crash (the user just re-starts).
//!
//! **The client is built lazily.** Nothing connects at boot; `ensure_client` is called by
//! the first command that needs the network. `tg_check_auth` only calls it when a session
//! file already exists, so a fresh install never touches Telegram until the user connects.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use grammers_client::client::{LoginToken, PasswordToken};
use grammers_client::{Client, SenderPool};
use grammers_session::types::{
    ChannelState, DcOption, PeerId, PeerInfo, UpdateState, UpdatesState,
};
use grammers_session::{BoxFuture, Session, SessionData};
use tauri::{AppHandle, Manager};
use tokio::sync::MutexGuard;

use crate::utils::errors::{AppError, AppResult};

/// The persisted shape of a session.
///
/// `SessionData` itself carries no serde derives (only its component types do), so this is a
/// serializable mirror rather than a newtype over it. Maps become `Vec`s because `PeerId` is a
/// newtype over `i64` that serializes as a scalar — as a JSON object key it would either fail
/// or silently stringify.
///
/// `auth_key` inside `DcOption` is hex-encoded by grammers' own `serde_with` attribute, so the
/// 256-byte keys survive a JSON round-trip exactly.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct PersistedSession {
    home_dc: i32,
    dc_options: Vec<DcOption>,
    peer_infos: Vec<PeerInfo>,
    updates_state: UpdatesState,
}

impl PersistedSession {
    fn from_data(data: &SessionData) -> Self {
        Self {
            home_dc: data.home_dc,
            dc_options: data.dc_options.values().cloned().collect(),
            peer_infos: data.peer_infos.values().cloned().collect(),
            updates_state: data.updates_state.clone(),
        }
    }

    fn into_data(self) -> SessionData {
        // Start from `default()` so the statically-known DC options are present even if the
        // file predates one; the persisted entries (which carry auth keys) then overwrite them.
        let mut data = SessionData {
            home_dc: self.home_dc,
            updates_state: self.updates_state,
            ..SessionData::default()
        };
        for dc in self.dc_options {
            data.dc_options.insert(dc.id, dc);
        }
        data.peer_infos = self
            .peer_infos
            .into_iter()
            .map(|info| (info.id(), info))
            .collect();
        data
    }
}

/// A JSON-file-backed [`Session`].
///
/// Replaces grammers' `SqliteSession`, which cannot coexist with `rusqlite` in this binary:
/// both bundle their own SQLite C library, and libsql asserts on `sqlite3_config` — which
/// fails once `ple.db` has initialized SQLite at boot. See the note in `Cargo.toml`.
///
/// Writes are **synchronous and immediate**: a session mutation that isn't on disk when the
/// process dies costs the user a fresh login, and logins are the single most flood-limited
/// operation Telegram has. The data is a few KB and mutations are rare (login, DC migration,
/// peer caching), so the simplicity is worth more here than batching would be.
pub struct FileSession {
    path: PathBuf,
    data: Mutex<SessionData>,
}

#[derive(Debug)]
pub enum FileSessionError {
    Poisoned,
    Io(std::io::Error),
    Serde(serde_json::Error),
}

impl std::error::Error for FileSessionError {}

impl std::fmt::Display for FileSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileSessionError::Poisoned => write!(f, "session lock is poisoned"),
            FileSessionError::Io(e) => write!(f, "session file io: {e}"),
            FileSessionError::Serde(e) => write!(f, "session file format: {e}"),
        }
    }
}

impl FileSession {
    /// Load a session from `path`, or start an empty one if the file doesn't exist.
    ///
    /// A **corrupt** file is a hard error, deliberately: silently starting fresh would discard
    /// a recoverable authorization key and force a re-login, which is exactly the outcome this
    /// file exists to prevent. The caller surfaces it so the user can decide.
    pub fn load(path: &Path) -> Result<Self, FileSessionError> {
        let data = match std::fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str::<PersistedSession>(&raw)
                .map_err(FileSessionError::Serde)?
                .into_data(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => SessionData::default(),
            Err(e) => return Err(FileSessionError::Io(e)),
        };

        Ok(Self {
            path: path.to_path_buf(),
            data: Mutex::new(data),
        })
    }

    fn with_data<T>(
        &self,
        f: impl FnOnce(&mut SessionData) -> T,
    ) -> Result<T, FileSessionError> {
        let mut guard = self.data.lock().map_err(|_| FileSessionError::Poisoned)?;
        let out = f(&mut guard);
        // Persist while still holding the lock so concurrent mutations can't interleave and
        // write a torn view of the state.
        self.persist(&guard)?;
        Ok(out)
    }

    /// Serialize to a temp file, then rename over the target.
    ///
    /// The rename is atomic on both Windows and POSIX, so a crash mid-write leaves either the
    /// old session or the new one — never a truncated file that would fail to parse and lock
    /// the user out on next launch.
    fn persist(&self, data: &SessionData) -> Result<(), FileSessionError> {
        let json = serde_json::to_vec_pretty(&PersistedSession::from_data(data))
            .map_err(FileSessionError::Serde)?;

        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, &json).map_err(FileSessionError::Io)?;
        std::fs::rename(&tmp, &self.path).map_err(FileSessionError::Io)?;
        Ok(())
    }
}

impl Session for FileSession {
    type Error = FileSessionError;

    fn home_dc_id(&self) -> Result<i32, Self::Error> {
        // Called on every request, so this reads without touching the disk.
        Ok(self
            .data
            .lock()
            .map_err(|_| FileSessionError::Poisoned)?
            .home_dc)
    }

    fn set_home_dc_id(&self, dc_id: i32) -> BoxFuture<'_, Result<(), Self::Error>> {
        Box::pin(async move { self.with_data(|d| d.home_dc = dc_id) })
    }

    fn dc_option(&self, dc_id: i32) -> Result<Option<DcOption>, Self::Error> {
        // Also on the per-request hot path — read-only.
        Ok(self
            .data
            .lock()
            .map_err(|_| FileSessionError::Poisoned)?
            .dc_options
            .get(&dc_id)
            .cloned())
    }

    fn set_dc_option(&self, dc_option: &DcOption) -> BoxFuture<'_, Result<(), Self::Error>> {
        let dc_option = dc_option.clone();
        Box::pin(async move {
            self.with_data(|d| {
                d.dc_options.insert(dc_option.id, dc_option.clone());
            })
        })
    }

    fn peer(&self, peer: PeerId) -> BoxFuture<'_, Result<Option<PeerInfo>, Self::Error>> {
        Box::pin(async move {
            Ok(self
                .data
                .lock()
                .map_err(|_| FileSessionError::Poisoned)?
                .peer_infos
                .get(&peer)
                .cloned())
        })
    }

    fn cache_peer(&self, peer: &PeerInfo) -> BoxFuture<'_, Result<(), Self::Error>> {
        let peer = peer.clone();
        Box::pin(async move {
            self.with_data(|d| {
                // `extend_info` merges rather than replaces, matching MemorySession: a later
                // sighting of a peer may know strictly less about it than the cached entry.
                d.peer_infos
                    .entry(peer.id())
                    .or_insert_with(|| peer.clone())
                    .extend_info(&peer);
            })
        })
    }

    fn updates_state(&self) -> BoxFuture<'_, Result<UpdatesState, Self::Error>> {
        Box::pin(async move {
            Ok(self
                .data
                .lock()
                .map_err(|_| FileSessionError::Poisoned)?
                .updates_state
                .clone())
        })
    }

    fn set_update_state(&self, update: UpdateState) -> BoxFuture<'_, Result<(), Self::Error>> {
        Box::pin(async move {
            self.with_data(|d| match update {
                UpdateState::All(state) => d.updates_state = state,
                UpdateState::Primary { pts, date, seq } => {
                    d.updates_state.pts = pts;
                    d.updates_state.date = date;
                    d.updates_state.seq = seq;
                }
                UpdateState::Secondary { qts } => d.updates_state.qts = qts,
                UpdateState::Channel { id, pts } => {
                    d.updates_state.channels.retain(|c| c.id != id);
                    d.updates_state.channels.push(ChannelState { id, pts });
                }
            })
        })
    }
}

/// Managed state key for the Telegram client + in-flight login.
pub struct TgState {
    /// The live client, once built. `None` until the first command that needs the network.
    inner: tokio::sync::Mutex<Option<TgInner>>,
    /// In-flight login state (holds the LoginToken + optional PasswordToken).
    login: tokio::sync::Mutex<Option<TgLogin>>,
}

struct TgInner {
    client: Client,
    /// The same session handed to the `SenderPool`.
    ///
    /// Kept because `Client.session` is `pub(crate)` in grammers, yet the peer cache it holds
    /// is the ONLY way to turn a bare channel id (what a `t.me/c/…` link carries) into a
    /// `PeerRef` with a real `access_hash`. See `import::resolve_peer_ref`.
    session: Arc<FileSession>,
    /// The `SenderPoolRunner` task. The client is useless once this stops, so it is kept
    /// alive here and joined on sign-out — dropping the handle alone would only *detach*
    /// the task, leaving it holding the session DB open (and unlinkable on Windows).
    runner: Option<tokio::task::JoinHandle<()>>,
}

/// In-flight login progress (spans `tg_request_code` → `tg_sign_in` → `tg_sign_in_2fa`).
///
/// Both tokens are `Option` and are cleared only on *success*: grammers hands the token
/// back on a failed attempt, and consuming it on failure would force the user to request a
/// fresh code over a single mistyped digit — straight into `FLOOD_WAIT`.
pub struct TgLogin {
    /// The login token from `request_login_code` (needed verbatim for `sign_in`).
    pub token: Option<LoginToken>,
    /// Present once the account requires 2FA (`SignInError::PasswordRequired`).
    pub password_token: Option<PasswordToken>,
}

impl Default for TgState {
    fn default() -> Self {
        Self::new()
    }
}

impl TgState {
    pub fn new() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(None),
            login: tokio::sync::Mutex::new(None),
        }
    }

    /// Absolute path of the persisted session file.
    ///
    /// `.json` rather than the `.session` of the original SQLite design — the format changed
    /// with the storage backend, and reusing the old name would let a stale SQLite file be
    /// picked up and fail to parse.
    pub fn session_path(app: &AppHandle) -> AppResult<PathBuf> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::Other(format!("app_data_dir: {e}")))?;
        Ok(data_dir.join("tg.session.json"))
    }

    /// Whether a persisted session exists on disk.
    ///
    /// The cheap "might we be logged in?" check: no network, no credentials. `tg_check_auth`
    /// uses it to decide whether bringing the client up is worth attempting at all, so a
    /// fresh install never dials Telegram just to render a gray status dot.
    pub fn has_session_file(app: &AppHandle) -> bool {
        Self::session_path(app).map(|p| p.exists()).unwrap_or(false)
    }

    /// Initialize or return the existing Telegram client.
    ///
    /// Reads `tg.api_id` / `tg.api_hash` from settings, opens the session at
    /// `app_data_dir/tg.session`, spawns the sender pool runner, and returns the Client.
    ///
    /// Idempotent: subsequent calls return the same `Client`.
    pub async fn ensure_client(&self, app: &AppHandle, db: &crate::db::Db) -> AppResult<Client> {
        let mut guard = self.inner.lock().await;

        if let Some(inner) = guard.as_ref() {
            return Ok(inner.client.clone());
        }

        let (api_id, _) = read_credentials(db)?;

        // On a fresh profile `app_data_dir` may not exist yet, and SqliteSession will not
        // create it for us.
        let session_path = Self::session_path(app)?;
        if let Some(parent) = session_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Other(format!("create app data dir: {e}")))?;
        }

        // Open the JSON-backed session (an absent file starts an empty session). A corrupt
        // file surfaces as an error rather than silently discarding an auth key.
        let session = FileSession::load(&session_path)
            .map_err(|e| AppError::Other(format!("tg session load failed: {e}")))?;
        let session = Arc::new(session);

        // Clone the Arc rather than moving it: the pool needs it, and so do we (peer-cache
        // lookups). Both point at the same session, so a peer cached by any request is
        // immediately visible to our own reads.
        let pool = SenderPool::new(session.clone(), api_id);
        let runner_handle = pool.runner;
        let handle = pool.handle;

        // Spawn the network runner in the background. Connections are opened on demand, so
        // this does not talk to Telegram until a request is actually invoked.
        let runner = tokio::spawn(async move {
            runner_handle.run().await;
        });

        let client = Client::new(handle);

        *guard = Some(TgInner {
            client: client.clone(),
            session,
            runner: Some(runner),
        });

        Ok(client)
    }

    /// Get the client if already initialized, else `None`. Never touches the network.
    pub async fn get_client(&self) -> Option<Client> {
        let guard = self.inner.lock().await;
        guard.as_ref().map(|i| i.client.clone())
    }

    /// The live session, for peer-cache lookups.
    ///
    /// grammers keeps `Client.session` private, but we built the session, so we can keep our
    /// own handle to it. This is what lets a bare channel id be resolved to a `PeerRef`
    /// carrying a real `access_hash` — `to_ambient_ref()` yields `PeerAuth(0)`, which private
    /// channels always reject.
    pub async fn get_session(&self) -> Option<Arc<FileSession>> {
        let guard = self.inner.lock().await;
        guard.as_ref().map(|i| i.session.clone())
    }

    /// Drop the current client so the next command rebuilds the pool.
    ///
    /// Called when credentials change: the `api_id` is baked into the pool at construction,
    /// so a client built with the old value would keep using it for the whole session.
    pub async fn reset_client(&self) {
        let inner = self.inner.lock().await.take();
        if let Some(inner) = inner {
            shutdown(inner).await;
        }
        *self.login.lock().await = None;
    }

    /// Store the in-flight login token (from `tg_request_code`), clearing any prior attempt.
    pub async fn set_login_token(&self, token: LoginToken) {
        *self.login.lock().await = Some(TgLogin {
            token: Some(token),
            password_token: None,
        });
    }

    /// Borrow the in-flight login for the duration of a sign-in attempt.
    ///
    /// The guard is deliberately held across the network call: it serializes concurrent
    /// attempts (a double-submit cannot consume the token twice) and lets the caller put a
    /// returned token *back* on failure.
    pub async fn login_guard(&self) -> MutexGuard<'_, Option<TgLogin>> {
        self.login.lock().await
    }

    /// Clear the in-flight login (success or abort).
    pub async fn clear_login(&self) {
        *self.login.lock().await = None;
    }

    /// Sign out: revoke the session server-side, stop the pool, and wipe the session file.
    ///
    /// Order is load-bearing: `auth.logOut` must be invoked while the client still works, and
    /// the runner must stop before the file is removed so no further session mutation can
    /// re-create it after the wipe.
    pub async fn sign_out(&self, app: &AppHandle) -> AppResult<()> {
        let inner = self.inner.lock().await.take();

        if let Some(inner) = inner {
            // Best-effort: a revoked or offline session still gets wiped locally. Failing the
            // whole sign-out because Telegram was unreachable would strand the user
            // "connected" in the UI with no way out.
            if let Err(e) = inner.client.sign_out().await {
                log::warn!("telegram: auth.logOut failed (wiping locally anyway): {e}");
            }
            shutdown(inner).await;
        }
        *self.login.lock().await = None;

        // Remove the session file, plus any leftovers from the pre-JSON SQLite backend (and
        // its -wal/-shm sidecars). A surviving -wal could otherwise replay committed session
        // state into what should be a clean slate.
        let session_path = Self::session_path(app)?;
        let legacy = session_path.with_file_name("tg.session");
        let targets = [
            session_path.clone(),
            session_path.with_extension("json.tmp"),
            legacy.clone(),
            legacy.with_file_name("tg.session-wal"),
            legacy.with_file_name("tg.session-shm"),
        ];

        for path in targets {
            if path.exists() {
                if let Err(e) = std::fs::remove_file(&path) {
                    // Losing the primary file is a real failure; the rest are advisory.
                    if path == session_path {
                        return Err(AppError::Other(format!("remove tg session: {e}")));
                    }
                    log::warn!("telegram: could not remove {}: {e}", path.display());
                }
            }
        }
        Ok(())
    }
}

/// Stop a client's sender pool and wait for its runner task to finish.
///
/// Awaiting the join handle is what guarantees the session DB is closed by the time this
/// returns; `disconnect()` alone only *asks* the runner to stop.
async fn shutdown(inner: TgInner) {
    inner.client.disconnect();
    if let Some(runner) = inner.runner {
        // Bounded so a wedged runner can never hang sign-out; file removal below reports
        // its own failure if the handle really is still open.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), runner).await;
    }
}

/// Read and validate the user-supplied MTProto credentials from the settings table.
///
/// Shared by `ensure_client` and `tg_request_code` (which needs the `api_hash` verbatim) so
/// both callers agree on what "configured" means, and the user sees one actionable message.
pub fn read_credentials(db: &crate::db::Db) -> AppResult<(i32, String)> {
    let api_id_raw = db
        .with(|conn| crate::db::queries::get_setting(conn, "tg.api_id"))?
        .unwrap_or_default();
    let api_hash = db
        .with(|conn| crate::db::queries::get_setting(conn, "tg.api_hash"))?
        .unwrap_or_default();

    if api_id_raw.trim().is_empty() || api_hash.trim().is_empty() {
        return Err(AppError::Invalid(
            "Telegram API credentials aren't set up yet. Add your api_id and api_hash first."
                .into(),
        ));
    }

    let api_id: i32 = api_id_raw.trim().parse().map_err(|_| {
        AppError::Invalid("Saved api_id is not a number — re-enter your credentials.".into())
    })?;

    Ok((api_id, api_hash.trim().to_string()))
}

impl std::fmt::Debug for TgState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TgState").finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use grammers_session::types::DcOption;

    /// A temp path that doesn't collide between tests in the same process.
    fn temp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("ple-tg-test-{name}-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn dc_with_key(id: i32, key: Option<[u8; 256]>) -> DcOption {
        let mut dc = SessionData::default()
            .dc_options
            .get(&id)
            .cloned()
            .expect("statically-known dc");
        dc.auth_key = key;
        dc
    }

    #[test]
    fn missing_file_starts_an_empty_session() {
        let path = temp_path("missing");
        let session = FileSession::load(&path).expect("load");
        // The statically-known DC options are present, so the client can connect and log in.
        assert!(session.dc_option(2).expect("dc").is_some());
    }

    #[tokio::test]
    async fn auth_key_survives_a_round_trip() {
        // This is the property the whole file exists for: lose the 256-byte auth key and the
        // user is forced through a fresh login, which is the most flood-limited thing Telegram
        // has. grammers hex-encodes it via serde_with; a plain byte array would not survive.
        let path = temp_path("authkey");
        let key = [7u8; 256];

        let session = FileSession::load(&path).expect("load");
        session.set_home_dc_id(4).await.expect("set home dc");
        session
            .set_dc_option(&dc_with_key(2, Some(key)))
            .await
            .expect("set dc option");
        drop(session);

        let reloaded = FileSession::load(&path).expect("reload");
        assert_eq!(reloaded.home_dc_id().expect("home dc"), 4);
        assert_eq!(
            reloaded.dc_option(2).expect("dc").and_then(|d| d.auth_key),
            Some(key)
        );

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn peers_and_update_state_survive_a_round_trip() {
        let path = temp_path("peers");
        let peer = PeerInfo::User {
            id: 424242,
            auth: None,
            bot: Some(false),
            is_self: Some(true),
        };

        let session = FileSession::load(&path).expect("load");
        session.cache_peer(&peer).await.expect("cache peer");
        session
            .set_update_state(UpdateState::Primary {
                pts: 11,
                date: 22,
                seq: 33,
            })
            .await
            .expect("set update state");
        drop(session);

        let reloaded = FileSession::load(&path).expect("reload");
        // `peer_infos` is persisted as an array and re-keyed on load — this asserts the key is
        // rebuilt correctly, since a JSON object keyed by the scalar PeerId would not work.
        assert_eq!(reloaded.peer(peer.id()).await.expect("peer"), Some(peer));

        let state = reloaded.updates_state().await.expect("updates state");
        assert_eq!((state.pts, state.date, state.seq), (11, 22, 33));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_silent_reset() {
        // Starting fresh here would discard a recoverable auth key and force a re-login, which
        // is precisely the failure this file is meant to prevent.
        let path = temp_path("corrupt");
        std::fs::write(&path, b"{not json").expect("write");

        assert!(matches!(
            FileSession::load(&path),
            Err(FileSessionError::Serde(_))
        ));

        let _ = std::fs::remove_file(&path);
    }
}
