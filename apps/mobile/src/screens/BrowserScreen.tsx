import React, { useCallback, useEffect, useState } from 'react'
import { FlatList, Modal, RefreshControl, Text, TouchableOpacity, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { errMessage, joinPath, parentPath, type DirEntry, type Listing } from '@p2f/shared'
import { useApp, withUnauthorizedRetry } from '../context/AppContext'
import { useDownloads } from '../context/DownloadsContext'
import { useUploads } from '../context/UploadsContext'
import { Button, Card, ErrorText, Label, Screen, Title } from '../components/Primitives'
import { Breadcrumbs } from '../components/Breadcrumbs'
import { EntryRow } from '../components/EntryRow'
import { TextPromptModal } from '../components/TextPromptModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { FolderPickerModal } from '../components/FolderPickerModal'

export function BrowserScreen (): React.JSX.Element {
  const app = useApp()
  const downloads = useDownloads()
  const uploads = useUploads()
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [menuEntry, setMenuEntry] = useState<DirEntry | null>(null)
  const [renaming, setRenaming] = useState<DirEntry | null>(null)
  const [moving, setMoving] = useState<DirEntry | null>(null)
  const [deleting, setDeleting] = useState<DirEntry | null>(null)

  const load = useCallback(async (p: string): Promise<void> => {
    if (!app.client) return
    setError('')
    try {
      const l = await withUnauthorizedRetry(app, () => app.client!.list(p))
      setListing(l)
      setPath(p)
    } catch (err) {
      setError(errMessage(err))
    }
  }, [app])

  useEffect(() => { void load('') }, [load])

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true)
    await load(path)
    setRefreshing(false)
  }

  const onUpload = async (): Promise<void> => {
    if (!app.client) return
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (result.canceled) return
    for (const asset of result.assets) {
      uploads.start(path, asset.uri, asset.name, () => { void load(path) })
    }
  }

  const entries = listing?.entries ?? []

  return (
    <Screen style={{ padding: 16 }}>
      <Title>Browse</Title>
      <Breadcrumbs path={path} onNavigate={p => { void load(p) }} />
      <ErrorText>{error}</ErrorText>
      <FlatList
        data={entries}
        keyExtractor={e => e.name}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh() }} />}
        ListEmptyComponent={<Label muted>This folder is empty.</Label>}
        renderItem={({ item }) => (
          <EntryRow
            entry={item}
            onOpen={() => { if (item.type === 'dir') void load(joinPath(path, item.name)) }}
            onDownload={() => { downloads.start({ path: joinPath(path, item.name), name: item.name, size: item.size }) }}
            onMenu={() => setMenuEntry(item)}
          />
        )}
      />
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        {path !== '' && <View style={{ flex: 1 }}><Button title="Up one level" variant="secondary" onPress={() => { void load(parentPath(path)) }} /></View>}
        <View style={{ flex: 1 }}><Button title="Upload files" onPress={() => { void onUpload() }} /></View>
      </View>

      <ActionSheet
        entry={menuEntry}
        onClose={() => setMenuEntry(null)}
        onRename={e => { setMenuEntry(null); setRenaming(e) }}
        onMove={e => { setMenuEntry(null); setMoving(e) }}
        onDelete={e => { setMenuEntry(null); setDeleting(e) }}
      />

      <TextPromptModal
        visible={!!renaming}
        title={`Rename "${renaming?.name ?? ''}"`}
        initialValue={renaming?.name ?? ''}
        onCancel={() => setRenaming(null)}
        onConfirm={async (name) => {
          if (!renaming || !app.client) return
          await withUnauthorizedRetry(app, () => app.client!.move(joinPath(path, renaming.name), joinPath(path, name)))
          setRenaming(null)
          await load(path)
        }}
      />

      <FolderPickerModal
        visible={!!moving}
        startPath={path}
        onCancel={() => setMoving(null)}
        onPick={async (destDir) => {
          if (!moving || !app.client) return
          await withUnauthorizedRetry(app, () => app.client!.move(joinPath(path, moving.name), joinPath(destDir, moving.name)))
          setMoving(null)
          await load(path)
        }}
      />

      <ConfirmModal
        visible={!!deleting}
        title={`Delete "${deleting?.name ?? ''}"?`}
        message="This is immediate and permanent. If it's a folder, everything inside it is deleted too."
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting || !app.client) return
          await withUnauthorizedRetry(app, () => app.client!.deleteEntry(joinPath(path, deleting.name)))
          setDeleting(null)
          await load(path)
        }}
      />
    </Screen>
  )
}

function ActionSheet ({
  entry, onClose, onRename, onMove, onDelete
}: {
  entry: DirEntry | null
  onClose: () => void
  onRename: (e: DirEntry) => void
  onMove: (e: DirEntry) => void
  onDelete: (e: DirEntry) => void
}): React.JSX.Element {
  const { colors } = useApp()
  return (
    <Modal visible={!!entry} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={{ flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' }} onPress={onClose}>
        <Card style={{ backgroundColor: colors.surface, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
          <Title>{entry?.name}</Title>
          {(['Rename', 'Move', 'Delete'] as const).map(action => (
            <TouchableOpacity
              key={action}
              onPress={() => { if (!entry) return; if (action === 'Rename') onRename(entry); else if (action === 'Move') onMove(entry); else onDelete(entry) }}
              style={{ paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border }}
            >
              <Text style={{ color: action === 'Delete' ? colors.danger : colors.text, fontSize: 16 }}>{action}</Text>
            </TouchableOpacity>
          ))}
        </Card>
      </TouchableOpacity>
    </Modal>
  )
}
