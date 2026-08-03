//! Telegram authentication commands.
//!
//! Implements the login flow: `request_code` → `sign_in` → optional `sign_in_2fa`.
//! In-flight login state (LoginToken / PasswordToken) lives in `TgState`; the persisted
//! session file in `app_data_dir/tg.session` is the source of truth for "am I connected".
//!
//! The frontend never receives a token. `tg_request_code` returns only the phone number the
//! code went to (for the UI's "we texted +1 555…" line); the tokens grammers needs verbatim
//! stay server-side, which is also why `tg_sign_in` takes no handle argument.

use grammers_client::sender::RpcError;
use grammers_client::{InvocationError, SignInError};
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::plugins::telegram::session::{read_credentials, TgState};
use crate::utils::errors::{AppError, AppResult};

/// Current auth status for the frontend.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TgAuthStatus {
    /// No usable session (or none configured yet).
    Disconnected,
    /// Session present and confirmed by Telegram.
    Connected,
    /// A session exists but Telegram couldn't be reached to confirm it.
    ///
    /// Deliberately distinct from `Disconnected`: telling an offline user they're signed out
    /// invites a pointless re-login (and a `FLOOD_WAIT`) over what is really just missing wifi.
    Unreachable,
}

/// Minimal user info for the account card.
#[derive(Debug, serde::Serialize)]
pub struct TgMe {
    pub id: i64,
    pub first_name: Option<String>,
    pub username: Option<String>,
    pub phone: Option<String>,
}

/// Returned by `tg_request_code`: confirms a code is on its way, and to which number.
#[derive(Debug, serde::Serialize)]
pub struct LoginHandle {
    /// The normalized phone the code was sent to (echoed for the UI; not a secret).
    pub phone: String,
}

/// Result of `tg_sign_in`.
#[derive(Debug, serde::Serialize)]
pub struct TgSignInResult {
    pub ok: bool,
    pub needs_password: bool,
    pub hint: Option<String>,
}

/// The user-supplied MTProto credentials, for the settings form.
#[derive(Debug, serde::Serialize)]
pub struct TgCredentials {
    pub api_id: String,
    /// Whether an `api_hash` is stored. The hash itself is never returned — it's a secret,
    /// and the form only needs to know whether to render "saved" or an empty field.
    pub has_api_hash: bool,
}

/// Read the stored credentials (never returns the hash itself).
#[tauri::command]
pub async fn tg_get_api_credentials(db: State<'_, Db>) -> AppResult<TgCredentials> {
    let api_id = db
        .with(|conn| crate::db::queries::get_setting(conn, "tg.api_id"))?
        .unwrap_or_default();
    let api_hash = db
        .with(|conn| crate::db::queries::get_setting(conn, "tg.api_hash"))?
        .unwrap_or_default();

    Ok(TgCredentials {
        api_id: api_id.trim().to_string(),
        has_api_hash: !api_hash.trim().is_empty(),
    })
}

/// Store the user's `api_id` / `api_hash` from my.telegram.org.
///
/// Validated here rather than at connect time so a typo is reported next to the field that
/// caused it, instead of surfacing minutes later as an opaque login failure.
#[tauri::command]
pub async fn tg_set_api_credentials(
    db: State<'_, Db>,
    state: State<'_, TgState>,
    api_id: String,
    api_hash: String,
) -> AppResult<()> {
    let api_id = api_id.trim();
    let api_hash = api_hash.trim();

    if api_id.is_empty() || api_hash.is_empty() {
        return Err(AppError::Invalid(
            "Both api_id and api_hash are required.".into(),
        ));
    }
    if api_id.parse::<i32>().is_err() {
        return Err(AppError::Invalid("api_id must be a number.".into()));
    }
    // api_hash is a 32-char lowercase hex string. Checking the shape catches the common
    // paste error — swapping the two fields — immediately.
    if api_hash.len() != 32 || !api_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::Invalid(
            "api_hash should be the 32-character hex string from my.telegram.org.".into(),
        ));
    }

    let (id, hash) = (api_id.to_string(), api_hash.to_string());
    db.with(move |conn| {
        crate::db::queries::set_setting(conn, "tg.api_id", &id)?;
        crate::db::queries::set_setting(conn, "tg.api_hash", &hash)
    })?;

    // The api_id is baked into the sender pool when it's built, so a running client would
    // keep using the old one. Drop it and let the next command rebuild.
    state.reset_client().await;
    Ok(())
}

