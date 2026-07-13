import React, { useCallback, useEffect, useState } from 'react'
import { FlatList, Modal, Text, TouchableOpacity, View } from 'react-native'
import { errMessage, joinPath, type Listing } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { Button, Card, ErrorText, Label, Title } from './Primitives'
import { Breadcrumbs } from './Breadcrumbs'

export function FolderPickerModal ({
  visible, startPath, onCancel, onPick
}: {
  visible: boolean
  startPath: string
  onCancel: () => void
  onPick: (destPath: string) => Promise<void>
}): React.JSX.Element {
  const { client, colors } = useApp()
  const [path, setPath] = useState(startPath)
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (p: string): Promise<void> => {
    if (!client) return
    setError('')
    try {
      const l = await client.list(p)
      setListing(l)
      setPath(p)
    } catch (err) {
      setError(errMessage(err))
    }
  }, [client])

  useEffect(() => { if (visible) void load(startPath) }, [visible, startPath, load])

  const folders = listing?.entries.filter(e => e.type === 'dir') ?? []

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' }}>
        <Card style={{ backgroundColor: colors.surface, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, maxHeight: '75%' }}>
          <Title>Move to…</Title>
          <Breadcrumbs path={path} onNavigate={p => { void load(p) }} />
          <ErrorText>{error}</ErrorText>
          <FlatList
            data={folders}
            keyExtractor={f => f.name}
            style={{ maxHeight: 320 }}
            ListEmptyComponent={<Label muted>No subfolders here.</Label>}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => { void load(joinPath(path, item.name)) }}
                style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center' }}
              >
                <Text style={{ fontSize: 16, marginRight: 8 }}>📁</Text>
                <Text style={{ color: colors.text, fontSize: 15 }}>{item.name}</Text>
              </TouchableOpacity>
            )}
          />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <View style={{ flex: 1 }}><Button title="Cancel" variant="secondary" onPress={onCancel} /></View>
            <View style={{ flex: 1 }}>
              <Button
                title={`Move here${path ? ` (/${path})` : ' (root)'}`}
                loading={busy}
                onPress={() => {
                  setBusy(true)
                  onPick(path).catch(err => { setError(errMessage(err)) }).finally(() => { setBusy(false) })
                }}
              />
            </View>
          </View>
        </Card>
      </View>
    </Modal>
  )
}
