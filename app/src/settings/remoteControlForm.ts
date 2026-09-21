/**
 * The shared behavior behind the "Allow remote control" row
 * (docs/agents/HEW_API.md §11.5's consent gate), used by both Settings
 * surfaces — AdvancedPane.tsx (macOS/Linux/web) and FluentSettingsPage.tsx
 * (Windows). Same reason serverForm.ts exists: the two renderings are
 * separate on purpose, but there is real state here (a persisted setting
 * plus a live session status that only the transport knows) and it must not
 * be written twice.
 */

import { useEffect, useState } from 'react'
import { isTauri } from '../io/fileHost'
import { getRemoteControl, setRemoteControl, subscribe } from './remoteControl'
import {
  getRemoteControlStatus,
  subscribeRemoteControlStatus,
  type RemoteControlStatus,
} from '../api/remoteControlStatus'

export interface RemoteControlForm {
  /** Whether the row means anything here. Only the hosted web build has a
   * bridge to reach: on the desktop a live client uses the local socket
   * (§11.2), which needs no consent gate because owner-only filesystem
   * permissions already are one. */
  available: boolean
  on: boolean
  status: RemoteControlStatus
  /** One sentence for the row beneath the checkbox — empty when there is
   * nothing worth saying (the setting is off, which the checkbox already
   * shows). */
  statusText: string
  setOn: (on: boolean) => void
}

/** The user-facing sentence for each session state. Deliberately concrete
 * about who has the session, because "it stopped working" and "another tab
 * took it" are the two failures this feature actually produces. */
export function describeRemoteControlStatus(status: RemoteControlStatus): string {
  switch (status.kind) {
    case 'off':
      return ''
    case 'connecting':
      return 'Connecting to the bridge…'
    case 'connected':
      return 'Connected. A client on the server can now drive this document.'
    case 'refused':
      return status.message
    case 'unavailable':
      return `Not connected: ${status.message}.`
  }
}

export function useRemoteControl(): RemoteControlForm {
  const [on, setOn] = useState<boolean>(() => getRemoteControl())
  const [status, setStatus] = useState<RemoteControlStatus>(() => getRemoteControlStatus())

  useEffect(() => subscribe(setOn), [])
  useEffect(() => subscribeRemoteControlStatus(setStatus), [])

  return {
    available: !isTauri,
    on,
    status,
    statusText: on ? describeRemoteControlStatus(status) : '',
    setOn: setRemoteControl,
  }
}
