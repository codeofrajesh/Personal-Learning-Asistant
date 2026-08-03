//! `t.me` link parsing — pure, no network, no client.
//!
//! Turns the URL a student pastes into the `(chat, message_id)` pair the import command needs.
//! Kept free of any grammers `Client` so every shape below is unit-testable without a live
//! session; resolving a `@username` to a real peer is the caller's job (it needs the network).
//!
//! The `-100` prefix is the trap here (telegram.md issue #7). Telegram has two id conventions:
//!   · the **bare** channel id used by MTProto (`InputPeerChannel.channel_id`), and
//!   · the **Bot API dialog id**, which prefixes channels with `-100`.
//! A `t.me/c/<id>/<msg>` link carries the **bare** id, so treating it as a Bot API id (or
//! vice-versa) silently addresses a different chat — one that usually doesn't exist, producing
//! "message not found" on a link that is perfectly valid.

use crate::utils::errors::{AppError, AppResult};

/// Which chat a link points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    /// A private channel, addressed by its **bare** id (from a `/c/<id>/` link).
    ///
    /// Only reachable if the logged-in account is already a member — these links carry no
    /// access hash, so the peer must be resolvable from the session's own cache/dialogs.
    PrivateChannel { channel_id: i64 },
    /// A public chat addressed by `@username`. Needs a network round trip to resolve.
    Username { username: String },
}

/// A parsed `t.me` message link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageLink {
    pub target: LinkTarget,
    pub message_id: i32,
}

/// Parse a `t.me` / `telegram.me` / `tg://` message link.
///
/// Accepted shapes (all tested):
///   · `https://t.me/c/1234567890/42`        — private channel, bare id
///   · `https://t.me/c/1234567890/7/42`      — forum topic: 7 is the TOPIC, 42 the message
///   · `https://t.me/somechannel/42`         — public channel by username
///   · `t.me/somechannel/42`                 — scheme optional (people paste it this way)
///   · `https://t.me/c/1234567890/42?single` — query/fragment ignored
///   · `tg://privatepost?channel=123&post=42`— the in-app "copy link" shape
pub fn parse_message_link(input: &str) -> AppResult<MessageLink> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(AppError::Invalid("Paste a Telegram message link.".into()));
    }

    // `tg://privatepost?channel=<bare>&post=<id>` — what Telegram Desktop copies for a
    // private channel. Handled first because it isn't path-shaped at all.
    if let Some(rest) = raw.strip_prefix("tg://privatepost") {
        return parse_tg_privatepost(rest);
    }

    // Strip scheme, then host. Splitting on `/` rather than using a URL crate keeps this
    // dependency-free and total — every branch below returns a real error, never a panic.
    let no_scheme = raw
        .strip_prefix("https://")
        .or_else(|| raw.strip_prefix("http://"))
        .unwrap_or(raw);
    let no_scheme = no_scheme.strip_prefix("www.").unwrap_or(no_scheme);

    let (host, path) = no_scheme
        .split_once('/')
        .ok_or_else(|| AppError::Invalid(not_a_link()))?;

    if !matches!(host, "t.me" | "telegram.me" | "telegram.dog") {
        return Err(AppError::Invalid(not_a_link()));
    }

    // Drop `?query` and `#fragment` — `?single`, `?comment=…` and `?t=` are all common on
    // copied links and none of them change which message is addressed.
    let path = path
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');

    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    match segments.as_slice() {
        // Private channel: /c/<bare_channel_id>/<message_id>
        ["c", channel, message] => Ok(MessageLink {
            target: LinkTarget::PrivateChannel {
                channel_id: parse_channel_id(channel)?,
            },
            message_id: parse_message_id(message)?,
        }),
        // Forum topic: /c/<bare_channel_id>/<topic_id>/<message_id>.
        // The LAST segment is the message; the middle one is the topic root. Reading the
        // middle segment as the message id (the intuitive-but-wrong reading) would import the
        // topic's first post instead of the lesson the student linked.
        ["c", channel, _topic, message] => Ok(MessageLink {
            target: LinkTarget::PrivateChannel {
                channel_id: parse_channel_id(channel)?,
            },
            message_id: parse_message_id(message)?,
        }),
        // Public: /<username>/<message_id>, and its forum variant /<username>/<topic>/<msg>.
        // Same rule as the private case — the LAST segment is the message.
        [username, message] | [username, _, message] => {
            let username = validate_username(username)?;
            Ok(MessageLink {
                target: LinkTarget::Username { username },
                message_id: parse_message_id(message)?,
            })
        }
        // A bare channel link with no message ("t.me/foo") is valid as a *channel* link but
        // cannot identify a lesson, so it is rejected with a message that says which is which.
        [_] => Err(AppError::Invalid(
            "That link points at a channel, not a specific message. Open the message in Telegram and copy its link.".into(),
        )),
        _ => Err(AppError::Invalid(not_a_link())),
    }
}

