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

use std::path::PathBuf;
use std::sync::Arc;

use grammers_client::client::{LoginToken, PasswordToken};
use grammers_client::{Client, SenderPool};
use grammers_session::storages::SqliteSession;
use tauri::{AppHandle, Manager};
use tokio::sync::MutexGuard;

use crate::utils::errors::{AppError, AppResult};

/// Managed state key for the Telegram client + in-flight login.
pub struct TgState {
    /// The live client, once built. `None` until the first command that needs the network.
    inner: tokio::sync::Mutex<Option<TgInner>>,
    /// In-flight login state (holds the LoginToken + optional PasswordToken).
    login: tokio::sync::Mutex<Option<TgLogin>>,
}

struct TgInner {
    client: Client,
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
    pub fn session_path(app: &AppHandle) -> AppResult<PathBuf> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::Other(format!("app_data_dir: {e}")))?;
        Ok(data_dir.join("tg.session"))
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

        // Open SQLite session storage (creates tables on first run). Persistence is
        // transparent: grammers writes through to this DB on every session mutation.
        let session = SqliteSession::open(&session_path)
            .await
            .map_err(|e| AppError::Other(format!("tg.session open failed: {e}")))?;
        let session = Arc::new(session);

        let pool = SenderPool::new(session, api_id);
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
            runner: Some(runner),
        });

        Ok(client)
    }

    /// Get the client if already initialized, else `None`. Never touches the network.
    pub async fn get_client(&self) -> Option<Client> {
        let guard = self.inner.lock().await;
        guard.as_ref().map(|i| i.client.clone())
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
    /// Order is load-bearing. `auth.logOut` must be invoked while the client still works, and
    /// the runner must stop *before* the file is removed — it holds the session SQLite DB
    /// open, and Windows refuses to unlink an open file.
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

        // Remove the session DB and its sidecars. A surviving -wal can carry committed
        // session state that would be replayed into a supposedly fresh session file.
        let session_path = Self::session_path(app)?;
        for suffix in ["", "-wal", "-shm"] {
            let path = if suffix.is_empty() {
                session_path.clone()
            } else {
                PathBuf::from(format!("{}{suffix}", session_path.display()))
            };
            if path.exists() {
                if let Err(e) = std::fs::remove_file(&path) {
                    // Losing the primary file is a real failure; sidecars are advisory.
                    if suffix.is_empty() {
                        return Err(AppError::Other(format!("remove tg.session: {e}")));
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
