/** @type {import('tailwindcss').Config} */

// ─────────────────────────────────────────────────────────────────────────────
// PLE Design System — Tailwind theme (three-layer token architecture)
//
//   Primitive (raw values)  →  Semantic (purpose)  →  Component (usage)
//
// This file defines the PRIMITIVE + SEMANTIC layers as Tailwind theme extensions.
// The runtime CSS-variable bridge (for light/dark theming later) lives in
// index.css. Colors reference the brand DNA in Section 7 of the brief:
//   charcoal #0D0D0D–#1A1A1A, neon-lime #AAFF00, warm-orange #FF6B35.
//
// Glassmorphism + neon accent are an explicit brand brief (not the LLM default),
// so the anti-glow guidance in the design-taste skill is overridden here per its
// own override path.
// ─────────────────────────────────────────────────────────────────────────────

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class", // dark is default; class strategy leaves room for a future light theme
  theme: {
    extend: {
      colors: {
        // ── Primitive: surfaces (deep charcoal ramp) ──
        ink: {
          950: "#0A0A0A",
          900: "#0D0D0D", // app background (Section 7)
          850: "#141414",
          800: "#1A1A1A", // elevated surface (Section 7)
          700: "#242424",
          600: "#2E2E2E",
        },
        // ── Primitive: accents ──
        lime: {
          DEFAULT: "#AAFF00", // primary accent — nav active, progress, highlights
          bright: "#BEFF3D",
          dim: "#8CD400",
        },
        orange: {
          DEFAULT: "#FF6B35", // secondary accent — CTAs, completion badges, alerts
          bright: "#FF8659",
          dim: "#E0561F",
        },
        // ── Semantic: text ──
        content: {
          primary: "#F4F4F5", // near-white (never pure white — depth)
          secondary: "#A1A1AA",
          muted: "#71717A", // ~#888 muted gray (Section 7)
          faint: "#52525B",
        },
      },
      fontFamily: {
        // Inter is the brand-specified typeface (Section 7). The design-taste
        // skill discourages Inter as a *default*, but here it is an explicit brief.
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        // Shape lock (Section 7): 12-16px cards, 8px buttons/inputs.
        btn: "8px",
        card: "14px",
        panel: "16px",
      },
      boxShadow: {
        // Tinted to the dark background, not pure black (a11y depth rule).
        card: "0 4px 24px rgba(0,0,0,0.30)",
        "card-hover": "0 8px 32px rgba(0,0,0,0.42)",
        "glow-lime": "0 0 0 1px rgba(170,255,0,0.35), 0 0 20px rgba(170,255,0,0.18)",
      },
      backdropBlur: {
        glass: "12px", // Section 7: backdrop-filter: blur(12px)
      },
      spacing: {
        // 4px base grid — extends Tailwind's default 4px scale with named steps
        // used by the card system (Section 7: 20-24px card padding, 12-16px gaps).
        card: "1.375rem", // 22px — inside-card padding midpoint
        gutter: "0.875rem", // 14px — grid gap midpoint
      },
      transitionTimingFunction: {
        smooth: "cubic-bezier(0.16, 1, 0.3, 1)", // premium ease-out
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-up": "fade-up 0.25s cubic-bezier(0.16, 1, 0.3, 1) both",
      },
    },
  },
  plugins: [],
};