fn parse_tg_privatepost(rest: &str) -> AppResult<MessageLink> {
    let query = rest.trim_start_matches('?');
    let mut channel = None;
    let mut post = None;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("channel", v)) => channel = Some(v),
            Some(("post", v)) => post = Some(v),
            _ => {}
        }
    }
    let channel = channel.ok_or_else(|| AppError::Invalid(not_a_link()))?;
    let post = post.ok_or_else(|| AppError::Invalid(not_a_link()))?;
    Ok(MessageLink {
        target: LinkTarget::PrivateChannel {
            channel_id: parse_channel_id(channel)?,
        },
        message_id: parse_message_id(post)?,
    })
}

/// Parse the channel id from a `/c/` link, normalizing a `-100` prefix if one is present.
///
/// `/c/` links carry the **bare** id, but people also paste ids copied from bots or other
/// tooling in Bot API form (`-1001234567890`). Accepting both and normalizing to bare means a
/// paste that is *unambiguously* one convention can't be silently misread as the other.
fn parse_channel_id(raw: &str) -> AppResult<i64> {
    let raw = raw.trim();
    let value: i64 = raw
        .parse()
        .map_err(|_| AppError::Invalid(format!("\"{raw}\" isn't a valid channel id.")))?;

    let bare = if value < 0 {
        // Bot API form: -100 followed by the bare id.
        let positive = -value;
        let s = positive.to_string();
        match s.strip_prefix("100") {
            Some(bare_str) if !bare_str.is_empty() => bare_str
                .parse::<i64>()
                .map_err(|_| AppError::Invalid(format!("\"{raw}\" isn't a valid channel id.")))?,
            // A negative id that isn't `-100…` is a small-group (chat) id, which has no
            // `/c/` link form — rejecting it beats addressing an unrelated channel.
            _ => {
                return Err(AppError::Invalid(
                    "That looks like a group id, not a channel id. Only channels can be imported."
                        .into(),
                ))
            }
        }
    } else {
        value
    };

    if bare <= 0 {
        return Err(AppError::Invalid(format!(
            "\"{raw}\" isn't a valid channel id."
        )));
    }
    Ok(bare)
}

fn parse_message_id(raw: &str) -> AppResult<i32> {
    let id: i32 = raw
        .trim()
        .parse()
        .map_err(|_| AppError::Invalid(format!("\"{raw}\" isn't a valid message id.")))?;
    if id <= 0 {
        return Err(AppError::Invalid("Message ids start at 1.".into()));
    }
    Ok(id)
}

/// Validate a `@username` path segment.
///
/// Telegram usernames are 5-32 chars of `[A-Za-z0-9_]`. Checking the shape here means a
/// mistyped URL is reported as a bad link rather than spending a network round trip to be
/// told the peer doesn't exist. Reserved path prefixes that are never channels are rejected
/// by name, because `t.me/joinchat/<hash>/…` would otherwise parse as a username.
fn validate_username(raw: &str) -> AppResult<String> {
    let name = raw.trim().trim_start_matches('@');

    const RESERVED: [&str; 6] = ["joinchat", "addstickers", "share", "proxy", "socks", "iv"];
    if RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(AppError::Invalid(
            "That's an invite or share link, not a message link.".into(),
        ));
    }

    let valid_len = (5..=32).contains(&name.chars().count());
    let valid_chars = name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid_len || !valid_chars {
        return Err(AppError::Invalid(format!(
            "\"{name}\" isn't a valid Telegram username."
        )));
    }
    Ok(name.to_string())
}

fn not_a_link() -> String {
    "That doesn't look like a Telegram message link. Copy one from Telegram — it looks like https://t.me/c/1234567890/42.".to_string()
}

