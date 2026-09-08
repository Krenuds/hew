/**
 * ConfirmDialog — a small, generic "are you sure?" modal, styled like
 * RescaleConfirmDialog (same overlay/card tokens) but with a caller-supplied
 * heading/body/confirm label instead of that dialog's rescale-specific copy.
 * Used by the v1.1 assets lane for delete-with-usage confirmations (a
 * material used on N faces, a component definition with N instances) and
 * the Purge Unused preview.
 *
 * Escape cancels, same as RescaleConfirmDialog and StlUnitsDialog.
 */

import { useCallback, useEffect } from 'react'

interface ConfirmDialogProps {
  /** Dialog heading, e.g. "Delete material?" */
  heading: string
  /** Body content — plain text or JSX (a list, counts, …). */
  body: React.ReactNode
  /** Confirm button label, e.g. "Delete". */
  confirmLabel: string
  /** Confirm button reads as destructive (red) rather than the default accent. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--backdrop-dim, rgba(0,0,0,0.6))',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 2000,
}

const DIALOG_STYLE: React.CSSProperties = {
  background: 'var(--surface-overlay, #2a2a2a)',
  border: '1px solid var(--border-strong, #4a4a4a)',
  borderRadius: 'var(--radius-control, 6px)',
  boxShadow: 'var(--shadow-palette, 0 8px 32px rgba(0,0,0,0.6))',
  padding: '20px 24px',
  minWidth: '340px',
  maxWidth: '480px',
  fontFamily: 'var(--font-family-ui, system-ui, sans-serif)',
  color: 'var(--text-secondary, #ddd)',
}

const HEADING_STYLE: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: 'var(--text-primary, #eee)',
  marginBottom: '12px',
}

const BODY_STYLE: React.CSSProperties = {
  fontSize: 'var(--font-size-body, 13px)',
  color: 'var(--text-tertiary, #ccc)',
  marginBottom: '16px',
  lineHeight: '1.5',
}

const BUTTON_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '10px',
}

const CANCEL_BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 20px',
  background: 'var(--surface-input, #444)',
  color: 'var(--text-primary, #eee)',
  border: '1px solid var(--border-strong, transparent)',
  borderRadius: 'var(--radius-control, 4px)',
  fontSize: 'var(--font-size-menu-item, 13px)',
  fontFamily: 'var(--font-family-ui, system-ui, sans-serif)',
  cursor: 'pointer',
}

const CONFIRM_BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 20px',
  background: 'var(--accent-base, #3a5e9e)',
  color: 'var(--accent-text-strong, #fff)',
  border: 'none',
  borderRadius: 'var(--radius-control, 4px)',
  fontSize: 'var(--font-size-menu-item, 13px)',
  fontFamily: 'var(--font-family-ui, system-ui, sans-serif)',
  cursor: 'pointer',
}

const CONFIRM_BUTTON_DANGER_STYLE: React.CSSProperties = {
  ...CONFIRM_BUTTON_STYLE,
  background: 'var(--danger-base, #a33)',
}

export function ConfirmDialog({ heading, body, confirmLabel, danger = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    },
    [onCancel],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div style={OVERLAY_STYLE} onClick={onCancel}>
      <div
        style={DIALOG_STYLE}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
      >
        <div style={HEADING_STYLE}>{heading}</div>
        <div style={BODY_STYLE}>{body}</div>
        <div style={BUTTON_ROW_STYLE}>
          <button style={CANCEL_BUTTON_STYLE} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={danger ? CONFIRM_BUTTON_DANGER_STYLE : CONFIRM_BUTTON_STYLE}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
