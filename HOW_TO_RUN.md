# PLE — Beginner's Guide: Run & Test It on Your PC

This guide walks you through running the app on your own Windows PC, step by step.
No prior experience needed — just follow along in order.

> **What you're running:** PLE is a desktop app (like Spotify or VS Code). It has two
> halves that run together: a **Rust backend** (the engine) and a **React frontend**
> (the screen you see). The `tauri dev` command starts both for you.

---

## Part 0 — One-time check: do you have the tools?

Open a terminal. The easiest way:

1. Press the **Windows key**, type `cmd`, press **Enter**. A black window opens.
   *(Or use "Git Bash" if you have it — either works.)*

Now copy-paste each line below, one at a time, pressing **Enter** after each.
You're just checking that each tool answers with a version number.

```bash
node --version
```
✅ Expect something like `v20.x.x`. ❌ If it says "not recognized", install Node.js
from https://nodejs.org (pick the "LTS" button), then reopen the terminal.

```bash
npm --version
```
✅ Expect something like `10.x.x`. (It comes with Node.js.)

```bash
cargo --version
```
✅ Expect something like `cargo 1.8x.x`. ❌ If not recognized, Rust isn't on your
PATH. Try this exact line instead (it points directly at where Rust is installed):

```bash
"C:\Users\PC\.cargo\bin\cargo.exe" --version
```

If **that** works, Rust is installed but not on your PATH. That's fine — see the
note in Part 2 about adding it temporarily.

---

## Part 1 — Open the project folder in the terminal

Copy-paste this line and press Enter:

```bash
cd "c:\Users\PC\OneDrive\Documents\coding project\EDU app"
```

The start of your terminal line should now show that folder. You're "inside" the
project now. **Every command below is run from here** unless it says otherwise.

---

## Part 2 — Install the frontend dependencies (one time)

This downloads the JavaScript libraries the app needs. Run:

```bash
npm install
```

⏳ Takes 1–3 minutes the first time. When it finishes you'll get your prompt back.
It's normal to see a few yellow "warning" lines — those are safe to ignore.

> **PATH note for Rust:** If `cargo --version` failed in Part 0 but the full-path
> version worked, run this line once in your terminal before the next step. It tells
> *this terminal window* where Rust lives (you'll redo it each time you open a new
> terminal):
>
> ```bash
> set PATH=%PATH%;C:\Users\PC\.cargo\bin
> ```
> *(If you're in Git Bash instead of cmd, use:*
> `export PATH="$PATH:C:\Users\PC\.cargo\bin"` *)*

---

## Part 3 — Run the app! (development mode)

This is the main command. It starts the backend AND opens the app window:

```bash
npm run tauri dev
```

**What to expect:**

- ⏳ **The FIRST run is slow — 3 to 8 minutes.** Rust is compiling the whole engine
  from scratch. You'll see lots of `Compiling ...` lines scroll by. **This is normal
  — do not close the window.** Future runs take only a few seconds.
- ✅ When it's ready, a **desktop window titled "PLE — Personal Learning
  Environment"** pops open on its own. Dark theme, a sidebar on the left.

Leave the terminal open — it's running the app. Closing the terminal closes the app.

---

## Part 4 — Test that everything works ✅

Do these quick checks in the app window that opened:

1. **The shell renders.**
   You should see a dark sidebar on the left with **Dashboard**, **Library**,
   **Settings**, a **Search** box, and the "PLE" logo at the top.

2. **⭐ The backend is connected (the most important test).**
   On the **Dashboard** page, find the **"Backend"** card. It should show:
   - a **green dot** 🟢
   - **Roundtrip: echo "roundtrip-ok"**
   - **Goals in DB: 0**
   - **Backend version: v0.1.0**

   👉 This green card is proof that the whole stack works: the screen talked to the
   Rust engine, which wrote to the database and read it back. If you see this,
   **everything is wired correctly.**
   *(If it's orange and says "IPC failed", something's off — see Troubleshooting.)*

3. **Navigation works.**
   Click **Library**, then **Settings**, then **Dashboard** in the sidebar. The main
   area should change each time. The active item gets a **bright lime-green
   highlight**.

4. **Keyboard shortcut works.**
   Press **Ctrl + B**. The sidebar should **collapse to icons only**. Press it again
   to expand. (Ctrl + K is reserved for search — it won't do anything visible yet;
   that feature comes in a later milestone.)

If all four pass — 🎉 **the app works.** What you see now is the *foundation*: the
frame, backend, and database are all live. The content features (adding folders,
scanning files, the video player) are built in later milestones.

---

## Part 5 — Stopping the app

- **Close the app window** (the X), OR
- Click the terminal and press **Ctrl + C**, then confirm if asked.

To run it again later, just do Part 1 (`cd ...`) then Part 3 (`npm run tauri dev`).
The second time it starts in seconds, not minutes.

---

## Part 6 (Optional) — Build a real installable .exe

`tauri dev` is for testing. When you want a permanent app you can install like normal
software, run:

```bash
npm run tauri build
```

⏳ This takes **5–15 minutes** (it compiles an optimized version). When done, find
your installer here:

```
src-tauri\target\release\bundle\
```

Inside you'll find an **.msi** and/or **.exe** installer under the `msi\` or `nsis\`
folders. Double-click it to install PLE like any other Windows program.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `'cargo' is not recognized` | Run the PATH line from Part 2, then retry. |
| `'npm' is not recognized` | Install Node.js from https://nodejs.org (LTS), reopen terminal. |
| First `tauri dev` seems frozen on "Compiling" | It's not frozen — Rust compiles are slow the first time. Give it up to 8 minutes. |
| Backend card is **orange / "IPC failed"** | Close the app, stop the terminal (Ctrl+C), and run `npm run tauri dev` again. If it persists, the backend may have failed to start — scroll the terminal for a red `error` line. |
| Window never opens, terminal shows a red `error[E...]` | A compile error. Copy the red lines and share them. |
| "port 1420 is already in use" | Another copy is still running. Close other terminals/app windows, or restart your PC, then retry. |
| App opens but is **blank/white** | Stop it, run `npm run build` once (to rebuild the screen files), then `npm run tauri dev` again. |

---

## Quick reference (once you're comfortable)

```bash
# Go to the project
cd "c:\Users\PC\OneDrive\Documents\coding project\EDU app"

# First time only
npm install

# Run the app (dev mode)
npm run tauri dev

# Just test the pieces compile (no window)
npm run build                              # frontend
cd src-tauri && cargo test && cd ..        # backend

# Make an installable .exe
npm run tauri build
```

**Where your data lives:** the app stores its database at
`C:\Users\PC\AppData\Roaming\com.ple.learning\ple.db` (created on first launch).
Deleting that file resets the app to empty.
