import React from 'react'
import { useApp } from '../context/AppContext'

export function ConnectionBadge (): React.JSX.Element {
  const { connected, serverUrl } = useApp()
  return (
    <div className="badge">
      <span className="dot" style={{ background: connected ? 'var(--color-success)' : 'var(--color-danger)' }} />
      {connected ? 'Connected' : 'Disconnected'} · {serverUrl.replace(/^https?:\/\//, '')}
    </div>
  )
}
