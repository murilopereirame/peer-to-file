import React from 'react'
import { View, Text } from 'react-native'
import { useApp } from '../context/AppContext'

export function ConnectionBadge (): React.JSX.Element {
  const { connected, colors, serverUrl } = useApp()
  const color = connected ? colors.success : colors.danger
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color: colors.textMuted, fontSize: 12 }} numberOfLines={1}>
        {connected ? 'Connected' : 'Disconnected'} · {serverUrl.replace(/^https?:\/\//, '')}
      </Text>
    </View>
  )
}
