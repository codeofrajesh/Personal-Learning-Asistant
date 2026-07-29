/**
 * 404 fallback for unknown routes.
 */

import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="min-h-full p-6">
    <div className="animate-fade-up grid min-h-[60vh] place-items-center text-center">
      <div>
        <div className="text-5xl font-bold text-lime">404</div>
        <p className="mt-2 text-content-secondary">This page doesn’t exist.</p>
        <Link
          to="/"
          className="mt-4 inline-block rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02]"
        >
          Back to Dashboard
        </Link>
      </div>
    </div>
    </div>
  );
}