/// Request a login code for the given phone number.
#[tauri::command]
pub async fn tg_request_code(
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, TgState>,
    phone: String,
) -> AppResult<LoginHandle> {
    let phone = normalize_phone(&phone)?;
    let (_, api_hash) = read_credentials(&db)?;

    let client = state.ensure_client(&app, &db).await?;

    let token = client
        .request_login_code(&phone, &api_hash)
        .await
        .map_err(map_invocation)?;

    state.set_login_token(token).await;

    Ok(LoginHandle { phone })
}

/// Complete login with the received code.
///
/// Returns `ok=true` on success, or `needs_password=true` when the account has 2FA enabled.
#[tauri::command]
pub async fn tg_sign_in(
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, TgState>,
    code: String,
) -> AppResult<TgSignInResult> {
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err(AppError::Invalid("Enter the code Telegram sent you.".into()));
    }
    let client = state.ensure_client(&app, &db).await?;

    // Held across the network call on purpose: it serializes a double-submit (the token
    // cannot be spent twice) and lets a token handed back by a failed attempt stay in place.
    let mut guard = state.login_guard().await;
    let login = guard
        .as_mut()
        .ok_or_else(|| AppError::Invalid("Request a code first.".into()))?;

    let result = {
        let token = login
            .token
            .as_ref()
            .ok_or_else(|| AppError::Invalid("Request a code first.".into()))?;
        client.sign_in(token, &code).await
    };

    match result {
        Ok(_user) => {
            // SqliteSession persists the authorization transparently on success.
            *guard = None;
            Ok(TgSignInResult {
                ok: true,
                needs_password: false,
                hint: None,
            })
        }
        Err(SignInError::PasswordRequired(password_token)) => {
            let hint = password_token.hint().map(|s| s.to_string());
            login.password_token = Some(password_token);
            Ok(TgSignInResult {
                ok: false,
                needs_password: true,
                hint,
            })
        }
        // The login token survives a wrong code deliberately: requesting a new one costs a
        // round trip and walks toward FLOOD_WAIT over what is nearly always a typo.
        Err(SignInError::InvalidCode) => Err(AppError::Invalid(
            "That code didn't match. Check the digits and try again.".into(),
        )),
        Err(SignInError::SignUpRequired) => Err(AppError::Invalid(
            "That number has no Telegram account. Create one in the official app first.".into(),
        )),
        Err(SignInError::InvalidPassword(_)) => {
            Err(AppError::Invalid("Incorrect 2FA password.".into()))
        }
        Err(SignInError::Other(e)) => Err(map_invocation(e)),
    }
}

/// Complete 2FA login with the account password.
#[tauri::command]
pub async fn tg_sign_in_2fa(
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, TgState>,
    password: String,
) -> AppResult<()> {
    if password.is_empty() {
        return Err(AppError::Invalid("Enter your 2FA password.".into()));
    }
    let client = state.ensure_client(&app, &db).await?;

    let mut guard = state.login_guard().await;
    let login = guard
        .as_mut()
        .ok_or_else(|| AppError::Invalid("Enter your login code first.".into()))?;

    let password_token = login
        .password_token
        .take()
        .ok_or_else(|| AppError::Invalid("Enter your login code first.".into()))?;

    match client.check_password(password_token, password).await {
        Ok(_user) => {
            *guard = None;
            Ok(())
        }
        // grammers returns a FRESH token on failure — the one we just sent is spent. Putting
        // the new one back is what lets the user simply retype the password.
        Err(SignInError::InvalidPassword(fresh)) => {
            login.password_token = Some(fresh);
            Err(AppError::Invalid(
                "Incorrect 2FA password. Try again.".into(),
            ))
        }
        Err(SignInError::Other(e)) => Err(map_invocation(e)),
        Err(other) => Err(AppError::Other(format!("Telegram sign-in failed: {other}"))),
    }
}

/// Sign out: revoke the session, stop the pool, wipe the session file.
#[tauri::command]
pub async fn tg_sign_out(app: AppHandle, state: State<'_, TgState>) -> AppResult<()> {
    state.sign_out(&app).await
}

