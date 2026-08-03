# Implementation Plan — Phase 1 & 2: Plugin Shell + Telegram Skeleton

**Source of truth:** `telegram.md` (Phases 1 & 2, §8).
**Scope of this plan:** Phase 1 (plugin registry + `/plugins` hub + `Settings → Plugins`) and Phase 2 (Telegram plugin page, Connect flow UI, nav status dot, route wiring). Phase 1 & 2 are **frontend-first, zero backend behavior change** — the Rust backend is designed *now* (Section A) so the frontend is built against real contracts, but implemented in Phase 3+.
**Verification:** `npm run build` + `cargo test --lib` after each phase, one atomic commit per phase.

---

## A. Rust backend architecture (designed now → implemented Phase 3+)

### A.1 Honest phase mapping

| Phase | What ships | Rust? |
|---|---|---|
| 1 | Plugin shell: registry, hub, Settings section | **None.** Pin state reuses existing `get_setting`/`set_setting`. |
| 2 | Telegram page + Connect flow UI + status dot | **None.** `api.ts` wrappers are typed stubs that degrade gracefully until the backend lands. |
| 3 | Auth core | `plugins/telegram/{mod,session,auth}.rs` + `tg_*` commands + `grammers` deps |
| 4 | Import + metadata | `plugins/telegram/link.rs`, `materials` migration |
| 5 | Streaming | `plugins/telegram/{reader,server}.rs`, axum |

### A.2 Module tree (`src-tauri/src/plugins/`)

```
src-tauri/src/plugins/
├── mod.rs               # registry: plugin list/health (future), re-exports telegram
└── telegram/
    ├── mod.rs           # pub fn init(app) -> registers tg_* commands, manages TgState
    ├── session.rs       # TgState { inner: Mutex<Option<TgSession>> } managed state;
    │                    # FileSession persisted at app_data_dir/tg.session; ClientConfiguration
    │                    # built from settings (tg.api_id / tg.api_hash), device_model/app_version
    ├── auth.rs          # login state machine (A.4); request_login_code → sign_in → check_password
    ├── link.rs          # (Phase 4) t.me URL parser, -100 channel mapping, resolve_peer
    ├── reader.rs        # (Phase 5) raw upload::GetFile via invoke_in_dc, 512KB chunks, LRU
    └── server.rs        # (Phase 5) axum 127.0.0.1, Range/206/416, per-app token
```

- `lib.rs` adds `pub mod plugins;` and `commands::tg::*` into `invoke_handler`.
- `Cargo.toml` (Phase 3) adds: `grammers-client = "0.10"`, `grammers-session = "0.10"`, `grammers-tl-types = "0.10"`, `axum = "0.8"`. Tokio 1.x already present; `thiserror` already present.

### A.3 IPC contract (the interface Phase 2 UI is designed against)

```rust
// tg_* commands — Phase 3 implements; Phase 2 api.ts types match these exactly.

#[tauri::command] async fn tg_check_auth(state: State<'_, TgState>) -> Result<TgStatus, String>;
#[tauri::command] async fn tg_request_code(state: State<'_, TgState>, phone: String) -> Result<LoginHandle, String>;
#[tauri::command] async fn tg_sign_in(state: State<'_, TgState>, handle: LoginHandle, code: String) -> Result<TgSignInResult, String>;
#[tauri::command] async fn tg_sign_in_2fa(state: State<'_, TgState>, handle: LoginHandle, password: String) -> Result<(), String>;
#[tauri::command] async fn tg_sign_out(state: State<'_, TgState>) -> Result<(), String>;
#[tauri::command] async fn tg_get_me(state: State<'_, TgState>) -> Result<TgMe, String>;
```

```ts
// src/plugins/telegram/api.ts — the exact wire types (Phase 2 defines these; Phase 3 fills bodies)
export interface TgStatus     { connected: boolean; user: TgMe | null; }
export interface TgMe         { id: number; first_name: string | null; username: string | null; phone: string | null; }
export interface LoginHandle  { phone_code_hash: string; }
export interface TgSignInResult { ok: boolean; needs_password: boolean; hint: string | null; }
```

Settings keys (via existing `settings` table, `ipc.getSetting`/`setSetting`):
- `tg.api_id`, `tg.api_hash` — user-supplied MTProto credentials (Phase 3)
- `plugins.telegram.pinned` — "true" | "false" (Phase 1 already writes this)

