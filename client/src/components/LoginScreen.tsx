import { useState, type FormEvent } from 'react'
import { useApi } from '../context/ApiContext'
import { HttpError, errMessage } from '../lib/format'

export function LoginScreen ({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { apiFetch } = useApi()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<{ msg: string, kind: '' | 'error' }>({ msg: '', kind: '' })
  const [busy, setBusy] = useState(false)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setBusy(true)
    setStatus({ msg: 'signing in…', kind: '' })
    void (async () => {
      try {
        await apiFetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        })
        setPassword('')
        setStatus({ msg: '', kind: '' })
        onDone()
      } catch (err) {
        setStatus({
          msg: err instanceof HttpError && err.status === 401 ? 'invalid credentials' : `login failed: ${errMessage(err)}`,
          kind: 'error'
        })
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <section id="login" className="card narrow">
      <h2>Sign in</h2>
      <form id="login-form" className="field-group" onSubmit={submit}>
        <input
          id="login-user" type="text" placeholder="username" autoFocus
          autoComplete="username" spellCheck={false} required
          value={username} onChange={e => setUsername(e.target.value)}
        />
        <input
          id="login-pass" type="password" placeholder="password"
          autoComplete="current-password" required
          value={password} onChange={e => setPassword(e.target.value)}
        />
        <button type="submit" className="primary block" disabled={busy}>Sign in</button>
      </form>
      <div id="login-status" className={`status ${status.kind}`}>{status.msg}</div>
    </section>
  )
}
