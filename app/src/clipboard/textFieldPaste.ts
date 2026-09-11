/**
 * Text-field handling for the native Edit menu — the desktop path for
 * Edit ▸ Cut / Copy / Paste / Select All (menu click or key equivalent)
 * when a rename field or dialog input has focus.
 *
 * Why this exists: on macOS a WebKit text field has no editing key
 * equivalents of its own, so Cmd+C/X/V/A reach it only through an Edit
 * menu item. The items are Hew's own (they must also act on scene objects),
 * so when one fires with a text field focused the page has to do the text
 * edit itself. Cut/Copy/Select All map straight onto the field's editing
 * commands; Paste cannot — a page cannot read the OS clipboard by itself
 * (the async clipboard API is gated in the webview). The Tauri
 * clipboard-manager plugin reads it; `insertText` then replaces the
 * field's selection the way a native paste would, with undo history and
 * input events intact.
 *
 * Every document window (App.tsx) and auxiliary window (Settings, Library)
 * routes its `menu-action` fires through `handleTextFieldMenuAction`, so
 * the two kinds of window cannot drift.
 *
 * `readText` is injected so the logic is testable without the plugin
 * (callers pass the plugin's `readText`).
 */

/** Whether keyboard focus is in a text field (an input, a textarea, or a
 *  contenteditable) — the same typing guard the keydown effects use. */
export function isTextFieldFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  return el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true)
}

/** Run a text editing command on the focused text field and report
 *  whether one had focus (so the scene action must not run). */
export function forwardToTextField(command: 'copy' | 'cut' | 'selectAll'): boolean {
  if (!isTextFieldFocused()) return false
  document.execCommand(command)
  return true
}

export async function pasteTextIntoFocusedField(
  readText: () => Promise<string | null>,
): Promise<boolean> {
  if (!isTextFieldFocused()) return false
  const target = document.activeElement
  let text: string | null
  try {
    text = await readText()
  } catch {
    return true // the clipboard was unreadable; nothing to insert, but it was our call to make
  }
  if (text === null || text === '') return true
  // The clipboard read is an IPC round trip: if focus left the field in the
  // meantime (Escape closed the dialog, a click landed elsewhere) the text
  // must not go wherever the selection is now.
  if (document.activeElement !== target) return true
  document.execCommand('insertText', false, text)
  return true
}

/**
 * Handle an Edit-menu action that landed while a text field has focus.
 * Returns true when the field consumed it (the caller must not run the
 * scene action), false when no text field has focus or the action is not
 * a text-editing one. Paste In Place is never a text action: it is simply
 * ignored in a field (true) so it cannot reach the scene from there.
 */
export function handleTextFieldMenuAction(
  action: string,
  readText: () => Promise<string | null>,
): boolean {
  switch (action) {
    case 'edit-copy': return forwardToTextField('copy')
    case 'edit-cut': return forwardToTextField('cut')
    case 'edit-select-all': return forwardToTextField('selectAll')
    case 'edit-paste':
      if (!isTextFieldFocused()) return false
      void pasteTextIntoFocusedField(readText)
      return true
    case 'edit-paste-in-place': return isTextFieldFocused()
    default: return false
  }
}
