import React, { useState } from 'react'
import { useApp } from '../context/AppContext'
import { RefreshIcon, WifiIcon, WifiOffIcon } from './icons'

export function ConnectionBadge (): React.JSX.Element {
  const { connected, serverUrl, retry } = useApp()
  const [reconnecting, setReconnecting] = useState(false)

  const onReconnect = async (): Promise<void> => {
    setReconnecting(true)
    try { await retry() } finally { setReconnecting(false) }
  }

  return (
    <div className={`conn-pill${connected ? '' : ' offline'}`}>
      <span className="conn-label">
        {connected ? <WifiIcon size={14} /> : <WifiOffIcon size={14} />}
        <span className="conn-host" title={serverUrl}>{serverUrl.replace(/^https?:\/\//, '')}</span>
      </span>
      {!connected && (
        <button
          className="icon-btn" disabled={reconnecting} title="Reconnect" aria-label="Reconnect"
          onClick={() => { void onReconnect() }}
        >
          <RefreshIcon size={14} />
        </button>
      )}
    </div>
  )
}
