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
