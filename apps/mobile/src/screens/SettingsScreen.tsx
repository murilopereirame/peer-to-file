import React, { useEffect, useState } from 'react'
import { Platform, View } from 'react-native'
import * as Legacy from 'expo-file-system/legacy'
import { errMessage } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { listDownloadFolderLabel } from '../lib/transfers'
import { Button, Card, ErrorText, Input, Label, Screen, Title } from '../components/Primitives'
import { ConnectionBadge } from '../components/ConnectionBadge'

export function SettingsScreen (): React.JSX.Element {
  const app = useApp()
  const [serverInput, setServerInput] = useState(app.serverUrl)
  const [folderLabel, setFolderLabel] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { void listDownloadFolderLabel(app.downloadDirUri).then(setFolderLabel) }, [app.downloadDirUri])
  useEffect(() => { setServerInput(app.serverUrl) }, [app.serverUrl])

  const onSaveServer = async (): Promise<void> => {
    if (serverInput.trim() === app.serverUrl) return
    setBusy(true)
    setError('')
    try {
      await app.connectToServer(serverInput)
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const onPickFolder = async (): Promise<void> => {
    setError('')
    try {
      const res = await Legacy.StorageAccessFramework.requestDirectoryPermissionsAsync()
      if (res.granted) await app.setDownloadDirUri(res.directoryUri)
    } catch (err) {
      setError(errMessage(err))
    }
  }

  return (
    <Screen style={{ padding: 16 }}>
      <Title>Settings</Title>

      <Card style={{ marginBottom: 14 }}>
        <Label>Connection</Label>
        <View style={{ marginTop: 8 }}><ConnectionBadge /></View>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <Label>Server URL</Label>
        <Input value={serverInput} onChangeText={setServerInput} autoCapitalize="none" autoCorrect={false} style={{ marginTop: 8 }} />
        <ErrorText>{error}</ErrorText>
        <View style={{ marginTop: 10 }}>
          <Button title="Save" onPress={() => { void onSaveServer() }} loading={busy} disabled={serverInput.trim() === app.serverUrl} />
        </View>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <Label>Default download folder</Label>
        <Label muted>{folderLabel}</Label>
        {Platform.OS === 'android'
          ? <View style={{ marginTop: 10 }}><Button title="Choose folder" variant="secondary" onPress={() => { void onPickFolder() }} /></View>
          : <Label muted>{'\n'}iOS apps can't be given free access to an arbitrary folder — finished downloads are saved to P2File's own Documents folder, visible in the Files app.</Label>}
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <Label>Appearance</Label>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          {(['System', 'Light', 'Dark'] as const).map(opt => {
            const mode = opt === 'System' ? null : opt.toLowerCase() as 'light' | 'dark'
            const active = app.themeOverride === mode
            return (
              <View key={opt} style={{ flex: 1 }}>
                <Button title={opt} variant={active ? 'primary' : 'secondary'} onPress={() => { void app.setThemeOverridePref(mode) }} />
              </View>
            )
          })}
        </View>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <Label>Account</Label>
        <View style={{ marginTop: 10, gap: 10 }}>
          <Button title="Disconnect (log out)" variant="danger" onPress={() => { void app.logout() }} />
          <Button title="Forget this server" variant="secondary" onPress={() => { void app.changeServer() }} />
        </View>
      </Card>
    </Screen>
  )
}
