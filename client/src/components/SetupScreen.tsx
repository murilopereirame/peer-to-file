import { useState, type FormEvent } from 'react'
import { useApi } from '../context/ApiContext'
import { errMessage } from '../lib/format'
import { AlertIcon } from './icons'

export function SetupScreen ({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { apiFetch } = useApi()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [status, setStatus] = useState<{ msg: string, kind: '' | 'error' }>({ msg: '', kind: '' })
  const [busy, setBusy] = useState(false)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (password !== confirm) {
      setStatus({ msg: 'passwords do not match', kind: 'error' })
      return
    }
    setBusy(true)
    setStatus({ msg: 'creating account…', kind: '' })
    void (async () => {
      try {
        await apiFetch('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, setupToken })
        })
        setPassword('')
        setConfirm('')
        setStatus({ msg: '', kind: '' })
        onDone()
      } catch (err) {
        setStatus({ msg: `could not create account: ${errMessage(err)}`, kind: 'error' })
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <section id="setup" className="card auth-card">
      <div className="card-head"><h2 className="card-title">Create the admin account</h2></div>
      <div className="card-body">
        <p className="hint">
          No account exists yet. Choose a username and password to secure this server —
          this is the only account this screen will ever create. The one-time
          <strong> setup token</strong> is printed in the server log at first boot.
        </p>
        <form id="setup-form" className="field-group" onSubmit={submit}>
          <label htmlFor="setup-token">Setup token</label>
          <input
            id="setup-token" type="text" placeholder="setup token (from the server log)" autoFocus
            autoComplete="off" spellCheck={false} required
            value={setupToken} onChange={e => setSetupToken(e.target.value)}
          />
          <label htmlFor="setup-user">Username</label>
          <input
            id="setup-user" type="text" placeholder="username"
            autoComplete="username" spellCheck={false} required
            value={username} onChange={e => setUsername(e.target.value)}
          />
          <label htmlFor="setup-pass">Password</label>
          <input
            id="setup-pass" type="password" placeholder="password (min. 12 characters)"
            autoComplete="new-password" minLength={12} required
            value={password} onChange={e => setPassword(e.target.value)}
          />
          <label htmlFor="setup-pass2">Confirm password</label>
          <input
            id="setup-pass2" type="password" placeholder="confirm password"
            autoComplete="new-password" minLength={12} required
            value={confirm} onChange={e => setConfirm(e.target.value)}
          />
          <button type="submit" className="btn primary block" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <div id="setup-status" className={`status ${status.kind}`}>
          {status.kind === 'error' && <AlertIcon size={13} />} {status.msg}
        </div>
      </div>
    </section>
  )
}
