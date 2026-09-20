/**
 * SnapDot — the precise on-cursor inference marker (`07_inference_feedback.md`,
 * Refinement pass issue B). A filled dot centered exactly on the snap point,
 * colored by inference type, with a white contrast ring, a soft tinted halo
 * and a gentle pulse.
 *
 * This is the fix for "other than Select, it's hard to see where the snap
 * point physically is": the old marker was a thin 1px three.js cross that got
 * lost against geometry. The dot reuses the same container-relative
 * `screenX/screenY` the `InferenceTooltip` chip already projects (from
 * `Viewport.tsx`'s `onInferenceChange`), so it sits on the exact snap point
 * while the tool-glyph cursor rides offset (its hotspot is the click point,
 * the glyph body sits up-and-right of it — see `tools/toolIcons.ts`).
 *
 * SIZE is user-adjustable (Settings ▸ Viewport ▸ Snap dot size) via the
 * `snapDotScale` field of `settings/viewport.ts`, which this component
 * subscribes to itself rather than taking as a prop — it renders from two
 * hosts (`App.tsx` and Shop Mode's `ShopApp.tsx`) and self-subscribing keeps
 * them from drifting. The shipped size is a 10px core; the slider spans
 * 0.6–1.5× of it.
 *
 * The pulse + halo are CSS (`.hew-snap-dot` in index.css) so
 * `prefers-reduced-motion` can drop the animation to a static dot.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { inferenceCssColor, KIND_CSS_COLOR } from './inferenceColor'
import { getSnapDotScale, subscribe } from '../settings/viewport'
import type { InferenceInfo } from './Viewport'

/** The shipped marker, at `snapDotScale === 1`. */
const BASE_CORE_PX = 10
const BASE_RING_PX = 1.25
const BASE_HALO_PX = 3

/**
 * A sub-pixel `border` does not render thinner — it renders as a grey smear,
 * destroying the very contrast the white ring exists to provide. So the ring
 * alone gets a floor; the halo is a ~22%-alpha `box-shadow` spread that
 * antialiases gracefully all the way down and must stay proportional (a 6px
 * core wearing a 3px halo looks wrong, not small).
 */
const MIN_RING_PX = 1

/** 0.1-step scales hit binary-float drift (10 * 0.7 = 7.000000000000001). */
function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * The marker's size-bearing CSS at a given scale. Shared by `SnapDot` (the
 * live marker) and `SnapDotSample` (the Settings preview) so the two can
 * never drift apart.
 *
 * NOTE size lives in `width`/`height`/`border`/`box-shadow` and deliberately
 * NOT in a `transform: scale()`: `.hew-snap-dot`'s pulse keyframes own the
 * `transform` property outright, so a transform-based scale would be silently
 * clobbered whenever the animation runs — appearing to work only under
 * `prefers-reduced-motion`. Sizing the box instead also means the pulse stays
 * proportional at every scale for free.
 */
export function snapDotGeometry(color: string, scale: number): CSSProperties {
  const core = round2(BASE_CORE_PX * scale)
  const ring = Math.max(MIN_RING_PX, round2(BASE_RING_PX * scale))
  const halo = round2(BASE_HALO_PX * scale)
  return {
    width: core,
    height: core,
    borderRadius: '50%',
    background: color,
    // White ring for contrast on any material/background; soft tinted halo.
    border: `${ring}px solid rgba(255, 255, 255, 0.92)`,
    boxShadow: `0 0 0 ${halo}px color-mix(in srgb, ${color} 22%, transparent)`,
  }
}

/** Track the user's snap-dot scale. Hooks run unconditionally, so callers
 * must invoke this ABOVE any early return. */
function useSnapDotScale(): number {
  const [scale, setScale] = useState<number>(() => getSnapDotScale())
  // Keep in sync with external changes (the Settings window, which on
  // macOS/Linux is a separate webview entirely).
  useEffect(() => subscribe((s) => setScale(s.snapDotScale)), [])
  return scale
}

export function SnapDot({ info }: { info: InferenceInfo | null }) {
  // Above the null check — React hooks must not sit behind a conditional.
  const scale = useSnapDotScale()
  if (info === null) return null
  return (
    <div
      aria-hidden="true"
      className="hew-snap-dot"
      style={{
        position: 'absolute',
        left: `${info.screenX}px`,
        top: `${info.screenY}px`,
        ...snapDotGeometry(inferenceCssColor(info), scale),
        pointerEvents: 'none',
        // Below the tooltip chip (z 20) — they never overlap (the chip is
        // offset +16,+16), but keep the label on top if they ever do.
        zIndex: 19,
        // Centering is expressed in the keyframes (so the animated transform
        // doesn't fight it); this inline value covers the reduced-motion case
        // where the animation is disabled.
        transform: 'translate(-50%, -50%)',
      }}
    />
  )
}

/**
 * A static sample of the marker for the Settings ▸ Viewport slider — on
 * macOS/Linux the Settings window is a separate OS window that can fully
 * occlude the model, and on Windows `FluentSettingsPage` covers it outright,
 * so without this the slider would be adjusting something invisible.
 *
 * Rendered through the SAME `snapDotGeometry` and the same
 * `left/top: 50%` + keyframe-owned centering idiom as the live marker, so it
 * pulses identically and honors `prefers-reduced-motion` identically — one
 * code path, no special-casing. The box is fixed at the largest footprint the
 * slider can reach so the settings row doesn't reflow as the user drags.
 */
const SAMPLE_BOX_PX = 32

export function SnapDotSample({
  scale,
  color = KIND_CSS_COLOR.endpoint,
}: {
  scale: number
  /** Defaults to the endpoint green — the most common snap, and legible on
   *  both themes. */
  color?: string
}) {
  return (
    <div
      aria-hidden="true"
      data-testid="snap-dot-sample"
      style={{
        position: 'relative',
        width: SAMPLE_BOX_PX,
        height: SAMPLE_BOX_PX,
        flexShrink: 0,
      }}
    >
      <div
        className="hew-snap-dot"
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          ...snapDotGeometry(color, scale),
          pointerEvents: 'none',
          transform: 'translate(-50%, -50%)',
        }}
      />
    </div>
  )
}
