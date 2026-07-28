import React, { useState } from 'react'
import { errMessage } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { Button, Card, ErrorText, Input, Muted } from '../components/Primitives'
import { ServerIcon } from '../components/icons'

export function ServerScreen (): React.JSX.Element {
  const { connectToServer } = useApp()
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const onConnect = async (): Promise<void> => {
    if (!url.trim()) return
    setLoading(true)
    setError('')
    try {
      await connectToServer(url)
    } catch (err) {
      setError(`Could not reach that server: ${errMessage(err)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="centered">
      <div className="auth-brand">
        <h1>P2File</h1>
        <span className="tagline">self-hosted P2P file browser</span>
      </div>
      <Card className="auth-card">
        <div className="card-head"><span className="card-title"><ServerIcon size={15} />Connect to a server</span></div>
        <div className="card-body">
        <Muted>
          peer-to-file has no built-in server discovery — enter the address of the
          peer-to-file server you (or someone on your network) is already running,
          e.g. your WireGuard peer's address.
        </Muted>
        <div style={{ marginTop: 12 }}>
          <Input
            placeholder="10.0.0.1:8000 or https://files.example.com"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void onConnect() }}
            autoFocus
          />
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="btn-row">
          <Button onClick={() => { void onConnect() }} loading={loading} disabled={!url.trim()}>Connect</Button>
        </div>
        </div>
      </Card>
    </div>
  )
}
