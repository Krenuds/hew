import { describe, it, expect } from 'vitest'
import { selectModeFor, isModifiedSelectPress } from './selectModifiers'

const keys = (o: Partial<Parameters<typeof selectModeFor>[0]> = {}) => ({
  shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...o,
})

describe('selectModeFor — SketchUp modifier matrix', () => {
  it('a bare press replaces', () => {
    expect(selectModeFor(keys())).toBe('replace')
  })

  it('Shift toggles', () => {
    expect(selectModeFor(keys({ shiftKey: true }))).toBe('toggle')
  })

  it('Ctrl, ⌘, and Option each add', () => {
    expect(selectModeFor(keys({ ctrlKey: true }))).toBe('add')
    expect(selectModeFor(keys({ metaKey: true }))).toBe('add')
    expect(selectModeFor(keys({ altKey: true }))).toBe('add')
  })

  it('Shift with any add modifier subtracts', () => {
    expect(selectModeFor(keys({ shiftKey: true, ctrlKey: true }))).toBe('subtract')
    expect(selectModeFor(keys({ shiftKey: true, metaKey: true }))).toBe('subtract')
    expect(selectModeFor(keys({ shiftKey: true, altKey: true }))).toBe('subtract')
  })

  it('isModifiedSelectPress is true for every non-replace mode', () => {
    expect(isModifiedSelectPress(keys())).toBe(false)
    expect(isModifiedSelectPress(keys({ shiftKey: true }))).toBe(true)
    expect(isModifiedSelectPress(keys({ metaKey: true }))).toBe(true)
    expect(isModifiedSelectPress(keys({ shiftKey: true, altKey: true }))).toBe(true)
  })
})
