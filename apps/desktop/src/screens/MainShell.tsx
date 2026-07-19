import React, { useEffect, useRef, useState } from 'react'
import { notifyOS } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { DownloadsProvider, useDownloads } from '../context/DownloadsContext'
import { UploadsProvider, useUploads } from '../context/UploadsContext'
import { ToastProvider, useToast } from '../context/ToastContext'
import { setSystemKeepAwake } from '../lib/electronApi'
import { ConnectionBadge } from '../components/ConnectionBadge'
import { BrowserScreen } from './BrowserScreen'
import { DownloadsScreen } from './DownloadsScreen'
import { HistoryScreen } from './HistoryScreen'
import { LogsScreen } from './LogsScreen'
import { SettingsScreen } from './SettingsScreen'

type Tab = 'browse' | 'transfers' | 'history' | 'logs' | 'settings'

const TABS: Array<{ key: Tab, label: string }> = [
  { key: 'browse', label: 'Browse' },
  { key: 'transfers', label: 'Transfers' },
  { key: 'history', label: 'History' },
  { key: 'logs', label: 'Logs' },
  { key: 'settings', label: 'Settings' }
]

function TabBar ({ active, onChange }: { active: Tab, onChange: (t: Tab) => void }): React.JSX.Element {
  const { downloads } = useDownloads()
  const busyCount = downloads.filter(d => d.status === 'downloading' || d.status === 'paused' || d.status === 'preparing').length
  return (
    <nav className="tabs">
      {TABS.map(tab => (
        <button key={tab.key} className={`tab ${active === tab.key ? 'active' : ''}`} onClick={() => onChange(tab.key)}>
          {tab.label}{tab.key === 'transfers' && busyCount > 0 ? ` (${busyCount})` : ''}
        </button>
      ))}
    </nav>
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

function Shell (): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('browse')
  useDownloadCompletionNotifier()
  useKeepAwake()
  return (
    <div className="app-shell">
      <header className="app-header">
        <strong>P2File</strong>
        <ConnectionBadge />
      </header>
      <main className="app-main">
        <div className="app-main-inner">
          {tab === 'browse' && <BrowserScreen />}
          {tab === 'transfers' && <DownloadsScreen />}
          {tab === 'history' && <HistoryScreen />}
          {tab === 'logs' && <LogsScreen />}
          {tab === 'settings' && <SettingsScreen />}
        </div>
      </main>
      <TabBar active={tab} onChange={setTab} />
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
