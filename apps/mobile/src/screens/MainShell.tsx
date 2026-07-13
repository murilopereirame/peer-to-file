import React, { useState } from 'react'
import { SafeAreaView, Text, TouchableOpacity, View } from 'react-native'
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

const TABS: Array<{ key: Tab, label: string, icon: string }> = [
  { key: 'browse', label: 'Browse', icon: '📁' },
  { key: 'transfers', label: 'Transfers', icon: '⇄' },
  { key: 'history', label: 'History', icon: '🕘' },
  { key: 'logs', label: 'Logs', icon: '📜' },
  { key: 'settings', label: 'Settings', icon: '⚙️' }
]

function TabBar ({ active, onChange }: { active: Tab, onChange: (t: Tab) => void }): React.JSX.Element {
  const { colors } = useApp()
  const downloads = useDownloads()
  const activeTransfers = downloads.downloads.filter(d => d.status === 'running' || d.status === 'paused').length
  return (
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface }}>
      {TABS.map(tab => (
        <TouchableOpacity
          key={tab.key}
          onPress={() => onChange(tab.key)}
          style={{ flex: 1, alignItems: 'center', paddingVertical: 10 }}
        >
          <Text style={{ fontSize: 18 }}>{tab.icon}{tab.key === 'transfers' && activeTransfers > 0 ? ` ${activeTransfers}` : ''}</Text>
          <Text style={{ fontSize: 11, color: active === tab.key ? colors.primary : colors.textMuted, marginTop: 2 }}>{tab.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  )
}

function Shell (): React.JSX.Element {
  const { colors } = useApp()
  const [tab, setTab] = useState<Tab>('browse')
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
        <ConnectionBadge />
      </View>
      <View style={{ flex: 1 }}>
        {tab === 'browse' && <BrowserScreen />}
        {tab === 'transfers' && <DownloadsScreen />}
        {tab === 'history' && <HistoryScreen />}
        {tab === 'logs' && <LogsScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </View>
      <TabBar active={tab} onChange={setTab} />
    </SafeAreaView>
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
