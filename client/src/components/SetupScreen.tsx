import { useState, type FormEvent } from 'react'
import { useApi } from '../context/ApiContext'
import { errMessage } from '../lib/format'

export function SetupScreen ({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { apiFetch } = useApi()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
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
          body: JSON.stringify({ username, password })
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
    <section id="setup" className="card narrow">
      <h2>Create the admin account</h2>
      <p className="hint">
        No account exists yet. Choose a username and password to secure this server —
        this is the only account this screen will ever create.
      </p>
      <form id="setup-form" className="field-group" onSubmit={submit}>
        <input
          id="setup-user" type="text" placeholder="username" autoFocus
          autoComplete="username" spellCheck={false} required
          value={username} onChange={e => setUsername(e.target.value)}
        />
        <input
          id="setup-pass" type="password" placeholder="password (min. 8 characters)"
          autoComplete="new-password" minLength={8} required
          value={password} onChange={e => setPassword(e.target.value)}
        />
        <input
          id="setup-pass2" type="password" placeholder="confirm password"
          autoComplete="new-password" minLength={8} required
          value={confirm} onChange={e => setConfirm(e.target.value)}
        />
        <button type="submit" className="primary block" disabled={busy}>Create account</button>
      </form>
      <div id="setup-status" className={`status ${status.kind}`}>{status.msg}</div>
    </section>
  )
}
