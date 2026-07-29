import React, { useEffect, useRef, useState } from 'react'
import { formatBytes, notifyOS } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { DownloadsProvider, useDownloads } from '../context/DownloadsContext'
import { UploadsProvider, useUploads } from '../context/UploadsContext'
import { ToastProvider, useToast } from '../context/ToastContext'
import { setSystemKeepAwake } from '../lib/electronApi'
import { useSpeedHistory } from '../hooks/useSpeedHistory'
import { ConnectionBadge } from '../components/ConnectionBadge'
import {
  ActivityIcon, ArrowDownIcon, ArrowUpIcon, FolderIcon, HistoryIcon, SettingsIcon, TerminalIcon
} from '../components/icons'
import { BrowserScreen } from './BrowserScreen'
import { DownloadsScreen } from './DownloadsScreen'
import { HistoryScreen } from './HistoryScreen'
import { LogsScreen } from './LogsScreen'
import { SettingsScreen } from './SettingsScreen'

type Tab = 'browse' | 'transfers' | 'history' | 'logs' | 'settings'

const TABS: Array<{ key: Tab, label: string, Icon: typeof FolderIcon, subtitle: string }> = [
  { key: 'browse', label: 'Browse', Icon: FolderIcon, subtitle: 'The server\'s shared folder' },
  { key: 'transfers', label: 'Transfers', Icon: ActivityIcon, subtitle: 'Downloads and uploads in flight' },
  { key: 'history', label: 'History', Icon: HistoryIcon, subtitle: 'Transfers this server has finished' },
  { key: 'logs', label: 'Logs', Icon: TerminalIcon, subtitle: 'Live server activity' },
  { key: 'settings', label: 'Settings', Icon: SettingsIcon, subtitle: 'Server, downloads and appearance' }
]

function Sidebar ({ active, onChange }: { active: Tab, onChange: (t: Tab) => void }): React.JSX.Element {
  const { downloads } = useDownloads()
  const { uploads } = useUploads()
  const busyCount =
    downloads.filter(d => d.status === 'downloading' || d.status === 'paused' || d.status === 'preparing').length +
    uploads.filter(u => u.status === 'running').length

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div>
          <strong>P2File</strong>
          <span className="tagline">self-hosted P2P files</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="views">
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            className={`nav-item${active === key ? ' active' : ''}`}
            aria-current={active === key ? 'page' : undefined}
            onClick={() => onChange(key)}
          >
            <span className="nav-label"><Icon />{label}</span>
            {key === 'transfers' && busyCount > 0 && <span className="count">{busyCount}</span>}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <ConnectionBadge />
      </div>
    </aside>
  )
}

/** Fires a toast + OS notification exactly once per download the moment it finishes, regardless of which tab is active. */
function useDownloadCompletionNotifier (): void {
  const { downloads } = useDownloads()
  const notify = useToast()
  const notifiedRef = useRef(new Set<string>())

  useEffect(() => {
    const current = new Set(downloads.map(d => d.path))
    for (const seen of notifiedRef.current) {
      if (!current.has(seen)) notifiedRef.current.delete(seen)
    }
    for (const d of downloads) {
      if (d.status === 'done' && !notifiedRef.current.has(d.path)) {
        notifiedRef.current.add(d.path)
        notify(`"${d.name}" finished downloading`)
        notifyOS('Download complete', d.name)
      }
    }
  }, [downloads, notify])
}

/** Holds the system awake (via Electron's powerSaveBlocker, see
 * electron/main.cts) for as long as a download or upload is actually in
 * flight — gated on the "keep awake during transfers" setting, which
 * defaults to off. Releases the blocker the moment nothing's active rather
 * than for the app's whole lifetime, so it never outlasts an idle app. */
function useKeepAwake (): void {
  const { keepAwakeDuringTransfers } = useApp()
  const { downloads } = useDownloads()
  const { uploads } = useUploads()

  useEffect(() => {
    if (!keepAwakeDuringTransfers) { void setSystemKeepAwake(false); return }
    const active = downloads.some(d => d.status === 'preparing' || d.status === 'downloading' || d.status === 'saving') ||
      uploads.some(u => u.status === 'running')
    void setSystemKeepAwake(active)
  }, [keepAwakeDuringTransfers, downloads, uploads])

  useEffect(() => () => { void setSystemKeepAwake(false) }, [])
}

/**
 * Live totals across every transfer: WebTorrent's per-download rate inbound,
 * the rate the main process reports as it feeds an upload to the socket
 * outbound (see UploadsContext). Read by the top bar and, once sampled, by
 * the graphs on the Transfers tab.
 */
function useTransferSpeeds (): { downSpeed: number, upSpeed: number } {
  const { downloads } = useDownloads()
  const { uploads } = useUploads()
  return {
    downSpeed: downloads.reduce((sum, d) => sum + (d.status === 'downloading' ? d.speedBytesPerSec : 0), 0),
    upSpeed: uploads.reduce((sum, u) => sum + (u.status === 'running' ? u.speedBytesPerSec : 0), 0)
  }
}

function TopBar ({ tab, downSpeed, upSpeed }: { tab: Tab, downSpeed: number, upSpeed: number }): React.JSX.Element {
  const meta = TABS.find(t => t.key === tab)

  return (
    <div className="topbar">
      <div className="topbar-title">
        <strong>{meta?.label}</strong>
        <span className="subtitle">{meta?.subtitle}</span>
      </div>
      <div className="speed-readout">
        <span className="rate down" title="Total download speed">
          <ArrowDownIcon size={15} />{formatBytes(downSpeed)}/s
        </span>
        <span className="rate up" title="Total upload speed">
          <ArrowUpIcon size={15} />{formatBytes(upSpeed)}/s
        </span>
      </div>
    </div>
  )
}

function Shell (): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('browse')
  useDownloadCompletionNotifier()
  useKeepAwake()
  const { downSpeed, upSpeed } = useTransferSpeeds()
  // Sampled app-wide (not inside the Transfers tab) so switching tabs doesn't
  // unmount the sampler and throw the graphs' history away.
  const history = useSpeedHistory('all-transfers', downSpeed, upSpeed)

  return (
    <div className="app-shell">
      <Sidebar active={tab} onChange={setTab} />
      <div className="app-body">
        <TopBar tab={tab} downSpeed={downSpeed} upSpeed={upSpeed} />
        <main className="app-main">
          <div className="app-main-inner">
            {tab === 'browse' && <BrowserScreen />}
            {tab === 'transfers' && (
              <DownloadsScreen history={history} downSpeed={downSpeed} upSpeed={upSpeed} />
            )}
            {tab === 'history' && <HistoryScreen />}
            {tab === 'logs' && <LogsScreen />}
            {tab === 'settings' && <SettingsScreen />}
          </div>
        </main>
      </div>
    </div>
  )
}

export function MainShell (): React.JSX.Element {
  return (
    <ToastProvider>
      <DownloadsProvider>
        <UploadsProvider>
          <Shell />
        </UploadsProvider>
      </DownloadsProvider>
    </ToastProvider>
  )
}
