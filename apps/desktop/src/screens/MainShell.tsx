import React, { useState } from 'react'
import { useApp } from '../context/AppContext'
import { DownloadsProvider, useDownloads } from '../context/DownloadsContext'
import { UploadsProvider } from '../context/UploadsContext'
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

function Shell (): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('browse')
  return (
    <div className="app-shell">
      <header className="app-header">
        <strong>P2File</strong>
        <ConnectionBadge />
      </header>
      <main className="app-main">
        {tab === 'browse' && <BrowserScreen />}
        {tab === 'transfers' && <DownloadsScreen />}
        {tab === 'history' && <HistoryScreen />}
        {tab === 'logs' && <LogsScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </main>
      <TabBar active={tab} onChange={setTab} />
    </div>
  )
}

export function MainShell (): React.JSX.Element {
  return (
    <DownloadsProvider>
      <UploadsProvider>
        <Shell />
      </UploadsProvider>
    </DownloadsProvider>
  )
}
