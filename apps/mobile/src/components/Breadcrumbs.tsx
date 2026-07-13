import React from 'react'
import { ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { pathSegments } from '@p2f/shared'
import { useApp } from '../context/AppContext'

export function Breadcrumbs ({ path, onNavigate }: { path: string, onNavigate: (path: string) => void }): React.JSX.Element {
  const { colors } = useApp()
  const segs = pathSegments(path)
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <TouchableOpacity onPress={() => onNavigate('')}>
          <Text style={{ color: colors.primary, fontSize: 15 }}>Root</Text>
        </TouchableOpacity>
        {segs.map((seg, i) => {
          const target = segs.slice(0, i + 1).join('/')
          const isLast = i === segs.length - 1
          return (
            <View key={target} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: colors.textMuted, marginHorizontal: 6 }}>/</Text>
              <TouchableOpacity disabled={isLast} onPress={() => onNavigate(target)}>
                <Text style={{ color: isLast ? colors.text : colors.primary, fontSize: 15, fontWeight: isLast ? '600' : '400' }}>
                  {seg}
                </Text>
              </TouchableOpacity>
            </View>
          )
        })}
      </View>
    </ScrollView>
  )
}
