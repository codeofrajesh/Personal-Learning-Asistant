import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config tuned for Tauri v2 (static export — no SSR, no Node server).
// Tauri serves the built static assets from dist/.
export default defineConfig(async () => ({
  plugins: [react()],

  // Tauri expects a fixed port and fails if it is unavailable.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    watch: {
      // Don't watch the Rust backend — Tauri handles that itself.
      ignored: ["**/src-tauri/**"],
    },
  },

  // Produce a fully static build that Tauri packages into the binary.
  build: {
    // Modern webview target — Tauri uses the OS webview (WebView2 on Windows).
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist",
  },
}));
