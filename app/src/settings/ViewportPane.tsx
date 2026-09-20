/**
 * ViewportPane — the "Viewport" settings pane.
 *
 * The viewport's look-and-feel knobs, bound to the viewport-settings
 * singleton (app/src/settings/viewport.ts). Today: the snap-dot size slider.
 * `viewport/SnapDot.tsx` subscribes to the same singleton and resizes itself
 * — this pane only flips the persisted setting.
 *
 * The live sample beside the slider is not decoration: on macOS/Linux this
 * pane renders in a SEPARATE OS window that can fully occlude the model, and
 * on Windows FluentSettingsPage covers it outright, so without it the user
 * would be dragging a slider with nothing to look at. It is the real marker
 * (`SnapDotSample` shares `snapDotGeometry` with it), not a lookalike.
 *
 * Laid out on the shared macOS-HIG form grid (SettingsForm.tsx). Reusable
 * from both the standalone Settings window (Tauri) and the in-app modal
 * fallback (web). Changes apply instantly — no OK/Cancel.
 */

import { useEffect, useState } from 'react'
import {
  getSnapDotScale,
  setSnapDotScale,
  subscribe,
  formatScalePercent,
  SNAP_DOT_SCALE_MIN,
  SNAP_DOT_SCALE_MAX,
  SNAP_DOT_SCALE_STEP,
} from './viewport'
import { SnapDotSample } from '../viewport/SnapDot'
import { SettingsForm, SettingsRow, SettingsNote, SettingsSlider } from './SettingsForm'

export function ViewportPane() {
  const [scale, setScale] = useState<number>(() => getSnapDotScale())

  // Keep in sync with external changes (the other window, or another
  // subscriber in this same window).
  useEffect(() => subscribe((s) => setScale(s.snapDotScale)), [])

  return (
    <SettingsForm>
      <SettingsRow label="Snap dot size" htmlFor="settings-viewport-snap-dot-scale" alignTop>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <SettingsSlider
            id="settings-viewport-snap-dot-scale"
            value={scale}
            min={SNAP_DOT_SCALE_MIN}
            max={SNAP_DOT_SCALE_MAX}
            step={SNAP_DOT_SCALE_STEP}
            onChange={setSnapDotScale}
            format={formatScalePercent}
            minLabel="Small"
            maxLabel="Large"
          />
          <SnapDotSample scale={scale} />
        </div>
      </SettingsRow>

      <SettingsNote>
        The colored marker that rides the cursor and lands on the exact point a
        tool has snapped to. This changes how big it draws — not how close the
        cursor must come before a point is picked up.
      </SettingsNote>
    </SettingsForm>
  )
}
