# Telegram Direct Streaming Integration (No VPS)

This document outlines the architecture for integrating a Telegram client natively into the Tauri application. This allows the user to stream private/public Telegram videos directly through the existing `MpvVideoPlayer` or `VideoPlayer` without downloading full files or using a middleman VPS. 

## Will Telegram ban the account for this?
**No, as long as it is built correctly.** Telegram officially provides the MTProto API precisely so developers can build custom clients (like Unigram, Telegram X, etc.). 

Telegram's ban systems are purely behavioral. They ban accounts for:
1. **Spamming:** Sending hundreds of messages or joining dozens of groups rapidly.
2. **Datacenter IPs:** Connecting from AWS/DigitalOcean IPs (which looks like a bot network).
3. **Ignoring Limits:** Hitting the API in a tight loop and ignoring `FLOOD_WAIT` limits.

Since this integration will run directly on the user's PC (using their normal home Wi-Fi IP address), only reads/streams media (no spamming), and uses a standard MTProto library that automatically respects `FLOOD_WAIT` limits, **Telegram will see it as indistinguishable from the official Telegram Desktop app.**

---

## Proposed Architecture

### 1. Telegram Client Setup (Rust Backend)
We will use **`grammers`**, a highly optimized, pure-Rust implementation of the Telegram MTProto protocol. 
*   **Why grammers?** It avoids the need to compile massive C++ libraries like `tdlib` (which inflates app size by ~30MB and makes cross-compilation difficult).
*   **Session Storage**: The user's Telegram session will be serialized and saved locally (e.g., in the app's `AppData` folder), so they only need to log in once.

### 2. The Authentication Flow (React + Rust)
We need a UI for the user to log in to their Telegram account using their phone number.
*   **UI (React)**: A new Settings tab: "Connect Telegram".
    *   Step 1: Enter Phone Number.
    *   Step 2: Enter 5-digit code sent to their Telegram app.
    *   Step 3: (Optional) Enter 2FA Password.
*   **IPC Bridge**: `ipc.ts` gets three new commands: `tg_request_code(phone)`, `tg_sign_in(code)`, `tg_check_auth()`.

### 3. Local Streaming Server (Rust)
To feed videos into the HTML5 or MPV player natively, we will embed a tiny, fast HTTP server inside Tauri (using `axum` or `warp`).
*   **Endpoint**: `GET http://localhost:8080/tg-stream/<chat_id>/<message_id>`
*   **Range Requests**: The server will parse the standard HTTP `Range` header sent by `mpv` or `<video>`.
*   **MTProto Fetch**: Rust calculates which 512KB Telegram chunk (offset) corresponds to the requested byte range, calls `client.iter_download(media).offset(x)`, and streams the bytes directly back to the video player. This allows instant seeking.

### 4. Avoiding Account Bans (Safety Measures)
*   **User API ID**: For maximum safety, users can provide their own `api_id` and `api_hash` generated from `my.telegram.org`, ensuring the app doesn't have a single centralized "Developer ID" that could be flagged if another user abuses it.
*   **Proper Device Info**: We will set the `device_model` and `app_version` in `grammers` to mimic a standard desktop OS environment.
*   **Connection Pooling**: Limit concurrent video chunk downloads to match Telegram's official client parameters (typically 1-4 concurrent streams max).

### 5. Frontend Integration
*   The Library / Courses UI will allow importing "Telegram Links" (e.g., `https://t.me/c/12345/678`).
*   The DB stores the `chat_id` and `message_id` instead of a local `.mkv` file path.
*   When opening a material, if it's a Telegram video, `MpvVideoPlayer` gets `path="http://localhost:8080/tg-stream/12345/678"`. MPV natively supports HTTP streaming and will seamlessly buffer, seek, and play it just like a local file.
