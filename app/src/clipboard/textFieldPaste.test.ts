// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  handleTextFieldMenuAction,
  isTextFieldFocused,
  pasteTextIntoFocusedField,
} from './textFieldPaste'

function focusedInput(): HTMLInputElement {
  const input = document.createElement('input')
  document.body.appendChild(input)
  input.focus()
  return input
}

describe('pasteTextIntoFocusedField', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    ;(document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => true)
  })

  it('does nothing and reports false when no text field has focus', async () => {
    const readText = vi.fn(async () => 'hello')
    expect(isTextFieldFocused()).toBe(false)
    expect(await pasteTextIntoFocusedField(readText)).toBe(false)
    expect(readText).not.toHaveBeenCalled()
  })

  it('inserts the OS clipboard text into the focused input', async () => {
    focusedInput()
    const readText = vi.fn(async () => 'Door 2')
    expect(await pasteTextIntoFocusedField(readText)).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'Door 2')
  })

  it('claims the paste but inserts nothing when the clipboard is empty or unreadable', async () => {
    const area = document.createElement('textarea')
    document.body.appendChild(area)
    area.focus()
    expect(await pasteTextIntoFocusedField(async () => '')).toBe(true)
    expect(await pasteTextIntoFocusedField(async () => { throw new Error('denied') })).toBe(true)
    expect(document.execCommand).not.toHaveBeenCalled()
  })

  it('drops the text when focus left the field during the clipboard read', async () => {
    const input = focusedInput()
    const other = document.createElement('input')
    document.body.appendChild(other)
    const readText = async () => {
      input.blur()
      other.focus()
      return 'stale'
    }
    expect(await pasteTextIntoFocusedField(readText)).toBe(true)
    expect(document.execCommand).not.toHaveBeenCalled()
  })
})

describe('handleTextFieldMenuAction', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    ;(document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => true)
  })

  it('leaves every action to the scene when no text field has focus', () => {
    const readText = vi.fn(async () => 'x')
    for (const action of ['edit-copy', 'edit-cut', 'edit-select-all', 'edit-paste', 'edit-paste-in-place']) {
      expect(handleTextFieldMenuAction(action, readText)).toBe(false)
    }
    expect(document.execCommand).not.toHaveBeenCalled()
    expect(readText).not.toHaveBeenCalled()
  })

  it("forwards copy, cut and select-all to the field's editing commands", () => {
    focusedInput()
    const readText = vi.fn(async () => 'x')
    expect(handleTextFieldMenuAction('edit-copy', readText)).toBe(true)
    expect(handleTextFieldMenuAction('edit-cut', readText)).toBe(true)
    expect(handleTextFieldMenuAction('edit-select-all', readText)).toBe(true)
    expect(vi.mocked(document.execCommand).mock.calls.map((c) => c[0])).toEqual(['copy', 'cut', 'selectAll'])
    expect(readText).not.toHaveBeenCalled()
  })

  it('pastes clipboard text into the field and swallows Paste In Place there', async () => {
    focusedInput()
    const readText = vi.fn(async () => 'Wall A')
    expect(handleTextFieldMenuAction('edit-paste', readText)).toBe(true)
    await Promise.resolve(); await Promise.resolve()
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'Wall A')
    expect(handleTextFieldMenuAction('edit-paste-in-place', readText)).toBe(true)
    expect(handleTextFieldMenuAction('undo', readText)).toBe(false)
  })
})