/// The synthetic `file_path` for a Telegram material.
///
/// `materials.file_path` is `NOT NULL UNIQUE` and predates streaming sources, so a Telegram row
/// still needs a value there. A `tg://` key satisfies the constraint, makes the row's origin
/// obvious in the DB, and gives the UNIQUE index something real to dedupe on. Nothing ever
/// opens it as a path — the scanner skips non-local rows and the player resolves the row
/// through the source adapter.
pub fn synthetic_path(chat_id: i64, message_id: i32) -> String {
    format!("tg://{chat_id}/{message_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private(channel_id: i64, message_id: i32) -> MessageLink {
        MessageLink {
            target: LinkTarget::PrivateChannel { channel_id },
            message_id,
        }
    }

    #[test]
    fn parses_private_channel_link() {
        assert_eq!(
            parse_message_link("https://t.me/c/1234567890/42").unwrap(),
            private(1234567890, 42)
        );
    }

    #[test]
    fn accepts_link_without_a_scheme() {
        // People paste this shape constantly; rejecting it would be a pointless dead end.
        assert_eq!(
            parse_message_link("t.me/c/1234567890/42").unwrap(),
            private(1234567890, 42)
        );
        assert_eq!(
            parse_message_link("https://www.t.me/c/1234567890/42").unwrap(),
            private(1234567890, 42)
        );
    }

    #[test]
    fn ignores_query_and_fragment() {
        for url in [
            "https://t.me/c/1234567890/42?single",
            "https://t.me/c/1234567890/42?comment=99",
            "https://t.me/c/1234567890/42#anchor",
            "https://t.me/c/1234567890/42/",
        ] {
            assert_eq!(parse_message_link(url).unwrap(), private(1234567890, 42), "{url}");
        }
    }

    #[test]
    fn forum_topic_link_uses_the_last_segment_as_the_message() {
        // `/c/<chan>/<topic>/<msg>`: reading the middle segment would import the topic's first
        // post instead of the linked lesson.
        assert_eq!(
            parse_message_link("https://t.me/c/1234567890/7/42").unwrap(),
            private(1234567890, 42)
        );
    }

    #[test]
    fn normalizes_a_bot_api_prefixed_channel_id() {
        // -100 + 1234567890. Must land on the SAME bare id as the /c/ form, or the two link
        // shapes would address different chats (telegram.md issue #7).
        assert_eq!(
            parse_message_link("https://t.me/c/-1001234567890/42").unwrap(),
            private(1234567890, 42)
        );
    }

    #[test]
    fn rejects_small_group_ids() {
        // A negative id that isn't -100-prefixed is a chat, which has no /c/ link form.
        let err = parse_message_link("https://t.me/c/-4001234/42").unwrap_err();
        assert!(err.to_string().contains("group id"), "{err}");
    }

    #[test]
    fn parses_public_username_link() {
        assert_eq!(
            parse_message_link("https://t.me/durov/42").unwrap(),
            MessageLink {
                target: LinkTarget::Username {
                    username: "durov".to_string()
                },
                message_id: 42,
            }
        );
    }

    #[test]
    fn parses_tg_privatepost_scheme() {
        assert_eq!(
            parse_message_link("tg://privatepost?channel=1234567890&post=42").unwrap(),
            private(1234567890, 42)
        );
    }

    #[test]
    fn rejects_channel_link_with_no_message() {
        let err = parse_message_link("https://t.me/somechannel").unwrap_err();
        assert!(err.to_string().contains("not a specific message"), "{err}");
    }

    #[test]
    fn rejects_invite_and_share_links() {
        // `t.me/joinchat/<hash>/1` would otherwise parse as username "joinchat".
        let err = parse_message_link("https://t.me/joinchat/AAAAAE/1").unwrap_err();
        assert!(err.to_string().contains("invite or share"), "{err}");
    }

    #[test]
    fn rejects_non_telegram_hosts() {
        for url in [
            "https://example.com/c/123/42",
            "https://evil.t.me.attacker.com/c/123/42",
        ] {
            assert!(parse_message_link(url).is_err(), "{url}");
        }
    }

    #[test]
    fn rejects_malformed_ids() {
        assert!(parse_message_link("https://t.me/c/abc/42").is_err());
        assert!(parse_message_link("https://t.me/c/123/abc").is_err());
        assert!(parse_message_link("https://t.me/c/123/0").is_err());
        assert!(parse_message_link("https://t.me/c/123/-5").is_err());
    }

    #[test]
    fn rejects_empty_input() {
        assert!(parse_message_link("   ").is_err());
    }

    #[test]
    fn rejects_too_short_usernames() {
        // Telegram's minimum is 5 characters.
        assert!(parse_message_link("https://t.me/ab/42").is_err());
    }

    #[test]
    fn synthetic_path_is_stable_and_unique_per_message() {
        assert_eq!(synthetic_path(1234567890, 42), "tg://1234567890/42");
        assert_ne!(synthetic_path(1, 2), synthetic_path(2, 1));
    }
}
