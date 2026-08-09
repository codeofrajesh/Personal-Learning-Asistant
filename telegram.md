# Telegram Plugin — Architecture & Implementation Plan

**Status:** Research-complete, pre-implementation. Verdict: **implementable and proven in the wild.**

This plan turns the Telegram idea into a **first-class plugin** in PLE: a plugin page with a Connect button, a **pin-to-navigation-bar** option, a pluggable architecture inspired by VSCode contribution points / Tauri v2 plugins / Obsidian ribbons, and the direct-streaming engine from the original proposal (validated against Telegram's official API docs, `grammers`, and the production `stremio-telegram-debrid` project).

---

## 0. Executive summary

| Question | Answer |
|---|---|
| Can we stream Telegram media without a VPS? | **Yes.** `upload.getFile(offset, limit)` is a purpose-built partial-download API. A local HTTP server + Range handling + MTProto fetch is exactly how the production `stremio-telegram-debrid` proxy works. |
| Should it be a "plugin"? | **Yes.** Hard-coding Telegram into `Sidebar.tsx` / `App.tsx` / `Settings.tsx` would make it one-off. A small contribution-points registry lets Telegram — and future integrations — register their own page, nav item, settings sections, and media-source adapter. |
| Does the player need changes? | **No.** The player stays source-agnostic. A **Material Source Adapter** translates `materials.source` → a playable URL (`asset://` for local, `http://127.0.0.1:<port>/tg/…` for Telegram). Watch-time, Study Meter, notes, bookmarks all work unchanged. |
| Ban risk? | **Low, not zero.** Read-only MTProto from a home IP, user-supplied `api_id`/`api_hash`, flood-safe client. Telegram's stated ban triggers are behavioral (spam, DC IPs, ignored `FLOOD_WAIT`). A custom client is still fingerprintable; document the residual risk in-app. |

---

## 1. Plugin architecture (the core innovation)

### 1.1 Design principles (from research)

- **VSCode contribution points**: extensions declare what they add in a manifest (`contributes: { views, commands, configuration, authentication, menus }`). The shell never hard-codes extension surfaces. *(source: `code.visualstudio.com/api/references/contribution-points`)*
- **Tauri v2 plugins**: a plugin is a Cargo crate + guest-js API package; commands are namespaced (`plugin:<name>|command`) and gated by ACL permissions; plugins manage their own state via `app.manage`. *(source: `v2.tauri.app/develop/plugins`)*
- **Obsidian ribbon**: a plugin can add an icon to the app chrome and a settings tab — i.e., "surface + status badge + settings" as plugin responsibilities.
- **This app already has the seams**: `NAV_ITEMS` (`src/components/layout/nav.ts`) is a manifest; routes are centralized in `App.tsx`; Settings uses a `Section` pattern; `ipc.ts` centralizes typed invoke; `planRevision.ts` shows the pub/sub store pattern; `isTauri()` guards browser-mode.

### 1.2 The registry: `src/lib/plugins/`

```
src/lib/plugins/
├── types.ts       # PluginManifest + contribution-point types
├── registry.ts    # built-in manifests + external manifests, merged in order
├── nav.ts         # useNavItems(): core nav + pinned plugin nav (feeds Sidebar)
├── pinStore.ts    # persisted pin/enable state (settings table, keys `plugins.<id>.*`)
├── routes.ts      # usePluginRoutes(): lazy-route map fed to <Routes>
├── settings.tsx   # PluginSettingsRegistry: contributed sections in Settings
└── sourceAdapter.ts  # resolveMaterialSource(material) -> { url, kind, mime, size }
```

### 1.3 The manifest type

```ts
// src/lib/plugins/types.ts
export interface PluginManifest {
  id: string;                 // "telegram"  (must match Rust command prefix `tg_*`)
  name: string;               // "Telegram"
  version: string;
  description: string;
  icon: ElementType;          // lucide / inline SVG (matches existing NavItem.icon)
  /** contribution points */
  nav?: {
    defaultPinned: boolean;   // false => reachable via Plugins hub until user pins
    order: number;            // sort position among nav items
    badge?: "status-dot";     // plugin may render a live status dot (connected/offline)
  };
  routes: { path: string; lazy: () => Promise<{ default: ComponentType }> }[];
  settingsSections?: SettingsSectionContribution[]; // rendered in Settings
  sourceAdapters?: SourceAdapterDescriptor[];       // e.g. { source: "telegram" }
  commands?: string[];        // the `tg_*` IPC command names this plugin owns
  capabilities: ("auth" | "network" | "media" | "storage")[];
}
```

### 1.4 Built-ins are plugins too

The four existing top-level items (`Dashboard`, `Courses`, `Planning`, `Settings`) move into the registry as built-in manifests. `Sidebar.tsx` stops importing the static `NAV_ITEMS` array and instead calls `useNavItems()`, which composes:

```
[core, order]  Dashboard  (pinned forever, order 0)
[core, order]  Courses    (order 1)
[core, order]  Planning   (order 2)
[plugin]       Telegram   (order 3, pinned = pinStore)
[core, order]  Settings   (always last)
```

Unpinned plugins are reachable through a **"Plugins" overflow item** pinned at the bottom of the nav (near the Study Meter) that opens `/plugins`. This keeps the nav clean by default while making pinning a one-click preference.

### 1.5 Pin-to-nav model

- **State**: stored in the existing `settings` table via `ipc.setSetting("plugins.telegram.pinned", "true")` — no new table, matches the app's `set_setting`/`get_setting` pattern.
- **UI surfaces**:
  - `/plugins` hub: a card grid of installed plugins, each with **Enable** and **Pin to nav bar** toggles + status.
  - `Settings → Plugins` (contributed section): same toggles, so plugin management lives where users expect it.
  - `Sidebar`: pinned plugins render as normal nav items; Telegram's item shows a **status dot** (green = connected, gray = disconnected) via the `badge: "status-dot"` contribution, fed by a tiny subscription to the auth store.
- **Persistence rule**: pin state survives restarts (DB), and `defaultPinned: false` means a fresh install keeps the nav unchanged.

### 1.6 Route mounting

`App.tsx` keeps `HashRouter`, but the route list is composed by the registry so plugin pages stay **code-split via `React.lazy`** (the app's existing Section 15 perf rule). A plugin page chunk is only fetched when its route is first visited.

---

## 2. Routes

| Route | Owner | Purpose |
|---|---|---|
| `/plugins` | Plugin hub (core) | Installed-plugin grid: enable, pin-to-nav, status, per-plugin Settings link |
| `/plugins/telegram` | Telegram plugin | The plugin page — Connect button, account card, Channels list, Import link, recently-streamed |
| `/settings` (+ contributed `Plugins` section) | Core + Telegram | Manage plugins; Telegram's `api_id`/`api_hash`/`phone` config lives in its contributed settings section |
| `/library/material/:id` (unchanged) | Core player | Opens any material; when `source="telegram"`, the source adapter supplies the stream URL |

---

## 3. Telegram plugin — module layout

### 3.1 Frontend `src/plugins/telegram/`

```
src/plugins/telegram/
├── manifest.ts        # PluginManifest (routes, nav contribution, settings sections, adapter)
├── TelegramPage.tsx   # /plugins/telegram — Connect button + channel/library views
├── ConnectFlow.tsx    # 3-step: phone → code → 2FA (or "Connected as @user" + Disconnect)
├── ChannelsView.tsx   # browse a channel's recent media (get_messages_by_id / search)
├── LinkImport.tsx     # paste t.me/c/<id>/<msg> → tg_import_link → adds material to library
├── authStore.ts       # Zustand-style store (mirrors perfStore/timerStore): status, user, error
├── api.ts             # typed tg_* wrappers (re-exported into ipc.ts or plugin-local)
└── statusDot.ts       # the nav badge subscription (authStore → connected dot)
```

### 3.2 Backend `src-tauri/src/plugins/`

```
src-tauri/src/plugins/
├── mod.rs             # registry: list plugins, report state
└── telegram/
    ├── mod.rs
    ├── session.rs     # Client in managed state (Mutex<Option<Client>>), FileSession at app_data_dir/tg.session
    ├── auth.rs        # login state machine: code / 2FA / errors (request_login_code → sign_in → check_password)
    ├── link.rs        # parse t.me URLs → InputPeer + msg id; -100 channel mapping; resolve_peer
    ├── reader.rs      # TgStreamReader: raw upload::GetFile via invoke_in_dc, 512KB chunks, LRU cache, prefetch
    └── server.rs      # axum on 127.0.0.1:ephemeral; Range/HEAD/206/416; per-app token in path
```

### 3.3 IPC commands (namespaced `tg_*`, registered in `lib.rs`)

| Command | Purpose |
|---|---|
| `tg_get_api_credentials` / `tg_set_api_credentials` | user-supplied `api_id` / `api_hash` (settings table) |
| `tg_check_auth` | session present + `is_authorized()` |
| `tg_request_code(phone)` | start login (returns `LoginToken`) |
| `tg_sign_in(code)` | complete login; returns `needs_password` / `hint` if 2FA |
| `tg_sign_in_2fa(password)` | finish 2FA |
| `tg_sign_out` | disconnect + wipe session |
| `tg_get_me` | display name / phone for the account card |
| `tg_import_link(url)` | parse + resolve + `get_messages_by_id` → return media metadata |
| `tg_channel_media(chatId, limit)` | list recent messages in a channel (for the Channels view) |
| `tg_stream_base` | ensure axum running → return `http://127.0.0.1:<port>/tg/<token>/` |
| `tg_metadata(chatId, msgId)` | refresh file size / mime / duration (for expired-reference recovery) |

### 3.4 The Connect button flow

1. Telegram page (or its contributed Settings section) shows a prominent **Connect** button in the empty state; the nav status dot reads `authStore.status`.
2. Click → `tg_request_code(phone)` → inline code input → `tg_sign_in(code)`.
3. If `SignInError::PasswordRequired` → password step → `tg_sign_in_2fa`.
4. On success: `tg_check_auth()` true → the page flips to "Connected as @name · Disconnect". The nav dot goes green.
5. Session persisted in `app_data_dir/tg.session`; on app boot the plugin calls `tg_check_auth()` once and hydrates `authStore`.

---

## 4. Media source adapter (keeps the player untouched)

The core decoupling innovation. Replace the hard assumption "material ⇒ local file" with a resolution step:

```ts
// src/lib/plugins/sourceAdapter.ts
export interface ResolvedSource {
  url: string;            // asset://...  OR  http://127.0.0.1:<port>/tg/<token>/<chat>/<msg>
  kind: "local" | "http";
  mime?: string;
  size?: number;
}

export async function resolveMaterialSource(m: MaterialRow): Promise<ResolvedSource> {
  const adapter = registry.sourceAdapters().find(a => a.source === m.source);
  if (!adapter) return { url: convertFileSrc(m.file_path), kind: "local" };  // default local
  return adapter.resolve(m);  // telegram adapter -> ensure server up, build URL
}
```

- `open_material` (Rust) already returns `file_path`; the plugin's adapter path replaces it with the stream URL for `source="telegram"` rows.
- `MpvVideoPlayer(path)` and `VideoPlayer(src)` accept the URL verbatim — mpv natively plays HTTP, and the CSP already allows `media-src http://localhost:*`.
- Watch-time / Study Meter / notes / bookmarks key on `time-pos` + material id, never on the URL — **zero player changes**.

### DB migration (matches the app's guarded-ALTER migration style)

```sql
ALTER TABLE materials ADD COLUMN source TEXT DEFAULT 'local';
ALTER TABLE materials ADD COLUMN tg_chat_id INTEGER;
ALTER TABLE materials ADD COLUMN tg_message_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_materials_source ON materials(source);
```

- Filesystem scanner (`scanner/walker.rs` + `queries::upsert_material`) must skip `source='telegram'` rows (its upsert keys on `file_path`).
- `open_material` branches on `source` before returning the player URL.

---

## 5. Streaming engine (validated against the official API)

Condensed from the original proposal + research corrections:

1. axum server binds **127.0.0.1 only**, ephemeral port, random per-app token in the path (`/tg/<token>/<chat>/<msg>`).
2. Parse `Range: bytes=a-b` → clamp to `[0, size)` → map to 512 KB-aligned `upload::GetFile { precise:false, location, offset, limit: 512KB }` calls (offsets are 4 KB-aligned by construction).
3. `iter_download` is **NOT** used in the hot path — grammers' `DownloadIter::next()` **panics** on `upload.fileCdnRedirect` (confirmed in `grammers-client/src/client/files.rs`). We invoke `upload::GetFile` raw via `client.invoke_in_dc(dc, &request)` (the same pattern grammers' own concurrent downloader uses), with our own retry/DC handling.
4. Serve `206 Partial Content` + `Content-Range` + `Accept-Ranges: bytes` + correct `Content-Type`; `HEAD` → headers only; out-of-range → `416`.
5. Global concurrency semaphore (default 4) across all streams; per-stream LRU chunk cache (≤ 32 MB).
6. On `FILE_REFERENCE_EXPIRED/INVALID` → `get_messages_by_id` → rebuild `InputFileLocation` → retry once (stremio treats this as a headline feature — pause overnight then resume).
7. `FILE_MIGRATE_X` (303) → switch DC (grammers handles this in `invoke_in_dc`); `FLOOD_WAIT_X` → backoff + surface "Telegram is throttling" in the UI.

### Streaming vs. safety table

| Telegram limit | How we comply |
|---|---|
| `upload.getFile` offset/limit 4 KB-aligned, ≤ 1 MB, within one 1 MB window | 512 KB chunks at chunk-aligned offsets |
| Parallel download cap (`small/large_queue_max_active_operations_count`, default ≈ 4–8) | global semaphore = 4 |
| `FILE_REFERENCE_*` rotation | auto-refetch message + rebuild location |
| `FLOOD_WAIT_X` / `FLOOD_PREMIUM_WAIT_X` | backoff + honest UI |
| 2 GB bot / 4 GB user limit | **user sessions only** (bots are a trap: stricter throttling, no `noForward` media) |

---

## 6. Innovations (what this plan adds beyond the original idea)

1. **Contribution-points plugin registry** — Telegram isn't a hardcoded page; it's a manifest entry. Dashboard/Courses/Planning/Settings become "built-in plugins." Future integrations (YouTube, a podcast source, a PDF repo) register the same way.
2. **Pin-to-nav as a first-class, persisted preference** — `defaultPinned: false`, one-click pin in `/plugins` and Settings, overflow item for unpinned plugins. Nav stays clean by default.
3. **Material Source Adapter** — storage/transport is a pluggable capability. The player, watch-time, Study Meter, and notes are 100% source-agnostic. This is the single biggest de-risking decision.
4. **Live status in the chrome** — the nav badge (`status-dot`) pattern (Obsidian-ribbon-style) shows connect state without opening the page.
5. **Capability-gated commands** — the `tg_*` commands are declared with capabilities (`auth`, `network`, `media`) and Tauri ACL permissions, so enabling Telegram is an explicit, revocable grant. Single-process "sandbox-lite."
6. **Plugin-local auth store + lazy chunks** — `authStore` hydrates on boot (one `tg_check_auth` call); the page chunk loads only on first visit (preserves the app's code-splitting perf rule).
7. **Namespaced IPC + manifest↔command prefix contract** — `plugin id "telegram"` ↔ `tg_*` commands; a registry validation step fails fast if a manifest references undeclared commands.

---

## 7. Issue register (what will bite)

| # | Issue | Severity | Mitigation |
|---|---|---|---|
| 1 | grammers `DownloadIter` panics on `upload.fileCdnRedirect` | High | Raw `invoke_in_dc(upload::GetFile)` in `reader.rs`, not `iter_download` |
| 2 | File-reference expiry mid-session (pause → resume) | High | Catch `FILE_REFERENCE_EXPIRED/INVALID` → refetch message → retry once |
| 3 | Alignment/limit math (`precise:false`, 4 KB, ≤1 MB) | High | 512 KB chunk-aligned reads; unit-tested range→chunk mapping |
| 4 | Bot sessions are a trap (2 GB cap, throttling, no noForward) | Medium | User sessions only |
| 5 | `FLOOD_WAIT_X` / `FLOOD_PREMIUM_WAIT_X` on heavy downloading | Medium | Global cap = 4, backoff, honest UI |
| 6 | `AUTH_KEY_DUPLICATED` if user runs Telegram Desktop on the same auth key | Low–Med | One main session; media-DC file sessions are exempt per API docs |
| 7 | `-100` megagroup / migrated-group message-ID mapping | Medium | Parser table + `resolve_peer`; broadcast channels first |
| 8 | CSP `connect-src` doesn't list localhost (only `media-src` does) | Low | Add `http://127.0.0.1:*` to `connect-src` if the plugin uses `fetch()`; mpv/`<video>` need only `media-src` |
| 9 | `materials.file_path NOT NULL UNIQUE` fights tg rows | Medium | `source`/`tg_*` columns; scanner skips tg rows; `open_material` branches |
| 10 | 4 GB / split-part files (`.001`, `.002`) | Medium | Out of scope v1; stremio proves stitching is feasible but experimental |
| 11 | grammers maintenance risk (GitHub archived → Codeberg, small community) | Low–Med | 0.10.0 is current (Jul 2026); isolate behind `src/plugins/telegram/session.rs` |
| 12 | Local-server security (another local process could fetch your media) | Med | Bind 127.0.0.1, random per-app token, Origin check, ACL-gated commands |
| 13 | Ban risk (low but non-zero) | Low | User-supplied `api_id`/`api_hash`, home IP, read-only, flood-safe; document in-app |

---

## 8. Phased implementation plan

Each phase ends with `npm run build` + `cargo test --lib` and an atomic commit.

| Phase | Deliverable | Notes |
|---|---|---|
| **1. Plugin shell** | `src/lib/plugins/` (types, registry, pinStore, nav composition); `Sidebar` reads `useNavItems()`; built-ins migrated to manifests; `/plugins` hub; `Settings → Plugins` | No behavior change if every built-in manifest is present — pure refactor, low risk |
| **2. Telegram plugin skeleton** | `src/plugins/telegram/manifest.ts` + `TelegramPage` (empty state), nav contribution with status dot (offline), route wiring | Proves the contribution points end-to-end with zero backend |
| **3. Auth core** | deps (`grammers-client`, `grammers-session`, `axum`); `session.rs`/`auth.rs`; `tg_*` auth commands; ConnectFlow UI; session persistence | Rust tests: login state machine, session save/load, error mapping |
| **4. Import + metadata** | `link.rs`, `tg_import_link`, `tg_channel_media`; `materials` migration; scanner skip; ChannelsView + LinkImport | Rust tests: URL→peer/msg parser, `-100` mapping, migration on existing DB |
| **5. Streaming engine** | `reader.rs` (raw GetFile + LRU + prefetch) + `server.rs` (axum, Range/206/416); `tg_stream_base`; source adapter | Rust tests: range→chunk math, EOF, 416, alignment invariants |
| **6. Player wiring** | `open_material` branches to tg URL; mpv/HTML5 playback from private channel; CSP `connect-src` | Manual E2E: play + seek in both players |
| **7. Hardening** | file-reference refresh, flood backoff, ACL permissions, token auth, status dot live state | Rust tests: error-mapping suite; E2E: pause 2 h, resume |
| **8. Polish** | channel browse UX, subtitles, 4 GB / split parts, telemetry of throttling | Stretch |

---

## 9. Open decisions before coding

1. **User sessions only** — confirm (recommended; matches stremio's hard-won lesson and the original doc's home-IP premise).
2. **Pin default** — `defaultPinned: false` (nav unchanged on install) vs. auto-pin after first successful Connect (better discoverability). Recommend: **auto-pin on first Connect** — it's the natural moment, and the hub still lets users unpin.
3. **Registry scope** — v1 = in-repo plugins only (manifest + contribution points, no third-party installs). A plugin marketplace/dir-scan loader is explicitly out of scope.
4. **`/plugins` hub vs. Settings-only** — recommend both (hub for discovery, Settings section for management), but Settings-only is a legitimate v1 cut.
5. **grammers isolation** — commit now to the single-file isolation boundary so a future swap (tdlib-rs, or a Pyrogram sidecar) is a contained change.

---

## 10. Bulk / Range Import — Research & Verified Implementation Plan

**Date:** 2026-08-09
**Status:** Research-complete. Verified against codebase + MTProto spec + grammers 0.10 source.

### 10.1 Problem statement

Currently a user can import Telegram media in two ways:
1. **Single link** — paste one `t.me/c/…/42` link → `tg_import_link` → one material row.
2. **Browse channel** — paste a channel link → `tg_channel_media` lists recent media → select + batch import via `tg_import_batch`.

**The gap:** Browse requires the user to have either a `@username`, an invite link, or a `/c/<id>` link to the *channel itself*. For a private channel where the user only has individual post links, they must paste links one at a time. Importing 80 videos means 80 paste-and-click cycles.

**The solution:** Accept a **start link** and either an **end link** or a **count**, and automatically sweep the range.

### 10.2 Telegram link structure reference (verified 2026)

All link structures below were verified against the existing link parser in `src-tauri/src/plugins/telegram/link.rs` (549 lines, 38 unit tests).

#### 10.2.1 Complete link anatomy

| Entity type | Link format | Example | Parser coverage |
|---|---|---|---|
| **Public channel** — message | `t.me/<username>/<msg_id>` | `t.me/durov/42` | ✅ line 119 |
| **Public channel** — topic message | `t.me/<username>/<topic_id>/<msg_id>` | `t.me/pythonforum/7/42` | ✅ line 119 (last segment = msg) |
| **Private channel** — message | `t.me/c/<bare_id>/<msg_id>` | `t.me/c/1234567890/42` | ✅ line 101 |
| **Private channel** — topic message | `t.me/c/<bare_id>/<topic_id>/<msg_id>` | `t.me/c/1234567890/7/42` | ✅ line 111 |
| **Private channel** — Desktop copy | `tg://privatepost?channel=<bare_id>&post=<msg_id>` | `tg://privatepost?channel=123&post=42` | ✅ line 59 |
| **Invite link** (modern) | `t.me/+<hash>` | `t.me/+0fNyqiUncH5mNjE9` | ✅ (channel-only; rejected as message link with guidance) |
| **Invite link** (legacy) | `t.me/joinchat/<hash>` | `t.me/joinchat/AAAAAEjq0Ns` | ✅ same |
| **Channel-only** (no msg) | `t.me/<username>` or `t.me/c/<id>` | `t.me/somechannel` | ✅ `parse_channel_link` line 272 |

#### 10.2.2 Critical codebase finding: topic_id is discarded

**Current behavior** (line 111):
```rust
[\"c\", channel, _topic, message] => Ok(MessageLink {
    target: LinkTarget::PrivateChannel { channel_id: parse_channel_id(channel)? },
    message_id: parse_message_id(message)?,
})
```

The `_topic` segment is **intentionally ignored** because `parse_message_link` only needs to identify *one* message. For single imports this is correct — `get_messages_by_id` addresses messages by their global ID within the chat, regardless of topic.

**For range import this creates a problem:** If the user provides `t.me/c/123/7/42` (topic 7, message 42) and asks for the next 80 media items, we must know that topic_id=7 so we can filter the stream to only that topic's messages. Without it, we'd import from every topic in the group.

**Fix required:** Add `topic_id: Option<i32>` to `MessageLink`.

#### 10.2.3 Message ID behavior (verified against MTProto)

| Property | Channels | Groups (non-forum) | Groups with Topics (Forums) |
|---|---|---|---|
| **ID scope** | Per-channel, monotonically increasing | Per-supergroup, monotonically increasing | **Same supergroup-wide counter** — all topics share the same ID space |
| **Consecutive IDs** | Generally sequential for media posts; gaps from deleted messages, service messages, or text-only posts | Same | IDs interleave across topics |
| **Albums** | Each media item in an album gets its own message ID (consecutive). The `grouped_id` field ties them together | Same | Same |

**Key implication for range import in forums:** Asking for messages 42–122 in a forum supergroup returns messages from *all* topics mixed together. The range must be post-filtered by topic.

#### 10.2.4 The -100 prefix trap (existing, well-handled)

The parser already handles the Bot API vs. MTProto ID convention mismatch (line 156–194). A `/c/` link carries the **bare** channel ID. The Bot API prefixes it with `-100`. The parser normalizes both to bare — this is correct and must be preserved.

### 10.3 API approach: what grammers 0.10 actually supports

#### 10.3.1 `client.iter_messages(peer)` — for flat channels

**Verified in grammers-client 0.10.0** (`src/client/messages.rs`):
- Returns `MessageIter` wrapping `messages.GetHistory`.
- Supports `.offset_id(id)` — exclusive starting point.
- Supports `.reverse(true)` — oldest-to-newest iteration.
- When `reverse(true)` + `offset_id(X)`: sets `min_id = X`, iterates forward from X.
- **Does NOT support topic/thread filtering.** `GetHistory` has no `topic_id` parameter. It returns all messages in the chat.

**This is the right tool for channels and non-forum groups.**

#### 10.3.2 `messages.GetReplies` — for forum topics

**Verified in grammers-tl-types generated code:**
```rust
pub struct GetReplies {
    pub peer: crate::enums::InputPeer,
    pub msg_id: i32,        // ← the topic_id (root message of the topic)
    pub offset_id: i32,
    pub offset_date: i32,
    pub add_offset: i32,
    pub limit: i32,
    pub max_id: i32,
    pub min_id: i32,
    pub hash: i64,
}
```

This is a **raw TL function** — grammers has no high-level wrapper for it. Must be invoked via `client.invoke(&tl::functions::messages::GetReplies { ... })`.

Returns `messages.Messages` (same as `GetHistory`), so pagination follows the same pattern. **This is the correct and only way to iterate messages within a specific forum topic.**

**Critical: grammers' `iter_messages` will NOT work for topics.** The Gemini plan's suggestion to use `iter_messages().offset_id(start_id - 1).reverse(true)` and then filter by `reply_to_top_id` is **technically functional but dangerously inefficient**: in a forum with 50 active topics, to find 80 media items in one topic you might scan 4000+ messages. `GetReplies` is both correct and efficient — Telegram's server does the filtering.

#### 10.3.3 `client.get_messages_by_id(peer, &[ids])` — for known ID ranges

**Verified** (line 574 of `import.rs`): Already used in `tg_import_batch`. Takes a slice of message IDs, chunks them in groups of 100, returns `Vec<Option<Message>>`.

**For range import with start/end IDs:** This is the simplest approach — generate the vector `[start_id..=end_id]`, chunk by 100, fetch, filter for media. **No iteration needed. No topic filtering needed** (messages are fetched by exact ID, so they're guaranteed to be the right messages regardless of topic).

**Caveat:** If the range is large (e.g., 500 IDs), many might be non-media (text posts, deleted messages). The `Option<Message>` filtering handles deleted messages, and `media_item()` filters non-media. But the user may need to specify a wider range than expected if many messages in between are text-only.

### 10.4 Verified implementation approach

Based on the analysis above, **two distinct strategies** are needed depending on user input:

#### Strategy A: Start link + End link (known boundaries)

1. Parse both links. They must point at the **same channel/group** (same `channel_id` or `username`).
2. Generate ID range: `[start_id..=end_id]`.
3. Use existing `get_messages_by_id` in chunks of 100 (reuse the pattern from `tg_import_batch` at line 574).
4. Filter with `media_item()` (already exists at line 238).
5. Upsert via existing `upsert_material()` in a single transaction.

**Advantages:** Simple, exact, works for channels + groups + forums (no topic confusion — exact IDs are exact IDs). No iteration overhead.

**Edge case:** If `start_id > end_id`, swap them. If the gap is enormous (>2000 IDs), warn the user or cap.

#### Strategy B: Start link + Count (open-ended)

This is where it gets interesting. The behavior depends on whether the start link targets a **topic** or not:

**B1: Non-topic (flat channel/group)**
- Use `client.iter_messages(peer).offset_id(start_id - 1).reverse(true)`.
- Iterate forward, collect media items until `count` is reached or the scan cap (5000 messages) is hit.
- Works perfectly because `GetHistory` returns all messages in order.

**B2: Topic (forum group)**
- Detect from the parsed link that `topic_id` is present.
- Use raw `client.invoke(&tl::functions::messages::GetReplies { peer, msg_id: topic_id, offset_id: start_id - 1, ... })` with pagination.
- `GetReplies` returns only messages within that specific topic — no cross-topic pollution.
- Iterate forward, collect media items until `count` is reached.

### 10.5 Corrections to the Gemini implementation plan

| # | Gemini's claim | Verdict | Correct approach |
|---|---|---|---|
| 1 | Use `iter_messages().offset_id(start_id - 1).reverse(true)` for all cases | ❌ **Wrong for topics.** `iter_messages` wraps `GetHistory` which has no topic filter. | Use `GetReplies` (raw TL invoke) for topics; `iter_messages` only for flat channels. |
| 2 | "Filter by extracting `MessageReplyHeader` from `msg.raw` and checking `reply_to_top_id`" | ⚠️ **Technically works but wastes bandwidth.** Downloads all messages in the supergroup just to discard most of them. | Use `GetReplies` which filters server-side. Zero wasted bandwidth. |
| 3 | "Hard cap of 5000 messages scanned" | ✅ Reasonable for Strategy B1 (flat channels). Unnecessary for B2 (`GetReplies` already scoped). | Keep the cap for flat-channel iteration; for topics it's naturally bounded. |
| 4 | "Add `topic_id: Option<i32>` to `MessageLink`" | ✅ **Correct and necessary.** The parser currently discards the topic segment. | Modify `MessageLink` struct and the match arms in `parse_message_link`. |
| 5 | "Register `tg_import_range` in lib.rs" | ✅ Standard procedure. | Add to the invoke handler alongside existing `tg_import_batch`. |
| 6 | Frontend: toggle in "Link" tab + segmented control for end-link vs. count | ✅ Good UX approach. | Implement as described. |

### 10.6 Known edge cases and exceptions

| # | Edge case | How to handle |
|---|---|---|
| 1 | **Deleted messages in range** — `get_messages_by_id` returns `None` for deleted messages | Already handled: `messages.into_iter().flatten()` skips `None` values (line 580 of import.rs). |
| 2 | **Albums / media groups** — multiple messages with the same `grouped_id` | Each media item in an album has its own `message_id`. They are naturally included in any ID range. No special handling needed. |
| 3 | **Service messages** (user joined, topic created, pinned message) | `media_item()` returns `None` for messages without `Media::Document`. They are silently skipped. |
| 4 | **Start and end links point to different channels** | Validate: both must resolve to the same `channel_id` or `username`. Return a clear error if they don't match. |
| 5 | **FLOOD_WAIT on large ranges** | `get_messages_by_id` in chunks of 100 is well within Telegram's limits. For `iter_messages`/`GetReplies`, the existing flood-wait handling in grammers applies. Add a sensible delay between chunks (200ms). |
| 6 | **Private channel where the user is not a member** | Already handled by `resolve_peer_ref` (line 408 of import.rs) — surfaces "Make sure this Telegram account is a member" error. |
| 7 | **Topic ID = 1 (General topic)** | In forums, the "General" topic has `topic_id = 1`. `GetReplies` with `msg_id = 1` correctly returns messages in the General topic. |
| 8 | **Messages that exist but have no media** | The count refers to *media items found*, not *messages scanned*. The user asks for 80 videos and gets 80 videos, even if 120 messages were scanned to find them. |
| 9 | **Large gap between start and end (>2000 IDs)** | For Strategy A, cap at 2000 IDs per request to avoid Telegram rate limits. Warn the user if the range is too wide. For Strategy B, the 5000-scan cap handles this naturally. |
| 10 | **Public channel topics** — `t.me/<username>/<topic>/<msg>` | Parser already handles this (line 119). The `topic_id` extraction must also cover this public path segment shape. |

### 10.7 Files to modify (verified against codebase)

#### Backend (Rust)

| File | Change | Lines affected |
|---|---|---|
| `src-tauri/src/plugins/telegram/link.rs` | Add `topic_id: Option<i32>` to `MessageLink`; capture topic segment instead of discarding it with `_topic` | Struct at L36–40, match arms at L111 and L119 |
| `src-tauri/src/plugins/telegram/import.rs` | New command `tg_import_range` implementing Strategy A + B; reuse `resolve_target`, `resolve_peer_ref`, `media_item`, `upsert_material` | New function (~120 lines); import `tl::functions::messages::GetReplies` |
| `src-tauri/src/lib.rs` | Register `tg_import_range` in the invoke handler | 1 line addition |

#### Frontend (TypeScript/React)

| File | Change |
|---|---|
| `src/plugins/telegram/api.ts` | Add `importRange(startUrl, endUrl, count, nodeId)` wrapper |
| `src/plugins/telegram/LinkImport.tsx` | Add "Import range" mode to the existing tab switcher; inputs for start link, end link / count, destination |

### 10.8 What the existing `tg_import_batch` already does right

The existing batch import command (line 526–624 of `import.rs`) is a solid foundation:
- Chunks message IDs by 100 ✅
- Single SQLite transaction for atomicity ✅
- Returns per-item results with `material_id`, `file_name`, `created` ✅
- Proper error handling for unreachable peers ✅

The new `tg_import_range` should **delegate to the same chunking + upsert logic** rather than duplicating it. The only new responsibility is generating the ID list (Strategy A) or iterating for media items (Strategy B).

