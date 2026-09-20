/**
 * Component tests for SnapDot — the on-cursor inference marker.
 *
 * These pin the marker's rendered geometry, which lived as unguarded magic
 * numbers in the JSX until it became user-adjustable (Settings ▸ Viewport ▸
 * Snap dot size). The `scale === 1` case is deliberately exact: it is the
 * regression guard that the shipped look did not change when the knob landed.
 *
 * The `snapDotScale` singleton carries module-level state, so it is reset
 * between tests via its own setter (faster than vi.resetModules) — the same
 * convention SettingsWindow.test.tsx uses for units/debugMode.
 */

import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { SnapDot, SnapDotSample, snapDotGeometry } from './SnapDot'
import { setSnapDotScale, SNAP_DOT_SCALE_MIN, SNAP_DOT_SCALE_MAX } from '../settings/viewport'
import type { InferenceInfo } from './Viewport'

const ENDPOINT: InferenceInfo = { kind: 'endpoint', screenX: 120, screenY: 80 }

function dot(): HTMLElement {
  // The marker is aria-hidden, so it is not queryable by role/name.
  const el = document.querySelector('.hew-snap-dot')
  if (el === null) throw new Error('no snap dot rendered')
  return el as HTMLElement
}

beforeEach(() => {
  setSnapDotScale(1)
})

afterEach(() => {
  setSnapDotScale(1)
})

describe('SnapDot', () => {
  it('renders nothing when there is no inference', () => {
    const { container } = render(<SnapDot info={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('positions itself on the inference point', () => {
    render(<SnapDot info={ENDPOINT} />)
    expect(dot().style.left).toBe('120px')
    expect(dot().style.top).toBe('80px')
  })

  it('renders the shipped geometry at scale 1 (10px core, 1.25px ring, 3px halo)', () => {
    render(<SnapDot info={ENDPOINT} />)
    const style = dot().style
    expect(style.width).toBe('10px')
    expect(style.height).toBe('10px')
    expect(style.border).toContain('1.25px')
    expect(style.boxShadow).toContain('3px')
  })

  it('scales the core, ring and halo together', () => {
    setSnapDotScale(1.4)
    render(<SnapDot info={ENDPOINT} />)
    const style = dot().style
    expect(style.width).toBe('14px')
    expect(style.border).toContain('1.75px')
    expect(style.boxShadow).toContain('4.2px')
  })

  it('floors the white contrast ring at 1px so it never renders as a grey smear', () => {
    setSnapDotScale(SNAP_DOT_SCALE_MIN)
    render(<SnapDot info={ENDPOINT} />)
    const style = dot().style
    // Strictly proportional would be 0.75px here.
    expect(style.width).toBe('6px')
    expect(style.border).toContain('1px')
    expect(style.border).not.toContain('0.75px')
  })

  it('keeps the halo proportional at the minimum (no floor — it antialiases)', () => {
    setSnapDotScale(SNAP_DOT_SCALE_MIN)
    render(<SnapDot info={ENDPOINT} />)
    expect(dot().style.boxShadow).toContain('1.8px')
  })

  it('carries the pulse class at every scale, so the animation follows the size', () => {
    for (const scale of [SNAP_DOT_SCALE_MIN, 1, SNAP_DOT_SCALE_MAX]) {
      setSnapDotScale(scale)
      const { unmount } = render(<SnapDot info={ENDPOINT} />)
      expect(dot().className).toBe('hew-snap-dot')
      unmount()
    }
  })

  it('is hidden from assistive technology (it is decoration for a mouse gesture)', () => {
    render(<SnapDot info={ENDPOINT} />)
    expect(dot()).toHaveAttribute('aria-hidden', 'true')
  })

  it('resizes a mounted marker when the setting changes in another window', () => {
    render(<SnapDot info={ENDPOINT} />)
    expect(dot().style.width).toBe('10px')
    // The singleton is what the cross-window 'settings-changed' listener
    // writes; the mounted marker subscribes to it directly. `act` because
    // the notification arrives outside React's own event handling.
    act(() => setSnapDotScale(0.7))
    expect(dot().style.width).toBe('7px')
  })
})

describe('snapDotGeometry', () => {
  it('is the single source of truth for the marker proportions', () => {
    expect(snapDotGeometry('#0f0', 1)).toMatchObject({
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: '#0f0',
    })
  })

  it('avoids binary-float drift at 0.1 slider steps', () => {
    // 10 * 0.7 is 7.000000000000001 in IEEE-754.
    expect(snapDotGeometry('#0f0', 0.7).width).toBe(7)
    expect(snapDotGeometry('#0f0', 0.9).width).toBe(9)
    expect(snapDotGeometry('#0f0', 1.1).width).toBe(11)
  })
})

describe('SnapDotSample', () => {
  it('renders the same geometry as the live marker, without an inference point', () => {
    render(<SnapDotSample scale={0.8} />)
    expect(screen.getByTestId('snap-dot-sample')).toBeInTheDocument()
    const style = dot().style
    expect(style.width).toBe('8px')
    // Centered in its own box rather than placed at a projected screen point.
    expect(style.left).toBe('50%')
    expect(style.top).toBe('50%')
  })

  it('is hidden from assistive technology (the slider carries the label)', () => {
    render(<SnapDotSample scale={1} />)
    expect(screen.getByTestId('snap-dot-sample')).toHaveAttribute('aria-hidden', 'true')
  })
})
