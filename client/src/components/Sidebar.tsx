import { ThemeToggle } from './ThemeToggle'
import {
  ActivityIcon, FolderIcon, HistoryIcon, LogOutIcon, RefreshIcon, TerminalIcon, WifiIcon, WifiOffIcon
} from './icons'

export type View = 'browse' | 'transfers' | 'history' | 'logs'

const NAV_ITEMS: Array<{ key: View, label: string, Icon: typeof FolderIcon }> = [
  { key: 'browse', label: 'Browse', Icon: FolderIcon },
  { key: 'transfers', label: 'Transfers', Icon: ActivityIcon },
  { key: 'history', label: 'History', Icon: HistoryIcon },
  { key: 'logs', label: 'Logs', Icon: TerminalIcon }
]

export function Sidebar ({
  view, onSelect, counts, connected, onReconnect, authed, onLogout
}: {
  view: View
  onSelect: (view: View) => void
  /** Badge counts per view; a missing or zero entry renders no badge. */
  counts: Partial<Record<View, number>>
  connected: boolean
  onReconnect: () => void
  authed: boolean
  onLogout: () => void
}): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src="/icon.png" className="logo" alt="" />
        <div className="brand-text">
          <h1>P2File</h1>
          <span className="tagline">self-hosted P2P files</span>
        </div>
      </div>

      {/* Kept a `tab-bar` class alongside the sidebar one: same four views the
          old tab strip had, just laid out down the side. */}
      <nav className="sidebar-nav tab-bar" aria-label="views">
        {NAV_ITEMS.map(({ key, label, Icon }) => {
          const count = counts[key] ?? 0
          return (
            <button
              key={key}
              type="button"
              className={`nav-item${view === key ? ' active' : ''}`}
              aria-current={view === key ? 'page' : undefined}
              onClick={() => onSelect(key)}
            >
              <span className="nav-label"><Icon />{label}</span>
              {count > 0 && <span className="count">{count}</span>}
            </button>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className={`conn-pill${connected ? '' : ' offline'}`}>
          <span className="conn-label">
            {connected ? <WifiIcon size={14} /> : <WifiOffIcon size={14} />}
            <span className="conn-text">{connected ? 'Connected' : 'Disconnected'}</span>
          </span>
          {!connected && (
            <button type="button" className="icon-btn" title="Reconnect" aria-label="Reconnect" onClick={onReconnect}>
              <RefreshIcon size={14} />
            </button>
          )}
        </div>

        <ThemeToggle />

        {authed && (
          <button id="logout" type="button" className="btn ghost block" onClick={onLogout}>
            <LogOutIcon />
            <span className="label">Log out</span>
          </button>
        )}

        <p className="sidebar-note">
          chunked &amp; resumable transfers via{' '}
          <a href="https://webtorrent.io" rel="noopener">WebTorrent</a>
        </p>
      </div>
    </aside>
  )
}
