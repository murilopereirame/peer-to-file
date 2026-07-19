import React, { useState } from 'react'
import { useApp } from '../context/AppContext'

export function ConnectionBadge (): React.JSX.Element {
  const { connected, serverUrl, retry } = useApp()
  const [reconnecting, setReconnecting] = useState(false)

  const onReconnect = async (): Promise<void> => {
    setReconnecting(true)
    try { await retry() } finally { setReconnecting(false) }
  }

  return (
    <div className="badge">
      <span className="dot" style={{ background: connected ? 'var(--color-success)' : 'var(--color-danger)' }} />
      {connected ? 'Connected' : 'Disconnected'} · {serverUrl.replace(/^https?:\/\//, '')}
      {!connected && (
        <button className="link-btn" disabled={reconnecting} onClick={() => { void onReconnect() }}>
          {reconnecting ? 'Reconnecting…' : 'Reconnect'}
        </button>
      )}
    </div>
  )
}
