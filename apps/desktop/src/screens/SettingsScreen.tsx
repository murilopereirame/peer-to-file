import React, { useEffect, useState } from 'react'
import { errMessage } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { pickDownloadFolder, settings } from '../lib/electronApi'
import { Button, Card, ErrorText, Input, Muted, Title } from '../components/Primitives'
import { ConnectionBadge } from '../components/ConnectionBadge'

export function SettingsScreen (): React.JSX.Element {
  const app = useApp()
  const [serverInput, setServerInput] = useState(app.serverUrl)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [askBeforeSave, setAskBeforeSave] = useState(false)

  useEffect(() => { setServerInput(app.serverUrl) }, [app.serverUrl])
  useEffect(() => { void settings.getAskBeforeSave().then(setAskBeforeSave) }, [])

  const onSetAskBeforeSave = async (value: boolean): Promise<void> => {
    setAskBeforeSave(value)
    await settings.setAskBeforeSave(value)
  }

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
    try {
      const dir = await pickDownloadFolder()
      if (dir) await app.setDownloadDir(dir)
    } catch (err) {
      setError(errMessage(err))
    }
  }

  return (
    <div>
      <Title>Settings</Title>

      <Card style={{ marginBottom: 14 }}>
        <strong>Connection</strong>
        <div style={{ marginTop: 8 }}><ConnectionBadge /></div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <strong>Server URL</strong>
        <div style={{ marginTop: 8 }}><Input value={serverInput} onChange={e => setServerInput(e.target.value)} /></div>
        <ErrorText>{error}</ErrorText>
        <div className="btn-row">
          <Button onClick={() => { void onSaveServer() }} loading={busy} disabled={serverInput.trim() === app.serverUrl}>Save</Button>
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <strong>Default download folder</strong>
        <Muted>{app.downloadDir ?? 'Not set'}</Muted>
        <div className="btn-row">
          <Button variant="secondary" onClick={() => { void onPickFolder() }}>Choose folder…</Button>
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <strong>Saving downloads</strong>
        <Muted>Where finished downloads go — automatically into the folder above, or ask each time.</Muted>
        <div className="btn-row">
          <Button variant={!askBeforeSave ? 'primary' : 'secondary'} onClick={() => { void onSetAskBeforeSave(false) }}>
            Save automatically
          </Button>
          <Button variant={askBeforeSave ? 'primary' : 'secondary'} onClick={() => { void onSetAskBeforeSave(true) }}>
            Ask each time
          </Button>
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <strong>Keep the machine awake during transfers</strong>
        <Muted>Prevents the system from sleeping while a download or upload is running. Off by default.</Muted>
        <div className="btn-row">
          <Button variant={!app.keepAwakeDuringTransfers ? 'primary' : 'secondary'} onClick={() => { void app.setKeepAwakeDuringTransfersPref(false) }}>
            Disabled
          </Button>
          <Button variant={app.keepAwakeDuringTransfers ? 'primary' : 'secondary'} onClick={() => { void app.setKeepAwakeDuringTransfersPref(true) }}>
            Enabled
          </Button>
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <strong>Appearance</strong>
        <div className="btn-row">
          {(['System', 'Light', 'Dark'] as const).map(opt => {
            const mode = opt === 'System' ? null : opt.toLowerCase() as 'light' | 'dark'
            const active = app.themeOverride === mode
            return (
              <Button key={opt} variant={active ? 'primary' : 'secondary'} onClick={() => { void app.setThemeOverridePref(mode) }}>
                {opt}
              </Button>
            )
          })}
        </div>
      </Card>

      <Card>
        <strong>Account</strong>
        <div className="btn-row">
          <Button variant="danger" onClick={() => { void app.logout() }}>Disconnect (log out)</Button>
          <Button variant="secondary" onClick={() => { void app.changeServer() }}>Forget this server</Button>
        </div>
      </Card>
    </div>
  )
}