### A.4 Auth state machine (`auth.rs`)

```
Idle ──tg_request_code──▶ CodeRequested(phone_code_hash)
CodeRequested ──tg_sign_in(code)──▶ Connected(session saved)
CodeRequested ──PasswordRequired──▶ Awaiting2FA(password_token)
Awaiting2FA ──tg_sign_in_2fa(pw)──▶ Connected
Idle/Connected ──tg_sign_out──▶ Idle (session file wiped)
any ──Error(TgError)──▶ Idle (error surfaced to UI)
```

Error taxonomy (maps to UI states): `InvalidPhone`, `CodeExpired`, `PasswordRequired`, `FloodWait(secs)`, `SessionRevoked`, `Network`.

---

## B. Frontend design strategy

### B.1 Design read (per design-taste-frontend §0.B)

> **"Reading this as:** an in-app feature extension to an existing premium dark productivity app (PLE) for students, matching the app's established glassmorphism + neon-lime language — which is an explicit brand brief, not the LLM default — leaning toward the app's own design system: token-matched Tailwind, custom inline icons (1.75 stroke), Outfit display + Inter body, `ease-smooth` motion, perf-tier-gated animation."

Dials: **DESIGN_VARIANCE 5 · MOTION_INTENSITY 5 · VISUAL_DENSITY 4** — match the existing app, restrained motivated motion.

### B.2 Token map (real classes that exist — no new palette)

| Role | Token/class | Source |
|---|---|---|
| Surfaces | `ink-950/900/850/800/700`, `.glass`, `bg-white/[0.02–0.05]`, `border-glass-border` | `tailwind.config.js` · `index.css` |
| Primary accent | `lime` `#AAFF00`, `shadow-glow-lime`, `bg-lime/15` | brand brief §7 |
| Secondary / caution | `orange` `#FF6B35` (`text-orange`, `border-orange/30`, `bg-orange/10`) | semantic status |
| Third state / hint | `cyan-400`/`cyan-300` (StudyMeter uses this for "at the start") | StudyMeter.tsx:86 |
| Text ramp | `content-primary/secondary/muted/faint` | tailwind tokens |
| Radius lock | `rounded-btn` 8px · `rounded-card` 14px · `rounded-panel` 16px | shape lock §7 |
| Shadows | `shadow-card`, `shadow-card-hover`, `shadow-glow-lime` | tinted, not pure black |
| Type | `.font-display` (Outfit, -0.02em) for page/hero headings; Inter for everything else; `tabular-nums` for numbers | `index.css:117` |
| Motion | `ease-smooth` `cubic-bezier(0.16,1,0.3,1)`, `animate-fade-in`/`animate-fade-up` | tailwind tokens |

**Color-consistency lock (design-taste §4.2):** one accent = **lime**, always. The Telegram brand blue (`#229ED9`-family, desaturated) appears **only** as the plugin's identity mark — the paper-plane glyph chip and the sidebar icon tint — never as an interactive accent, button, or status color. All CTAs/states use `lime`/`orange`/`cyan` semantic tokens. This keeps the app visually coherent while still saying "Telegram."

### B.3 Motion rules (all gated by the app's own perf system)

- **Canonical gate:** every entrance uses `if (!motionAllowed()) return;` from `src/lib/perfStore.ts` (returns false on `lite` tier or `prefers-reduced-motion`), then `gsap.context(...)` with `ctx.revert()` cleanup — the exact pattern in `CoursesPage.tsx:234` / `TodayTab.tsx:445`.
- **Hub card entrance:** `gsap.fromTo(cards, { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, stagger: 0.05, duration: 0.45, ease: "power3.out" })`, one-shot, motivated (hierarchy).
- **Auth step transitions:** keyed re-mount using the existing `animate-fade-up` (250 ms, `ease-smooth`) — communicates "you advanced a step" (state transition).
- **Status-dot breathe:** CSS `@keyframes status-breathe { 0%,100%{opacity:1} 50%{opacity:.45} }`, 2.4 s, **only** when connected. Justified (live-status feedback), auto-zeroed by the global `lite` + reduced-motion kill-switches in `index.css`.
- **Connect success:** one-shot `shadow-glow-lime` flash on the account card (~600 ms), then removed. State feedback, not decorative.
- **Hover/tactile:** `transition-colors`/`transition-transform duration-200 ease-smooth`, `hover:scale-[1.02]`, `active:scale-[0.98]` (design-taste §4.5 tactile push; the `lite` kill-switch already neutralizes hover transforms).
- **No** decorative loops, no `window.addEventListener('scroll')`, no layout animations on static content (design-taste §5.D).

