/**
 * Component tests for FluentSettingsPage — the Windows settings surface.
 *
 * The page is a second, hand-written copy of the macOS panes' content
 * (SettingsWindow.tsx and the six *Pane.tsx files), so a setting added to
 * one side and forgotten on the other fails silently: the control is simply
 * absent on Windows. These tests are that failure made loud — they assert
 * the control is present, carries the accessible name a screen reader would
 * read, and writes through to the same singleton the macOS pane writes.
 *
 * Rendered bare, with no app around it. Every host-capability check
 * (libraryStore, serverForm) resolves false outside Tauri, so no vi.mock is
 * needed; the sections those gate are covered in their unavailable state
 * instead — see the last describe block.
 *
 * Singletons carry module-level state and are reset through their own
 * setters rather than vi.resetModules, the convention ViewportPane.test.tsx
 * and SettingsWindow.test.tsx both follow.
 */

import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { FluentSettingsPage } from './FluentSettingsPage'
import { getLengthUnit, setLengthUnit } from './units'
import { getThemeSetting, setThemeSetting } from './theme'
import { getDebugMode, setDebugMode } from './debugMode'
import { getSnapDotScale, setSnapDotScale, SNAP_DOT_SCALE_MIN, SNAP_DOT_SCALE_MAX } from './viewport'

function show(onBack: () => void = vi.fn()): void {
  render(<FluentSettingsPage onBack={onBack} />)
}

/** Restore every singleton this page binds to. Runs before AND after, so a
 *  failing assertion mid-test can't leak a value into the next file. */
function resetSettings(): void {
  setLengthUnit('m')
  setThemeSetting('auto')
  setDebugMode(false)
  setSnapDotScale(1)
}

beforeEach(resetSettings)
afterEach(resetSettings)

describe('FluentSettingsPage — the page shell', () => {
  it('renders as a named region so the page is reachable by role', () => {
    show()
    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument()
  })

  it('returns to the document from the back arrow', () => {
    const onBack = vi.fn()
    show(onBack)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('returns to the document on Escape', () => {
    const onBack = vi.fn()
    show(onBack)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('groups the cards under every section the macOS panes cover', () => {
    show()
    for (const header of ['Units', 'Appearance', 'Viewport', 'Library', 'Server', 'Debug']) {
      expect(screen.getByText(header)).toBeInTheDocument()
    }
  })
})

describe('FluentSettingsPage — every control is present and named', () => {
  it('labels each select with the card title above it', () => {
    show()
    expect(screen.getByRole('combobox', { name: 'Measurement system' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Length format' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'App theme' })).toBeInTheDocument()
  })

  it('offers the snap-dot slider across the setting range', () => {
    show()
    const slider = screen.getByRole('slider', { name: 'Snap dot size' }) as HTMLInputElement
    expect(slider.min).toBe(String(SNAP_DOT_SCALE_MIN))
    expect(slider.max).toBe(String(SNAP_DOT_SCALE_MAX))
  })

  it('uses a Fluent toggle switch for debug mode, not a checkbox', () => {
    show()
    expect(screen.getByRole('switch', { name: 'Debug mode' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Debug mode' })).toBeNull()
  })

  it('shows the library folder field and its picker', () => {
    show()
    expect(screen.getByLabelText('Library folder:')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change…' })).toBeInTheDocument()
  })
})

describe('FluentSettingsPage — controls write the singleton', () => {
  it('switching to imperial takes the default imperial format', () => {
    show()
    fireEvent.change(screen.getByRole('combobox', { name: 'Measurement system' }), {
      target: { value: 'imperial' },
    })
    expect(getLengthUnit()).toBe('arch')
  })

  it('narrows the format list to the chosen system', () => {
    setLengthUnit('arch')
    show()
    const format = screen.getByRole('combobox', { name: 'Length format' })
    const values = Array.from(format.querySelectorAll('option')).map((o) => o.value)
    expect(values).toContain('frac_in')
    expect(values).not.toContain('mm')
  })

  it('picking a length format writes it', () => {
    show()
    fireEvent.change(screen.getByRole('combobox', { name: 'Length format' }), {
      target: { value: 'cm' },
    })
    expect(getLengthUnit()).toBe('cm')
  })

  it('picking a theme writes it', () => {
    show()
    fireEvent.change(screen.getByRole('combobox', { name: 'App theme' }), {
      target: { value: 'dark' },
    })
    expect(getThemeSetting()).toBe('dark')
  })

  it('moving the snap-dot slider writes it and updates the readout', () => {
    show()
    fireEvent.change(screen.getByRole('slider', { name: 'Snap dot size' }), {
      target: { value: '0.7' },
    })
    expect(getSnapDotScale()).toBe(0.7)
    expect(screen.getByText('70%')).toBeInTheDocument()
  })

  it('toggling debug writes it', () => {
    show()
    fireEvent.click(screen.getByRole('switch', { name: 'Debug mode' }))
    expect(getDebugMode()).toBe(true)
  })
})

describe('FluentSettingsPage — a change made elsewhere shows up here', () => {
  // The cross-window sync path: another window writes the singleton, this
  // page's subscription repaints. Missing the subscribe() is the failure
  // mode the adding-a-setting skill calls out, and it is invisible until a
  // second surface changes the value.
  //
  // The setter is called through act() because it reaches React from
  // outside an event handler — the same way the real inbound sync does
  // (a `storage` event, or Tauri's `settings-changed`) — so the repaint
  // has to be flushed before asserting on it.

  it('repaints the format select when the unit changes elsewhere', () => {
    show()
    act(() => setLengthUnit('mm'))
    expect(screen.getByRole('combobox', { name: 'Length format' })).toHaveValue('mm')
  })

  it('repaints the theme select when the theme changes elsewhere', () => {
    show()
    act(() => setThemeSetting('light'))
    expect(screen.getByRole('combobox', { name: 'App theme' })).toHaveValue('light')
  })

  it('repaints the debug switch when debug mode changes elsewhere', () => {
    show()
    act(() => setDebugMode(true))
    expect(screen.getByRole('switch', { name: 'Debug mode' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('repaints the snap-dot slider when the size changes elsewhere', () => {
    show()
    act(() => setSnapDotScale(1.4))
    expect(screen.getByRole('slider', { name: 'Snap dot size' })).toHaveValue('1.4')
  })
})

describe('FluentSettingsPage — the host-gated sections degrade, not throw', () => {
  // Both of these need Tauri. Under jsdom their availability checks resolve
  // false, which is the same answer a browser build gives — so these assert
  // the browser presentation rather than mocking a desktop that isn't here.

  it('disables the library picker and says why', () => {
    show()
    expect(screen.getByRole('button', { name: 'Change…' })).toBeDisabled()
    expect(screen.getByPlaceholderText('Not available in the browser build yet.')).toBeInTheDocument()
  })

  it('shows the server as the read-only serving origin, with nothing to configure', () => {
    show()
    expect(screen.getByTestId('settings-server-readonly')).toHaveTextContent(window.location.origin)
    expect(screen.queryByRole('combobox', { name: 'Open on Phone server' })).toBeNull()
  })
})
