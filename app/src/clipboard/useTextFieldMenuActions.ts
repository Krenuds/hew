/**
 * Auxiliary-window half of the native Edit menu: the Settings and Library
 * windows own no document, so the shell forwards only the text-editing
 * actions (Cut/Copy/Paste/Select All) to them when one of them is focused
 * (see main.rs's on_menu_event). This hook listens for those fires and
 * applies them to the focused text field. Tauri only; a no-op on the web,
 * where the browser handles text fields itself.
 */
import { useEffect } from 'react'
import { isTauri } from '../io/fileHost'
import { handleTextFieldMenuAction } from './textFieldPaste'

export function useTextFieldMenuActions(): void {
  useEffect(() => {
    if (!isTauri) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    // Window-scoped listener (NOT the module-level `listen`, whose Any
    // target also receives events emit_to'd at other windows).
    Promise.all([
      import('@tauri-apps/api/webviewWindow'),
      import('@tauri-apps/plugin-clipboard-manager'),
    ])
      .then(([{ getCurrentWebviewWindow }, { readText }]) =>
        getCurrentWebviewWindow().listen<string>('menu-action', (event) => {
          handleTextFieldMenuAction(event.payload, readText)
        }),
      )
      .then((fn) => { if (cancelled) fn(); else unlisten = fn })
      .catch(() => { /* not in Tauri, or the plugin is unavailable */ })
    return () => { cancelled = true; unlisten?.() }
  }, [])
}
