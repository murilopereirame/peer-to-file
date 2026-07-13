import React, { useCallback, useEffect, useState } from 'react'
import { FlatList, RefreshControl, Text } from 'react-native'
import { errMessage, formatBytes, formatDateTime, type HistoryEntry } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { useDownloads } from '../context/DownloadsContext'
import { Button, Card, ErrorText, Label, Screen, Title } from '../components/Primitives'

export function HistoryScreen (): React.JSX.Element {
  const app = useApp()
  const { historyVersion } = useDownloads()
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!app.client) return
    setError('')
    try {
      const res = await withUnauthorizedRetry(app, () => app.client!.historyList())
      setEntries(res.entries)
    } catch (err) {
      setError(errMessage(err))
    }
  }, [app])

  useEffect(() => { void load() }, [load, historyVersion])

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const onClear = async (): Promise<void> => {
    if (!app.client) return
    await withUnauthorizedRetry(app, () => app.client!.historyClear())
    await load()
  }

  return (
    <Screen style={{ padding: 16 }}>
      <Title>Download history</Title>
      <ErrorText>{error}</ErrorText>
      <FlatList
        data={entries}
        keyExtractor={(e, i) => `${e.path}-${e.finishedAt}-${i}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh() }} />}
        ListEmptyComponent={<Label muted>No finished downloads yet.</Label>}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: 8 }}>
            <Text style={{ color: app.colors.text, fontWeight: '600' }} numberOfLines={1}>{item.name}</Text>
            <Label muted>{formatBytes(item.length)} · {formatDateTime(item.finishedAt)}</Label>
          </Card>
        )}
      />
      {entries.length > 0 && <Button title="Clear history" variant="secondary" onPress={() => { void onClear() }} />}
    </Screen>
  )
}
