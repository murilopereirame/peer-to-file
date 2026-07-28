import { ThemeToggle } from './ThemeToggle'
import { AlertIcon, RefreshIcon } from './icons'

/** Centred, chrome-free frame for the pre-session screens (loading, first-run setup, sign in). */
export function AuthLayout ({
  status, onRetry, children
}: {
  status: { msg: string, kind: '' | 'ok' | 'error' }
  onRetry: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="auth-shell">
      <div className="auth-brand">
        <img src="/icon.png" className="logo" alt="" />
        <div>
          <h1>P2File</h1>
          <div className="tagline">self-hosted P2P file browser</div>
        </div>
      </div>

      {children}

      {status.msg !== '' && (
        <div id="conn-status" className={`status ${status.kind}`}>
          {status.kind === 'error' && <AlertIcon size={14} />} {status.msg}
          {status.kind === 'error' && (
            <button type="button" className="btn sm outline" onClick={onRetry}>
              <RefreshIcon size={13} />
              Retry
            </button>
          )}
        </div>
      )}

      <ThemeToggle />

      <p className="auth-foot">
        chunked &amp; resumable transfers via <a href="https://webtorrent.io" rel="noopener">WebTorrent</a>
      </p>
    </div>
  )
}
