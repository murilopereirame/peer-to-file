import React from 'react'
import { formatBytes } from '@p2f/shared'
import { useDownloads } from '../context/DownloadsContext'
import { useUploads } from '../context/UploadsContext'
import { Card, ErrorText, Muted, Title } from '../components/Primitives'

function statusLabel (status: string): string {
  switch (status) {
    case 'preparing': return 'Preparing…'
    case 'downloading': return 'Downloading…'
    case 'paused': return 'Paused'
    case 'saving': return 'Saving…'
    case 'done': return 'Done'
    case 'error': return 'Failed'
    default: return status
  }
}

export function DownloadsScreen (): React.JSX.Element {
  const downloads = useDownloads()
  const uploads = useUploads()

  return (
    <div>
      <Title>Transfers</Title>

      <h3>Uploads</h3>
      {uploads.uploads.length === 0 && <Muted>No uploads yet.</Muted>}
      {uploads.uploads.map(u => (
        <Card key={u.id} style={{ marginBottom: 8 }}>
          <strong>{u.name}</strong>
          <Muted>{u.status === 'running' ? 'Uploading…' : u.status === 'done' ? 'Done' : 'Failed'}</Muted>
          <ErrorText>{u.error}</ErrorText>
          {(u.status === 'done' || u.status === 'error') && (
            <button className="link-btn muted" onClick={() => uploads.remove(u.id)}>Clear</button>
          )}
        </Card>
      ))}

      <h3 style={{ marginTop: 20 }}>Downloads</h3>
      {downloads.downloads.length === 0 && <Muted>No downloads yet — click Download next to a file in Browse.</Muted>}
      {downloads.downloads.map(d => (
        <Card key={d.path} style={{ marginBottom: 8 }}>
          <strong>{d.name}</strong>
          <Muted>
            {statusLabel(d.status)} · {formatBytes(d.downloaded)}{d.length > 0 ? ` / ${formatBytes(d.length)}` : ''}
            {d.status === 'downloading' && d.numPeers > 0 ? ` · ${d.numPeers} peer${d.numPeers === 1 ? '' : 's'} · ${formatBytes(d.speedBytesPerSec)}/s` : ''}
          </Muted>
          <ErrorText>{d.message}</ErrorText>
          {(d.status === 'downloading' || d.status === 'paused') && (
            <div className="progress-bar"><div style={{ width: `${Math.round(d.progress * 100)}%` }} /></div>
          )}
          <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
            {d.status === 'downloading' && <button className="link-btn" onClick={() => downloads.pause(d.path)}>Pause</button>}
            {d.status === 'paused' && <button className="link-btn" onClick={() => downloads.resume(d.path)}>Resume</button>}
            {(d.status === 'downloading' || d.status === 'paused') && <button className="link-btn danger" onClick={() => downloads.cancel(d.path)}>Cancel</button>}
            {(d.status === 'done' || d.status === 'error') && <button className="link-btn muted" onClick={() => downloads.remove(d.path)}>Clear</button>}
          </div>
        </Card>
      ))}
    </div>
  )
}
