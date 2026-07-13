import React, { useState } from 'react'
import { errMessage } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { Button, Card, ErrorText, Input, Muted, Title } from '../components/Primitives'

export function AuthScreen ({ mode }: { mode: 'setup' | 'login' }): React.JSX.Element {
  const { completeSetup, completeLogin, changeServer, serverUrl } = useApp()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const onSubmit = async (): Promise<void> => {
    if (!username.trim() || !password) return
    setLoading(true)
    setError('')
    try {
      if (mode === 'setup') await completeSetup(username.trim(), password, remember)
      else await completeLogin(username.trim(), password, remember)
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="centered">
      <Card style={{ width: 420 }}>
        <Title>{mode === 'setup' ? 'Create the admin account' : 'Sign in'}</Title>
        <Muted>
          {mode === 'setup'
            ? `No account exists on ${serverUrl.replace(/^https?:\/\//, '')} yet — pick a username and password for the admin account.`
            : `Signed out of ${serverUrl.replace(/^https?:\/\//, '')}.`}
        </Muted>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} autoFocus />
          <Input
            placeholder="Password" type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void onSubmit() }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            Remember me on this device (stored in the OS keychain)
          </label>
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="btn-row">
          <Button variant="secondary" onClick={() => { void changeServer() }}>Different server</Button>
          <Button onClick={() => { void onSubmit() }} loading={loading} disabled={!username.trim() || !password}>
            {mode === 'setup' ? 'Create account' : 'Sign in'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
