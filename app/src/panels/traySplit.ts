/**
 * Tray section split — how the docked tray's height is shared between its
 * open sections.
 *
 * Each section carries a flex-grow weight; open sections render at
 * `flex: <weight> 1 0`, so the tray's free height is divided in proportion
 * to weight. Dragging the separator between two open sections moves weight
 * between just that pair (their sum is conserved), so no other section
 * moves. Weights survive a section collapsing, so it reopens at its old
 * share. Persisted per window, like the tray width.
 */

import type { TrayLayout } from '../settings/trayLayout'

export type TraySectionKey = keyof TrayLayout
export type TraySectionWeights = Record<TraySectionKey, number>

export const TRAY_SECTION_WEIGHTS_KEY = 'hew.traySectionWeights'
/** Smallest pixel height a drag may squeeze a section to: its header plus a
 *  couple of rows. */
export const TRAY_SECTION_MIN_PX = 60

/** The sections in tray order, top to bottom. */
export const TRAY_SECTION_ORDER: readonly TraySectionKey[] = [
  'objectInfo', 'modelInfo', 'materials', 'components', 'tags', 'scenes', 'changes',
]

export const DEFAULT_TRAY_SECTION_WEIGHTS: TraySectionWeights = Object.fromEntries(
  TRAY_SECTION_ORDER.map((k) => [k, 1]),
) as TraySectionWeights

/** Parse a persisted value; any missing, non-finite or non-positive entry
 *  falls back to 1. */
export function parseTraySectionWeights(raw: string | null): TraySectionWeights {
  const out = { ...DEFAULT_TRAY_SECTION_WEIGHTS }
  if (raw === null) return out
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return out
  }
  if (typeof obj !== 'object' || obj === null) return out
  for (const k of TRAY_SECTION_ORDER) {
    const w = (obj as Record<string, unknown>)[k]
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) out[k] = w
  }
  return out
}

export function loadTraySectionWeights(): TraySectionWeights {
  try {
    return parseTraySectionWeights(window.localStorage.getItem(TRAY_SECTION_WEIGHTS_KEY))
  } catch {
    return { ...DEFAULT_TRAY_SECTION_WEIGHTS }
  }
}

export function saveTraySectionWeights(weights: TraySectionWeights): void {
  try {
    window.localStorage.setItem(TRAY_SECTION_WEIGHTS_KEY, JSON.stringify(weights))
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

/**
 * New weights for an adjacent pair after dragging their separator by `dy`
 * pixels (positive = down, growing the upper section). `hA`/`hB` are the
 * pair's pixel heights when the drag began. The upper section's height is
 * clamped so neither drops below `min`; the pair's weight total is kept.
 */
export function splitPair(
  wA: number,
  wB: number,
  hA: number,
  hB: number,
  dy: number,
  min: number = TRAY_SECTION_MIN_PX,
): [number, number] {
  const total = hA + hB
  if (total <= 0) return [wA, wB]
  const lo = Math.min(min, total / 2)
  const nextA = Math.min(total - lo, Math.max(lo, hA + dy))
  const sum = wA + wB
  const a = (sum * nextA) / total
  return [a, sum - a]
}
