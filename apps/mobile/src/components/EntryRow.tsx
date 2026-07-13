import React from 'react'
import { Text, TouchableOpacity, View } from 'react-native'
import { formatBytes, formatDateTime, type DirEntry } from '@p2f/shared'
import { useApp } from '../context/AppContext'

export function EntryRow ({
  entry, onOpen, onDownload, onMenu
}: {
  entry: DirEntry
  onOpen: () => void
  onDownload: () => void
  onMenu: () => void
}): React.JSX.Element {
  const { colors } = useApp()
  return (
    <TouchableOpacity
      onPress={onOpen}
      style={{
        flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
        borderBottomWidth: 1, borderBottomColor: colors.border
      }}
    >
      <Text style={{ fontSize: 20, marginRight: 10 }}>{entry.type === 'dir' ? '📁' : '📄'}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.text, fontSize: 15 }} numberOfLines={1}>{entry.name}</Text>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>
          {entry.type === 'file' ? `${formatBytes(entry.size)} · ` : ''}{formatDateTime(entry.mtime)}
        </Text>
      </View>
      {entry.type === 'file' && (
        <TouchableOpacity onPress={onDownload} hitSlop={10} style={{ padding: 8 }}>
          <Text style={{ fontSize: 18 }}>⬇️</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={onMenu} hitSlop={10} style={{ padding: 8 }}>
        <Text style={{ fontSize: 18, color: colors.textMuted }}>⋮</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  )
}
