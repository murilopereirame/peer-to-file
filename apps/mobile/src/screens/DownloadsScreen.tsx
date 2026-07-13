import React from 'react'
import { FlatList, Text, TouchableOpacity, View } from 'react-native'
import { formatBytes } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { useDownloads, type DownloadEntry } from '../context/DownloadsContext'
import { useUploads, type UploadEntry } from '../context/UploadsContext'
import { Card, Label, Screen, Title } from '../components/Primitives'

function statusLabel (status: string): string {
  switch (status) {
    case 'running': return 'Downloading…'
    case 'paused': return 'Paused'
    case 'done': return 'Done'
    case 'canceled': return 'Canceled'
    case 'error': return 'Failed'
    default: return status
  }
}

function ProgressBar ({ ratio }: { ratio: number }): React.JSX.Element {
  const { colors } = useApp()
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.surfaceAlt, overflow: 'hidden', marginTop: 6 }}>
      <View style={{ height: 6, width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`, backgroundColor: colors.primary }} />
    </View>
  )
}

function DownloadRow ({ item }: { item: DownloadEntry }): React.JSX.Element {
  const { colors } = useApp()
  const downloads = useDownloads()
  const ratio = item.totalBytes > 0 ? item.bytesWritten / item.totalBytes : 0
  return (
    <Card style={{ marginBottom: 10 }}>
      <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>{item.name}</Text>
      <Label muted>{statusLabel(item.status)} · {formatBytes(item.bytesWritten)}{item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : ''}</Label>
      {item.error && <Label muted>{item.error}</Label>}
      {(item.status === 'running' || item.status === 'paused') && <ProgressBar ratio={ratio} />}
      <View style={{ flexDirection: 'row', gap: 14, marginTop: 8 }}>
        {item.status === 'running' && <TouchableOpacity onPress={() => downloads.pause(item.id)}><Text style={{ color: colors.primary }}>Pause</Text></TouchableOpacity>}
        {item.status === 'paused' && <TouchableOpacity onPress={() => downloads.resume(item.id)}><Text style={{ color: colors.primary }}>Resume</Text></TouchableOpacity>}
        {(item.status === 'running' || item.status === 'paused') && <TouchableOpacity onPress={() => downloads.cancel(item.id)}><Text style={{ color: colors.danger }}>Cancel</Text></TouchableOpacity>}
        {(item.status === 'done' || item.status === 'error' || item.status === 'canceled') && <TouchableOpacity onPress={() => downloads.remove(item.id)}><Text style={{ color: colors.textMuted }}>Clear</Text></TouchableOpacity>}
      </View>
    </Card>
  )
}

function UploadRow ({ item }: { item: UploadEntry }): React.JSX.Element {
  const { colors } = useApp()
  const uploads = useUploads()
  const ratio = item.totalBytes > 0 ? item.bytesSent / item.totalBytes : 0
  return (
    <Card style={{ marginBottom: 10 }}>
      <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>{item.name}</Text>
      <Label muted>{statusLabel(item.status === 'running' ? 'uploading' : item.status) === 'uploading' ? 'Uploading…' : statusLabel(item.status)} · {formatBytes(item.bytesSent)}{item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : ''}</Label>
      {item.error && <Label muted>{item.error}</Label>}
      {item.status === 'running' && <ProgressBar ratio={ratio} />}
      {(item.status === 'done' || item.status === 'error') && (
        <TouchableOpacity onPress={() => uploads.remove(item.id)} style={{ marginTop: 8 }}>
          <Text style={{ color: colors.textMuted }}>Clear</Text>
        </TouchableOpacity>
      )}
    </Card>
  )
}

export function DownloadsScreen (): React.JSX.Element {
  const downloads = useDownloads()
  const uploads = useUploads()

  return (
    <Screen style={{ padding: 16 }}>
      <Title>Transfers</Title>
      <Label muted>Uploads</Label>
      <FlatList
        data={uploads.uploads}
        keyExtractor={u => u.id}
        style={{ marginTop: 8, marginBottom: 16, maxHeight: 260 }}
        ListEmptyComponent={<Label muted>No uploads yet.</Label>}
        renderItem={({ item }) => <UploadRow item={item} />}
      />
      <Label muted>Downloads</Label>
      <FlatList
        data={downloads.downloads}
        keyExtractor={d => d.id}
        style={{ marginTop: 8 }}
        ListEmptyComponent={<Label muted>No downloads yet — tap ⬇️ next to a file in Browse.</Label>}
        renderItem={({ item }) => <DownloadRow item={item} />}
      />
    </Screen>
  )
}
