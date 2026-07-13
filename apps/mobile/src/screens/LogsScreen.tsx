import React, { useCallback, useEffect, useState } from 'react'
import { FlatList, RefreshControl, Text } from 'react-native'
import * as Sharing from 'expo-sharing'
import { Paths } from 'expo-file-system'
import * as Legacy from 'expo-file-system/legacy'
import { errMessage, formatDateTime, type LogEntry } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { Button, Card, ErrorText, Label, Screen, Title } from '../components/Primitives'

export function LogsScreen (): React.JSX.Element {
  const app = useApp()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!app.client) return
    setError('')
    try {
      const res = await withUnauthorizedRetry(app, () => app.client!.logs({ limit: 200 }))
      setEntries(res.entries)
    } catch (err) {
      setError(errMessage(err))
    }
  }, [app])

  useEffect(() => { void load() }, [load])

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const onExport = async (): Promise<void> => {
    const text = entries.map(e => `[${formatDateTime(e.ts)}] ${e.kind}: ${e.message}`).join('\n')
    const uri = `${Paths.document.uri}p2f-logs-${Date.now()}.txt`
    await Legacy.writeAsStringAsync(uri, text, { encoding: 'utf8' })
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri)
  }

  return (
    <Screen style={{ padding: 16 }}>
      <Title>Activity logs</Title>
      <ErrorText>{error}</ErrorText>
      <FlatList
        data={entries}
        keyExtractor={e => String(e.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh() }} />}
        ListEmptyComponent={<Label muted>No activity recorded yet.</Label>}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: 6, padding: 10 }}>
            <Text style={{ color: app.colors.textMuted, fontSize: 11 }}>{formatDateTime(item.ts)} · {item.kind}</Text>
            <Text style={{ color: app.colors.text, fontSize: 13 }}>{item.message}</Text>
          </Card>
        )}
      />
      {entries.length > 0 && <Button title="Export logs" variant="secondary" onPress={() => { void onExport() }} />}
    </Screen>
  )
}
