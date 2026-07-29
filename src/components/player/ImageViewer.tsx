/**
 * Image viewer (Section 8 Page 6 — image materials). Centers the image on the
 * charcoal stage; the asset-protocol URL loads it directly.
 */

import { assetUrl } from "../../lib/ipc";

export default function ImageViewer({ path }: { path: string }) {
  const src = assetUrl(path);
  if (!src) return <div className="grid h-full place-items-center text-sm text-content-muted">Loading image…</div>;

  return (
    <div className="grid h-full place-items-center rounded-card bg-black p-card">
      <img src={src} alt="" className="max-h-full max-w-full rounded-card object-contain" />
    </div>
  );
}
