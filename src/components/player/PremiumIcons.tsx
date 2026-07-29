/**
 * Premium SVG icons for the video controls (lucide-react).
 *
 * Per web-design-guidelines: use an icon library, never hand-roll SVG icon
 * paths. lucide-react gives crisp, consistent, stroke-based glyphs that match a
 * premium video-player aesthetic (YouTube / MX Player / VLC) far better than the
 * emoji glyphs the controls used before.
 *
 * Each wrapper fixes strokeWidth to 2 and sizes to 20px (the control bar's icon
 * size) so the whole bar reads as one icon family. `aria-hidden` — the adjacent
 * button supplies the label.
 */

import { Pause, Play, Volume2, VolumeX, Rewind, FastForward, Maximize, Minimize, Gauge, ExternalLink } from "lucide-react";
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 20): IconProps => ({
  size,
  strokeWidth: 2,
  "aria-hidden": true,
});

export const PlayIcon = ({ size, ...p }: IconProps) => <Play {...base(size)} {...p} />;
export const PauseIcon = ({ size, ...p }: IconProps) => <Pause {...base(size)} {...p} />;
export const VolumeIcon = ({ size, ...p }: IconProps) => <Volume2 {...base(size)} {...p} />;
export const MuteIcon = ({ size, ...p }: IconProps) => <VolumeX {...base(size)} {...p} />;
export const SkipBackIcon = ({ size, ...p }: IconProps) => <Rewind {...base(size)} {...p} />;
export const SkipForwardIcon = ({ size, ...p }: IconProps) => <FastForward {...base(size)} {...p} />;
export const FullscreenIcon = ({ size, ...p }: IconProps) => <Maximize {...base(size)} {...p} />;
export const ExitFullscreenIcon = ({ size, ...p }: IconProps) => <Minimize {...base(size)} {...p} />;
export const SpeedIcon = ({ size, ...p }: IconProps) => <Gauge {...base(size)} {...p} />;
export const ExternalLinkIcon = ({ size, ...p }: IconProps) => <ExternalLink {...base(size)} {...p} />;