### B.4 Component mapping (skill → decision)

| Component | Skill applied | Concrete design |
|---|---|---|
| **`/plugins` hub grid** | ui-ux-pro-max (style selection, responsive grid, touch 44px, a11y) · design-taste (bento cell-count rule, one-accent lock, GSAP stagger, skeletons not spinners) | Page header: `.font-display` heading + Inter subtext (no eyebrow — count stays within 1-per-3 rule). Grid `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4`. Cards: `glass rounded-card shadow-card`, hover `shadow-card-hover -translate-y-0.5`, icon chip `rounded-btn bg-white/[0.05] border border-white/[0.06]`, name (Inter semibold) + description (`text-content-muted`), status line, **Enable** switch + **Pin** toggle (reuses `PinButton.tsx` pin-glyph pattern), **Open** link when pinned. Skeleton cards matching card shape during hydrate. |
| **Telegram connect hero (disconnected)** | design-taste (anti-center-bias, hero-stack ≤4 elements, hero fits viewport, 20-word subtext) | Left-aligned 2-col split: text column (`.font-display` `text-3xl md:text-4xl tracking-tight` headline ≤2 lines, Inter subtext `max-w-[52ch]`, one CTA) + right visual column = the Telegram glyph in a large glass tile with a soft lime radial (app motif, not an AI gradient). Status pill above headline: 7px dot (`bg-white/25`) + "Not connected". CTA matches the app's Add Folder button exactly: `rounded-btn bg-lime px-5 py-2.5 text-sm font-semibold text-ink-900 shadow-glow-lime hover:scale-[1.02] active:scale-[0.98]`. |
| **ConnectFlow (3-step)** | ui-ux-pro-max (progressive disclosure, label-above-input, error-below-field, inline validation, focus-visible, ≥44px targets, loading feedback) | Step indicator: 3 segments (Phone → Code → Password) — current = `text-lime`, done = `bg-lime/40`, upcoming = `text-content-faint`. Inputs: `rounded-btn border border-white/10 bg-white/[0.03] px-3 py-2 text-sm` (+ global lime focus ring). Errors: inline `text-orange` below the field + `border-orange/30` tint. Submit button shows inline "…"/pulsing dot while awaiting (disabled). 2FA step uses a `cyan-300` hint for the password hint line. Steps crossfade via `animate-fade-up`. No modal — inline in the page (progressive disclosure). |
| **Sidebar status dot** | Obsidian-ribbon pattern (via telegram.md §1.1) styled to app tokens · ui-ux-pro-max (a11y) | 7px `rounded-full` dot on the nav item: connected = `bg-lime shadow-glow-lime` + subtle breathe; disconnected = `bg-white/25`. Expanded layout: `ml-auto` trailing; collapsed: beside the icon. a11y: nav Link's `aria-label`/`title` include state ("Telegram, connected"). |
| **Settings → Plugins section** | ui-ux-pro-max (navigation/patterns, a11y) · design-taste (reuse not rebuild) | Exactly the `Section` (`glass rounded-card shadow-card`) + `ManageFolders` row pattern (`rounded-btn bg-white/[0.03] px-3 py-2.5` rows; ghost buttons `border border-white/10`; orange ghost for destructive) from `Settings.tsx:144-206`. Row = icon chip + name + status + Enable switch + Pin toggle. **This section is itself contributed by the registry** — the Settings page dogfoods the plugin contribution point. |
| **Status language (shared)** | ui-ux-pro-max (color not sole meaning — pair with text) | Connected/pinned/on = `lime`; disconnected/off = `white/25–30` + `text-content-muted`; error = `orange`; 2FA/info hint = `cyan`. Always paired with a text label, never color alone. |

### B.5 What we deliberately will NOT do (anti-slop guardrails)

