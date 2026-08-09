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
    /// A private invite link (`t.me/+hash` or `t.me/joinchat/hash`).
    ///
    /// The hash is NOT a chat id: it must be exchanged for the real peer via
    /// `messages.checkChatInvite`. This is the only handle a student has for a private
    /// channel that has no username — including one they own — so it is a first-class target
    /// rather than an error case.
    Invite { hash: String },
}

/// A parsed `t.me` message link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageLink {
    pub target: LinkTarget,
    pub message_id: i32,
    /// The forum topic this message lives in, when the link says so.
    ///
    /// Irrelevant for a single import — `get_messages_by_id` addresses a message by its id
    /// alone, whatever topic it sits in. It matters for **range import**: a forum's message ids
    /// interleave across every topic, so sweeping a range without this would pull in other
    /// topics' posts. `None` means "not a forum link", not "the General topic" (which is `1`).
    pub topic_id: Option<i32>,
}

/// Parse a `t.me` / `telegram.me` / `tg://` message link.
///
/// Accepted shapes (all tested):
///   · `https://t.me/c/1234567890/42`        — private channel, bare id
///   · `https://t.me/c/1234567890/7/42`      — forum topic: 7 is the TOPIC, 42 the message
///   · `https://t.me/somechannel/42`         — public channel by username
///   · `t.me/somechannel/42`                 — scheme optional (people paste it this way)
///   · `https://t.me/c/1234567890/42?single` — query ignored except `thread`
///   · `https://t.me/c/1234567890/42?thread=7` — forum topic in the query instead of the path
///   · `tg://privatepost?channel=123&post=42`— the in-app "copy link" shape
///   · `tg://resolve?domain=durov&post=42`   — the in-app shape for a PUBLIC channel
pub fn parse_message_link(input: &str) -> AppResult<MessageLink> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(AppError::Invalid("Paste a Telegram message link.".into()));
    }

    // `tg://` shapes are handled first because they aren't path-shaped at all — everything
    // they carry lives in the query string.
    if let Some(rest) = raw.strip_prefix("tg://privatepost") {
        return parse_tg_privatepost(rest);
    }
    if let Some(rest) = raw.strip_prefix("tg://resolve") {
        return parse_tg_resolve(rest);
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

    // Split the path from `?query` / `#fragment`. The query is NOT simply discarded: Telegram
    // documents `?thread=<id>` as the query-string spelling of a forum topic, so it has to be
    // read before the path segments are matched. Everything else in there (`single`,
    // `comment=`, `t=`) genuinely doesn't change which message is addressed.
    let (path, query) = split_query(path);
    let thread_from_query = query_param(query, "thread")
        .map(parse_topic_id)
        .transpose()?;

    let path = path.trim_end_matches('/');

    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    // Invite links carry an opaque hash, never a message id, so they can only ever identify a
    // *channel*. Detected before the generic shapes below because `+AAAA/1` would otherwise
    // parse as an (invalid) username with a message id.
    if invite_hash(&segments).is_some() {
        return Err(AppError::Invalid(
            "That's an invite link, which points at a whole channel rather than one lesson. Paste it into \"Browse channel\" to list the channel's media, or open the lesson in Telegram and copy its message link (t.me/c/…)."
                .into(),
        ));
    }

    match segments.as_slice() {
        // Private channel: /c/<bare_channel_id>/<message_id>
        ["c", channel, message] => Ok(MessageLink {
            target: LinkTarget::PrivateChannel {
                channel_id: parse_channel_id(channel)?,
            },
            message_id: parse_message_id(message)?,
            topic_id: thread_from_query,
        }),
        // Forum topic: /c/<bare_channel_id>/<topic_id>/<message_id>.
        // The LAST segment is the message; the middle one is the topic root. Reading the
        // middle segment as the message id (the intuitive-but-wrong reading) would import the
        // topic's first post instead of the lesson the student linked. The topic is KEPT —
        // range import needs it to avoid sweeping every other topic in the forum.
        ["c", channel, topic, message] => Ok(MessageLink {
            target: LinkTarget::PrivateChannel {
                channel_id: parse_channel_id(channel)?,
            },
            message_id: parse_message_id(message)?,
            // An explicit `?thread=` wins over the path segment: the two agree in every link
            // Telegram itself generates, and if they ever disagree the query is the more
            // specific statement.
            topic_id: thread_from_query.or(Some(parse_topic_id(topic)?)),
        }),
        // Public: /<username>/<message_id>, and its forum variant /<username>/<topic>/<msg>.
        // Same rule as the private case — the LAST segment is the message.
        [username, message] => {
            let username = validate_username(username)?;
            Ok(MessageLink {
                target: LinkTarget::Username { username },
                message_id: parse_message_id(message)?,
                topic_id: thread_from_query,
            })
        }
        [username, topic, message] => {
            let username = validate_username(username)?;
            Ok(MessageLink {
                target: LinkTarget::Username { username },
                message_id: parse_message_id(message)?,
                topic_id: thread_from_query.or(Some(parse_topic_id(topic)?)),
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

/// Split a path from its query string, dropping any `#fragment`.
///
/// Returns `(path, query)` where `query` is `""` when there isn't one. The fragment is cut from
/// both halves — `#anchor` is a client-side scroll target and never carries link data.
fn split_query(path: &str) -> (&str, &str) {
    let no_fragment = path.split('#').next().unwrap_or("");
    match no_fragment.split_once('?') {
        Some((p, q)) => (p, q),
        None => (no_fragment, ""),
    }
}

/// Look up one `key=value` pair in a query string.
///
/// Tolerates the valueless flags Telegram sprinkles on copied links (`?single`,
/// `?single&thread=7`) — a bare `single` simply doesn't match any key. Comparison is
/// case-sensitive because Telegram's own parameter names are all lowercase.
fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v)
}

/// `tg://privatepost?channel=<bare>&post=<id>[&thread=<topic>]` — what Telegram Desktop copies
/// for a message in a **private** channel.
fn parse_tg_privatepost(rest: &str) -> AppResult<MessageLink> {
    let query = rest.trim_start_matches('?');
    let channel = query_param(query, "channel").ok_or_else(|| AppError::Invalid(not_a_link()))?;
    let post = query_param(query, "post").ok_or_else(|| AppError::Invalid(not_a_link()))?;
    Ok(MessageLink {
        target: LinkTarget::PrivateChannel {
            channel_id: parse_channel_id(channel)?,
        },
        message_id: parse_message_id(post)?,
        topic_id: tg_thread(query)?,
    })
}

/// `tg://resolve?domain=<username>&post=<id>[&thread=<topic>]` — the same in-app shape for a
/// **public** channel.
///
/// Telegram Desktop hands this out for public channels exactly as it hands out
/// `tg://privatepost` for private ones, so failing to recognize it rejected a link the user
/// copied straight from the official client.
fn parse_tg_resolve(rest: &str) -> AppResult<MessageLink> {
    let query = rest.trim_start_matches('?');
    let domain = query_param(query, "domain").ok_or_else(|| AppError::Invalid(not_a_link()))?;
    let username = validate_username(domain)?;

    // A `tg://resolve` with no `post` names a channel, not a message — the same situation as a
    // bare `t.me/<username>`, and it gets the same guidance.
    let post = query_param(query, "post").ok_or_else(|| {
        AppError::Invalid(
            "That link points at a channel, not a specific message. Open the message in Telegram and copy its link."
                .into(),
        )
    })?;

    Ok(MessageLink {
        target: LinkTarget::Username { username },
        message_id: parse_message_id(post)?,
        topic_id: tg_thread(query)?,
    })
}

/// The `thread=<topic>` parameter shared by both `tg://` shapes.
fn tg_thread(query: &str) -> AppResult<Option<i32>> {
    query_param(query, "thread").map(parse_topic_id).transpose()
}

/// Parse a forum topic id.
///
/// A topic id is the id of the topic's root message, so it obeys the same rule as any message
/// id: ids start at 1, and `1` specifically is the forum's "General" topic.
fn parse_topic_id(raw: &str) -> AppResult<i32> {
    let id: i32 = raw
        .trim()
        .parse()
        .map_err(|_| AppError::Invalid(format!("\"{raw}\" isn't a valid topic id.")))?;
    if id <= 0 {
        return Err(AppError::Invalid("Topic ids start at 1.".into()));
    }
    Ok(id)
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

/// Extract an invite hash from the path segments, if this is an invite link.
///
/// Two equivalent shapes exist and both are still issued in the wild:
///   · `t.me/+<hash>`          — the modern form
///   · `t.me/joinchat/<hash>`  — the legacy form
///
/// The hash is opaque (base64url-ish), so it is only length- and charset-checked; the real
/// validation is `messages.checkChatInvite` rejecting it.
fn invite_hash(segments: &[&str]) -> Option<String> {
    let raw = match segments {
        // `t.me/joinchat/<hash>` — legacy form.
        [first, second] if first.eq_ignore_ascii_case("joinchat") => *second,
        // `t.me/+<hash>`, with or without a trailing segment. An invite link can't address a
        // message, so anything after the hash is ignored rather than treated as a message id.
        [first] | [first, _] => first.strip_prefix('+')?,
        _ => return None,
    };

    let hash = raw.trim();
    let ok = (8..=64).contains(&hash.len())
        && hash
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then(|| hash.to_string())
}

/// Validate a `@username` path segment.
///
/// Telegram usernames are 5-32 chars of `[A-Za-z0-9_]`. Checking the shape here means a
/// mistyped URL is reported as a bad link rather than spending a network round trip to be
/// told the peer doesn't exist. Reserved path prefixes that are never channels are rejected
/// by name, because `t.me/share/<...>` would otherwise parse as a username.
fn validate_username(raw: &str) -> AppResult<String> {
    let name = raw.trim().trim_start_matches('@');

    // `joinchat` is deliberately NOT here — it's handled as a real invite target upstream.
    const RESERVED: [&str; 5] = ["addstickers", "share", "proxy", "socks", "iv"];
    if RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(AppError::Invalid(
            "That's a share link, not a message link.".into(),
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

/// Parse a link that identifies a CHANNEL (rather than one message).
///
/// Used by the browse view, which needs a channel and doesn't care about message ids. Accepts
/// everything `parse_message_link` does (taking just the channel half), plus the two shapes
/// that can only ever mean a channel: an invite link and a bare `@username`.
///
/// Invite links matter specifically because a private channel with no username — including
/// one the user owns — has no other pasteable handle.
pub fn parse_channel_link(input: &str) -> AppResult<LinkTarget> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(AppError::Invalid(
            "Paste a channel link, invite link, or @username.".into(),
        ));
    }

    // A bare @username never parses as a URL, so handle it before anything else.
    if let Some(name) = raw.strip_prefix('@') {
        return Ok(LinkTarget::Username {
            username: validate_username(name)?,
        });
    }

    // Invite link, in either shape.
    let no_scheme = raw
        .strip_prefix("https://")
        .or_else(|| raw.strip_prefix("http://"))
        .unwrap_or(raw);
    let no_scheme = no_scheme.strip_prefix("www.").unwrap_or(no_scheme);
    if let Some((host, path)) = no_scheme.split_once('/') {
        if matches!(host, "t.me" | "telegram.me" | "telegram.dog") {
            let (path, _) = split_query(path);
            let path = path.trim_end_matches('/');
            let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            if let Some(hash) = invite_hash(&segments) {
                return Ok(LinkTarget::Invite { hash });
            }
        }
    }

    // `tg://resolve?domain=<username>` with no `post` names a whole channel, which is exactly
    // what this function is for (the message parser rejects it for lacking a message id).
    if let Some(rest) = raw.strip_prefix("tg://resolve") {
        if let Some(domain) = query_param(rest.trim_start_matches('?'), "domain") {
            return Ok(LinkTarget::Username {
                username: validate_username(domain)?,
            });
        }
    }

    // A full message link — reuse the real parser so every shape it understands (forum
    // topics, query strings, -100 ids) works here too; only the channel half is kept.
    if let Ok(link) = parse_message_link(raw) {
        return Ok(link.target);
    }

    // Channel-only links (`t.me/c/<id>`, `t.me/<username>`): append a dummy message id so the
    // same parser can validate the channel half, then discard it. The query string is dropped
    // first — appending after it (`t.me/foo?x=1/1`) would put the dummy id inside the query,
    // where the parser can't see it.
    let (bare, _) = split_query(raw);
    if let Ok(link) = parse_message_link(&format!("{}/1", bare.trim_end_matches('/'))) {
        return Ok(link.target);
    }

    Err(AppError::Invalid(
        "That doesn't look like a Telegram channel link, invite link, or @username.".into(),
    ))
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
            topic_id: None,
        }
    }

    /// The same, in a forum topic.
    fn private_topic(channel_id: i64, message_id: i32, topic_id: i32) -> MessageLink {
        MessageLink {
            target: LinkTarget::PrivateChannel { channel_id },
            message_id,
            topic_id: Some(topic_id),
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
        // post instead of the linked lesson. The topic is kept, not discarded — range import
        // needs it to stay inside one topic.
        assert_eq!(
            parse_message_link("https://t.me/c/1234567890/7/42").unwrap(),
            private_topic(1234567890, 42, 7)
        );
    }

    #[test]
    fn captures_the_topic_from_the_thread_query_parameter() {
        // Telegram documents `?thread=<id>` as the query spelling of a forum topic. It used to
        // be stripped along with `?single`, which silently turned a topic link into a
        // whole-channel one for range import.
        assert_eq!(
            parse_message_link("https://t.me/c/1234567890/42?thread=7").unwrap(),
            private_topic(1234567890, 42, 7)
        );
        // Combined with the valueless flags Telegram also emits.
        assert_eq!(
            parse_message_link("https://t.me/c/1234567890/42?single&thread=7").unwrap(),
            private_topic(1234567890, 42, 7)
        );
        // Public form.
        assert_eq!(
            parse_message_link("https://t.me/durov/42?thread=7").unwrap(),
            MessageLink {
                target: LinkTarget::Username {
                    username: "durov".into()
                },
                message_id: 42,
                topic_id: Some(7),
            }
        );
    }

    #[test]
    fn public_forum_topic_link_keeps_both_the_topic_and_the_message() {
        // `t.me/<username>/<topic>/<msg>` — the public twin of the `/c/` forum shape.
        assert_eq!(
            parse_message_link("https://t.me/mychannel/7/42").unwrap(),
            MessageLink {
                target: LinkTarget::Username {
                    username: "mychannel".into()
                },
                message_id: 42,
                topic_id: Some(7),
            }
        );
    }

    #[test]
    fn the_general_topic_is_a_real_topic_not_an_absent_one() {
        // Forums put "General" at topic id 1. `Some(1)` and `None` mean different things to
        // range import: the first scopes to General, the second sweeps the whole chat.
        assert_eq!(
            parse_message_link("https://t.me/c/1234567890/1/42").unwrap(),
            private_topic(1234567890, 42, 1)
        );
        assert_eq!(
            parse_message_link("https://t.me/c/1234567890/42").unwrap().topic_id,
            None
        );
    }

    #[test]
    fn rejects_malformed_topic_ids() {
        assert!(parse_message_link("https://t.me/c/123/abc/42").is_err());
        assert!(parse_message_link("https://t.me/c/123/0/42").is_err());
        assert!(parse_message_link("https://t.me/c/123/42?thread=0").is_err());
        assert!(parse_message_link("https://t.me/c/123/42?thread=abc").is_err());
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
                topic_id: None,
            }
        );
    }

    #[test]
    fn parses_tg_privatepost_scheme() {
        assert_eq!(
            parse_message_link("tg://privatepost?channel=1234567890&post=42").unwrap(),
            private(1234567890, 42)
        );
        // With a topic.
        assert_eq!(
            parse_message_link("tg://privatepost?channel=1234567890&post=42&thread=7").unwrap(),
            private_topic(1234567890, 42, 7)
        );
    }

    #[test]
    fn parses_tg_resolve_scheme() {
        // What Telegram Desktop copies for a message in a PUBLIC channel. Previously rejected
        // outright, so a link straight from the official client looked invalid.
        assert_eq!(
            parse_message_link("tg://resolve?domain=durov&post=42").unwrap(),
            MessageLink {
                target: LinkTarget::Username {
                    username: "durov".into()
                },
                message_id: 42,
                topic_id: None,
            }
        );
        assert_eq!(
            parse_message_link("tg://resolve?domain=mychannel&post=42&thread=7").unwrap(),
            MessageLink {
                target: LinkTarget::Username {
                    username: "mychannel".into()
                },
                message_id: 42,
                topic_id: Some(7),
            }
        );
        // Parameter order is not guaranteed.
        assert_eq!(
            parse_message_link("tg://resolve?post=42&domain=durov").unwrap().message_id,
            42
        );
    }

    #[test]
    fn tg_resolve_without_a_post_is_a_channel_not_a_message() {
        let err = parse_message_link("tg://resolve?domain=durov")
            .unwrap_err()
            .to_string();
        assert!(err.contains("not a specific message"), "{err}");
        // …and it IS a valid channel reference.
        assert_eq!(
            parse_channel_link("tg://resolve?domain=durov").unwrap(),
            LinkTarget::Username {
                username: "durov".into()
            }
        );
    }

    #[test]
    fn rejects_channel_link_with_no_message() {
        let err = parse_message_link("https://t.me/somechannel").unwrap_err();
        assert!(err.to_string().contains("not a specific message"), "{err}");
    }

    #[test]
    fn rejects_share_links() {
        // `t.me/share/...` would otherwise parse as username "share".
        let err = parse_message_link("https://t.me/share/url").unwrap_err();
        assert!(err.to_string().contains("share link"), "{err}");
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
    fn rejects_invite_links_as_message_links_with_a_useful_message() {
        // An invite link identifies a channel, not a lesson. The error has to say where to
        // paste it instead, or the user is stuck with the only handle a username-less private
        // channel has.
        for url in [
            "https://t.me/+0fNyqiUncH5mNjE9",
            "https://t.me/joinchat/AAAAAEjq0Ns4nqPZ7A",
        ] {
            let err = parse_message_link(url).unwrap_err().to_string();
            assert!(err.contains("invite link"), "{url}: {err}");
            assert!(err.contains("Browse channel"), "{url}: {err}");
        }
    }

    #[test]
    fn parses_invite_links_as_channel_links() {
        // The real fix for a private channel with no username: the invite hash IS the handle.
        assert_eq!(
            parse_channel_link("https://t.me/+0fNyqiUncH5mNjE9").unwrap(),
            LinkTarget::Invite {
                hash: "0fNyqiUncH5mNjE9".into()
            }
        );
        // Legacy shape.
        assert_eq!(
            parse_channel_link("https://t.me/joinchat/AAAAAEjq0Ns4nqPZ7A").unwrap(),
            LinkTarget::Invite {
                hash: "AAAAAEjq0Ns4nqPZ7A".into()
            }
        );
        // Scheme-less, and with a query string.
        assert_eq!(
            parse_channel_link("t.me/+0fNyqiUncH5mNjE9?foo=1").unwrap(),
            LinkTarget::Invite {
                hash: "0fNyqiUncH5mNjE9".into()
            }
        );
    }

    #[test]
    fn parse_channel_link_still_handles_every_other_shape() {
        assert_eq!(
            parse_channel_link("@somechannel").unwrap(),
            LinkTarget::Username {
                username: "somechannel".into()
            }
        );
        assert_eq!(
            parse_channel_link("https://t.me/c/1234567890/42").unwrap(),
            LinkTarget::PrivateChannel {
                channel_id: 1234567890
            }
        );
        assert_eq!(
            parse_channel_link("https://t.me/c/1234567890").unwrap(),
            LinkTarget::PrivateChannel {
                channel_id: 1234567890
            }
        );
        assert!(parse_channel_link("   ").is_err());
        assert!(parse_channel_link("https://example.com/foo").is_err());
    }

    #[test]
    fn invite_hash_rejects_things_that_are_not_hashes() {
        // Too short, and a plain username must NOT be read as an invite.
        assert!(invite_hash(&["+short"]).is_none());
        assert!(invite_hash(&["durov"]).is_none());
        assert!(invite_hash(&["c", "1234567890", "42"]).is_none());
        // A `+` prefix with an invalid charset.
        assert!(invite_hash(&["+has/slash!chars"]).is_none());
    }

    #[test]
    fn synthetic_path_is_stable_and_unique_per_message() {
        assert_eq!(synthetic_path(1234567890, 42), "tg://1234567890/42");
        assert_ne!(synthetic_path(1, 2), synthetic_path(2, 1));
    }
}