/// Check whether the persisted session is authorized.
///
/// This is what makes a login survive a restart: it brings the client up from the session
/// file (when one exists) and asks Telegram. Reading only in-memory state would report
/// "disconnected" on every launch and make the user sign in daily.
#[tauri::command]
pub async fn tg_check_auth(
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, TgState>,
) -> AppResult<TgAuthStatus> {
    let client = match state.get_client().await {
        Some(client) => client,
        None => {
            // No session file → definitively signed out. Returning early keeps a fresh
            // install from dialing Telegram (or complaining about unset credentials) just to
            // render a gray status dot.
            if !TgState::has_session_file(&app) {
                return Ok(TgAuthStatus::Disconnected);
            }
            match state.ensure_client(&app, &db).await {
                Ok(client) => client,
                // A session file with missing/broken credentials can't be verified. Report
                // disconnected; the connect flow surfaces the real reason when the user acts.
                Err(e) => {
                    log::warn!("telegram: could not restore session: {e}");
                    return Ok(TgAuthStatus::Disconnected);
                }
            }
        }
    };

    match client.is_authorized().await {
        Ok(true) => Ok(TgAuthStatus::Connected),
        Ok(false) => Ok(TgAuthStatus::Disconnected),
        Err(e) => {
            log::warn!("telegram: auth check unreachable: {e}");
            Ok(TgAuthStatus::Unreachable)
        }
    }
}

/// Get current user info (requires an authorized session).
#[tauri::command]
pub async fn tg_get_me(
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, TgState>,
) -> AppResult<TgMe> {
    let client = state.ensure_client(&app, &db).await?;
    let me = client.get_me().await.map_err(map_invocation)?;

    Ok(TgMe {
        id: me.id().bare_id_unchecked(),
        first_name: me.first_name().map(|s| s.to_string()),
        username: me.username().map(|s| s.to_string()),
        phone: me.phone().map(|s| s.to_string()),
    })
}

/// Map a grammers error into a message a student can act on.
///
/// The taxonomy from the plan (`FloodWait`, `InvalidPhone`, `CodeExpired`, `SessionRevoked`,
/// `Network`) is expressed as prose rather than as an enum: the UI's only job is to show it,
/// and `AppError` already serializes to a string across the IPC boundary.
pub fn map_invocation(e: InvocationError) -> AppError {
    match e {
        InvocationError::Rpc(rpc) => map_rpc(&rpc),
        InvocationError::Io(e) => AppError::Other(format!(
            "Couldn't reach Telegram ({e}). Check your connection and try again."
        )),
        other => AppError::Other(format!("Telegram request failed: {other}")),
    }
}

/// Translate an MTProto RPC error into an actionable sentence.
///
/// Pure and split out from `map_invocation` so the mapping is unit-testable: an
/// `InvocationError` can't be constructed for every case, but an `RpcError` can.
fn map_rpc(rpc: &RpcError) -> AppError {
    // grammers strips the trailing number out of the name and into `value`, so match the
    // bare name and read the seconds from there.
    match rpc.name.as_str() {
        "FLOOD_WAIT" | "FLOOD_PREMIUM_WAIT" => {
            let secs = rpc.value.unwrap_or(0);
            AppError::Invalid(format!(
                "Telegram is rate-limiting this account. Wait {} before trying again.",
                humanize_secs(secs)
            ))
        }
        "PHONE_NUMBER_INVALID" => AppError::Invalid(
            "That phone number isn't valid. Include the country code, e.g. +1 555 000 1234."
                .into(),
        ),
        "PHONE_NUMBER_BANNED" => AppError::Invalid("That number is banned from Telegram.".into()),
        "PHONE_CODE_EXPIRED" => AppError::Invalid("That code expired. Request a new one.".into()),
        "PHONE_CODE_INVALID" => {
            AppError::Invalid("That code didn't match. Check the digits and try again.".into())
        }
        "SESSION_PASSWORD_NEEDED" => {
            AppError::Invalid("This account needs its 2FA password.".into())
        }
        "AUTH_RESTART" => AppError::Invalid(
            "Telegram restarted the login process. Please click 'Start over' and request a new code.".into(),
        ),
        "AUTH_KEY_UNREGISTERED" | "AUTH_KEY_DUPLICATED" | "SESSION_REVOKED" | "USER_DEPRECATED" => {
            AppError::Invalid(
                "This session was signed out from another device. Disconnect and connect again."
                    .into(),
            )
        }
        "API_ID_INVALID" | "API_ID_PUBLISHED_FLOOD" => AppError::Invalid(
            "Telegram rejected these API credentials. Re-check your api_id and api_hash.".into(),
        ),
        _ => AppError::Other(format!(
            "Telegram error {}: {}",
            rpc.code,
            rpc.name.to_lowercase().replace('_', " ")
        )),
    }
}

/// Render a wait in the largest sensible unit ("2 minutes", not "120 seconds").
fn humanize_secs(secs: u32) -> String {
    match secs {
        0 => "a moment".to_string(),
        s if s < 60 => format!("{s} seconds"),
        s if s < 3600 => {
            let m = s / 60;
            format!("{m} minute{}", if m == 1 { "" } else { "s" })
        }
        s => {
            let h = s / 3600;
            format!("{h} hour{}", if h == 1 { "" } else { "s" })
        }
    }
}

