import { SVGProps } from "react";

export function TelegramIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <defs>
        <linearGradient id="tg-bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#37AEE2" />
          <stop offset="100%" stopColor="#1E96C8" />
        </linearGradient>
        <filter id="tg-shadow">
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" floodOpacity="0.25" />
        </filter>
      </defs>
      <circle cx="12" cy="12" r="12" fill="url(#tg-bg-grad)" filter="url(#tg-shadow)" />
      <path
        d="M5.44 11.56l10.8-4.17c.5-.18.96.12.78.88l-1.85 8.7c-.14.63-.52.79-1.04.49l-2.88-2.12-1.39 1.34c-.15.15-.28.28-.58.28l.2-2.95 5.37-4.85c.23-.21-.05-.33-.36-.12l-6.64 4.18-2.87-.89c-.62-.2-.63-.62.13-.92z"
        fill="#ffffff"
        filter="drop-shadow(0px 1px 1px rgba(0,0,0,0.15))"
      />
    </svg>
  );
}