- ❌ Introduce Telegram-blue as a UI accent, gradient, or button color (breaks one-accent lock). Blue = identity mark only.
- ❌ New fonts, new palette, AI-purple gradients, emoji as icons.
- ❌ Perpetual/decorative animations (only the connected dot breathes — and it's a live status).
- ❌ Centered marketing hero with trust strips / feature bullets (it's an app page, not a landing page).
- ❌ Fake screenshots/div-drawn product previews — the visual IS the product (a connect card + glyph tile).
- ❌ Rebuilding components that exist (`PinButton`, Settings row/Section, `.glass`).
- ❌ Hardcoding Telegram into `nav.ts`/`Sidebar.tsx`/`App.tsx` — everything flows through the registry.

---

## C. File plan

### Phase 1 — Plugin shell (frontend-only refactor; no behavior change)

New:
```
src/lib/plugins/types.ts          # PluginManifest + contribution-point types (from telegram.md §1.3)
src/lib/plugins/registry.ts       # built-in manifests (Dashboard/Courses/Planning/Settings) + external, merged
src/lib/plugins/nav.ts            # useNavItems(): core nav + pinned plugins + overflow item
src/lib/plugins/pinStore.ts       # pin/enable state persisted via get/setSetting("plugins.<id>.*")
src/lib/plugins/routes.ts         # usePluginRoutes(): lazy-route map
src/lib/plugins/settings.tsx      # PluginSettingsRegistry: contributed sections
src/lib/plugins/sourceAdapter.ts  # resolveMaterialSource() — default local resolver; telegram adapter stub (Phase 5)
src/pages/PluginsPage.tsx         # /plugins hub (grid, enable, pin, status)
```
Modified:
```
src/App.tsx                       # compose usePluginRoutes() into <Routes>; lazy /plugins
src/components/layout/nav.ts      # NAV_ITEMS becomes built-in manifests (or moves into registry.ts)
src/components/layout/Sidebar.tsx # render useNavItems(); "Plugins" overflow item near StudyMeter
src/pages/Settings.tsx            # + contributed Plugins section (rendered via PluginSettingsRegistry)
```

### Phase 2 — Telegram plugin skeleton (zero backend; proves contribution points end-to-end)

New:
```
src/plugins/telegram/manifest.ts   # PluginManifest: nav {defaultPinned:false, order:3, badge:"status-dot"},
                                   # routes [/plugins/telegram], settingsSections, capabilities ["auth","network","media"]
src/plugins/telegram/TelegramPage.tsx  # disconnected hero + connected account/channels/import shells
src/plugins/telegram/ConnectFlow.tsx   # 3-step UI with inline validation (calls api.ts stubs)
src/plugins/telegram/statusDot.tsx     # shared nav-badge dot component
src/plugins/telegram/authStore.ts      # zustand store (mirrors perfStore/timerStore): status, user, error; hydrate via tg_check_auth when available
src/plugins/telegram/api.ts            # typed tg_* wrappers matching §A.3 — throw NotInTauriError / "backend not wired" until Phase 3
src/plugins/telegram/icons.tsx         # Telegram paper-plane glyph (inline SVG, 1.75 stroke, identity-mark blue)
```
Modified:
```
src/lib/plugins/registry.ts       # register telegram manifest
src/lib/plugins/pinStore.ts       # auto-pin on first Connect (recommendation §9.2 telegram.md)
```

---

## D. Verification & commits

1. **Phase 1:** `npm run build` (tsc + vite) clean → `cargo test --lib` still 137/137 (proves no backend touch) → commit `feat(plugins): contribution-point shell + /plugins hub + Settings section`.
2. **Phase 2:** `npm run build` clean → `cargo test --lib` 137/137 → commit `feat(plugins): telegram skeleton — page, connect flow UI, nav status dot`.
3. Manual smoke: nav renders 5 items with Telegram unpinned (reachable via overflow → `/plugins`), pin toggle persists across restart, `/plugins/telegram` shows the connect hero + steps, status dot gray.

## E. Deferred to Phase 3+ (not in this PR)

- `grammers`/axum deps, `TgState`, real `tg_*` implementations (Phase 3)
- `materials` migration + scanner skip (Phase 4)
- Streaming server + source adapter wiring (Phase 5)
- CSP `connect-src` localhost (Phase 6)