/// Normalize a phone number for `tg_request_code`.
///
/// Punctuation people naturally type — parentheses, spaces, dots — is stripped rather than
/// rejected: Telegram wants digits with an optional leading `+`, and refusing a pasted
/// "+1 (555) 000-1234" would be a dead end for no reason.
fn normalize_phone(phone: &str) -> AppResult<String> {
    let cleaned: String = phone
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();

    // A leading `+` is fine; one anywhere else means the input was malformed.
    let digits = cleaned.strip_prefix('+').unwrap_or(&cleaned);
    if digits.contains('+') {
        return Err(AppError::Invalid("That phone number isn't valid.".into()));
    }
    // E.164: 15 digits max, and no real number with a country code is under 7.
    if digits.len() < 7 || digits.len() > 15 {
        return Err(AppError::Invalid(
            "Enter your phone number with its country code, e.g. +1 555 000 1234.".into(),
        ));
    }
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc(code: i32, name: &str, value: Option<u32>) -> RpcError {
        RpcError {
            code,
            name: name.to_string(),
            value,
            caused_by: None,
        }
    }

    #[test]
    fn strips_punctuation_from_phone() {
        assert_eq!(
            normalize_phone(" +1 (555) 000-1234 ").unwrap(),
            "+15550001234"
        );
        assert_eq!(normalize_phone("+91 98765 43210").unwrap(), "+919876543210");
    }

    #[test]
    fn keeps_numbers_without_a_plus_prefix() {
        assert_eq!(normalize_phone("15550001234").unwrap(), "15550001234");
    }

    #[test]
    fn rejects_empty_and_too_short_phones() {
        assert!(matches!(normalize_phone("   "), Err(AppError::Invalid(_))));
        assert!(matches!(
            normalize_phone("+1 555"),
            Err(AppError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_phone_with_an_interior_plus() {
        assert!(matches!(
            normalize_phone("+1555+0001234"),
            Err(AppError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_absurdly_long_phone() {
        assert!(matches!(
            normalize_phone("+1234567890123456"),
            Err(AppError::Invalid(_))
        ));
    }

    #[test]
    fn flood_wait_reports_the_actual_wait() {
        // The whole point of surfacing `value`: "wait 2 minutes" is actionable where a bare
        // FLOOD_WAIT is not.
        let msg = map_rpc(&rpc(420, "FLOOD_WAIT", Some(120))).to_string();
        assert!(msg.contains("2 minutes"), "msg was: {msg}");

        let msg = map_rpc(&rpc(420, "FLOOD_WAIT", Some(31))).to_string();
        assert!(msg.contains("31 seconds"), "msg was: {msg}");
    }

    #[test]
    fn flood_wait_without_a_value_still_reads_sensibly() {
        let msg = map_rpc(&rpc(420, "FLOOD_WAIT", None)).to_string();
        assert!(msg.contains("a moment"), "msg was: {msg}");
    }

    #[test]
    fn humanizes_singular_units() {
        assert_eq!(humanize_secs(60), "1 minute");
        assert_eq!(humanize_secs(3600), "1 hour");
        assert_eq!(humanize_secs(7200), "2 hours");
    }

    #[test]
    fn maps_known_rpc_names_to_actionable_text() {
        assert!(map_rpc(&rpc(400, "PHONE_NUMBER_INVALID", None))
            .to_string()
            .contains("country code"));
        assert!(map_rpc(&rpc(400, "PHONE_CODE_EXPIRED", None))
            .to_string()
            .contains("expired"));
        assert!(map_rpc(&rpc(400, "API_ID_INVALID", None))
            .to_string()
            .contains("api_id"));
        assert!(map_rpc(&rpc(401, "AUTH_KEY_UNREGISTERED", None))
            .to_string()
            .contains("another device"));
    }

    #[test]
    fn unknown_rpc_errors_are_readable_not_screaming() {
        let msg = map_rpc(&rpc(500, "INTERDC_CALL_ERROR", None)).to_string();
        assert!(msg.contains("interdc call error"), "msg was: {msg}");
        assert!(msg.contains("500"), "msg was: {msg}");
    }

    #[test]
    fn maps_io_errors_to_a_connectivity_message() {
        let err = map_invocation(InvocationError::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "connect timed out",
        )));
        assert!(err.to_string().contains("Couldn't reach Telegram"));
    }
}
