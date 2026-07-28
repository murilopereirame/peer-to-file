import React, { useEffect, useState } from 'react'
import { errMessage, type ThemeMode } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { pickDownloadFolder, settings } from '../lib/electronApi'
import { Button, ErrorText, Input, Muted } from '../components/Primitives'
import { ConnectionBadge } from '../components/ConnectionBadge'
import {
  DownloadIcon, FolderIcon, LogOutIcon, MonitorIcon, MoonIcon, ServerIcon, SettingsIcon, SunIcon
} from '../components/icons'

/** Card with the same head/body split the rest of the app uses. */
function Section ({
  title, icon, children
}: { title: string, icon: React.ReactNode, children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="card">
      <div className="card-head"><span className="card-title">{icon}{title}</span></div>
      <div className="card-body">{children}</div>
    </div>
  )
}

/** Two-or-three-way choice, styled like the web client's theme picker. */
function Segmented<T> ({
  options, value, onChange
}: {
  options: Array<{ value: T, label: string, icon?: React.ReactNode }>
  value: T
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="segmented">
      {options.map(option => (
        <button
          key={option.label}
          type="button"
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  )
}

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
    <>
      <Section title="Server" icon={<ServerIcon size={15} />}>
        <ConnectionBadge />
        <div style={{ marginTop: 12 }}>
          <Input value={serverInput} onChange={e => setServerInput(e.target.value)} />
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="btn-row">
          <Button
            onClick={() => { void onSaveServer() }} loading={busy}
            disabled={serverInput.trim() === app.serverUrl}
          >
            Save
          </Button>
        </div>
      </Section>

      <Section title="Default download folder" icon={<FolderIcon size={15} />}>
        <Muted>{app.downloadDir ?? 'Not set'}</Muted>
        <div className="btn-row">
          <Button variant="secondary" onClick={() => { void onPickFolder() }}>Choose folder…</Button>
        </div>
      </Section>

      <Section title="Saving downloads" icon={<DownloadIcon size={15} />}>
        <Muted>Where finished downloads go — automatically into the folder above, or ask each time.</Muted>
        <div style={{ marginTop: 10 }}>
          <Segmented
            value={askBeforeSave}
            onChange={value => { void onSetAskBeforeSave(value) }}
            options={[
              { value: false, label: 'Save automatically' },
              { value: true, label: 'Ask each time' }
            ]}
          />
        </div>
      </Section>

      <Section title="Keep the machine awake during transfers" icon={<SettingsIcon size={15} />}>
        <Muted>Prevents the system from sleeping while a download or upload is running. Off by default.</Muted>
        <div style={{ marginTop: 10 }}>
          <Segmented
            value={app.keepAwakeDuringTransfers}
            onChange={value => { void app.setKeepAwakeDuringTransfersPref(value) }}
            options={[
              { value: false, label: 'Disabled' },
              { value: true, label: 'Enabled' }
            ]}
          />
        </div>
      </Section>

      <Section title="Appearance" icon={<SunIcon size={15} />}>
        <Segmented<ThemeMode | null>
          value={app.themeOverride}
          onChange={mode => { void app.setThemeOverridePref(mode) }}
          options={[
            { value: null, label: 'System', icon: <MonitorIcon size={13} /> },
            { value: 'light', label: 'Light', icon: <SunIcon size={13} /> },
            { value: 'dark', label: 'Dark', icon: <MoonIcon size={13} /> }
          ]}
        />
      </Section>

      <Section title="Account" icon={<LogOutIcon size={15} />}>
        <div className="btn-row" style={{ marginTop: 0 }}>
          <Button variant="danger" onClick={() => { void app.logout() }}>Disconnect (log out)</Button>
          <Button variant="secondary" onClick={() => { void app.changeServer() }}>Forget this server</Button>
        </div>
      </Section>
    </>
  )
}
