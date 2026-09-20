/**
 * Component tests for ViewportPane — the snap-dot size slider.
 *
 * The viewport-settings singleton carries module-level state, so it is reset
 * between tests via its own setter (faster than vi.resetModules) — the same
 * convention SettingsWindow.test.tsx uses for units/debugMode.
 */

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { ViewportPane } from './ViewportPane'
import { getSnapDotScale, setSnapDotScale, SNAP_DOT_SCALE_MIN, SNAP_DOT_SCALE_MAX } from './viewport'

function slider(): HTMLInputElement {
  return screen.getByRole('slider', { name: 'Snap dot size' }) as HTMLInputElement
}

beforeEach(() => {
  setSnapDotScale(1)
})

afterEach(() => {
  setSnapDotScale(1)
})

describe('ViewportPane', () => {
  it('renders a labeled slider spanning the setting range', () => {
    render(<ViewportPane />)
    expect(slider().min).toBe(String(SNAP_DOT_SCALE_MIN))
    expect(slider().max).toBe(String(SNAP_DOT_SCALE_MAX))
    expect(slider().value).toBe('1')
  })

  it('reads out the default as 100%', () => {
    render(<ViewportPane />)
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('writes the singleton when the slider moves, and updates the readout', () => {
    render(<ViewportPane />)
    fireEvent.change(slider(), { target: { value: '0.7' } })
    expect(getSnapDotScale()).toBe(0.7)
    expect(screen.getByText('70%')).toBeInTheDocument()
  })

  it('announces the value as a percentage, not a bare float', () => {
    // aria-valuenow would otherwise be read out as "zero point seven".
    render(<ViewportPane />)
    fireEvent.change(slider(), { target: { value: '0.7' } })
    expect(slider()).toHaveAttribute('aria-valuetext', '70%')
  })

  it('shows the live sample marker at the selected size', () => {
    render(<ViewportPane />)
    fireEvent.change(slider(), { target: { value: '1.4' } })
    const sample = screen.getByTestId('snap-dot-sample')
    expect(sample).toHaveAttribute('aria-hidden', 'true')
    const marker = sample.querySelector('.hew-snap-dot') as HTMLElement
    expect(marker.style.width).toBe('14px')
  })

  it('starts from the persisted value rather than the default', () => {
    setSnapDotScale(0.8)
    render(<ViewportPane />)
    expect(slider().value).toBe('0.8')
    expect(screen.getByText('80%')).toBeInTheDocument()
  })
})
