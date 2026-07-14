import React, { useState } from 'react'
import { formatBytes, formatDuration } from '@p2f/shared'
import { useDownloads } from '../context/DownloadsContext'
import { useUploads } from '../context/UploadsContext'
import type { DownloadSnapshot } from '../lib/torrentDownloads'
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

function averageSpeed (entry: DownloadSnapshot): string {
  if (entry.elapsedMs <= 0 || entry.downloaded <= 0) return '—'
  return `${formatBytes(entry.downloaded / (entry.elapsedMs / 1000))}/s`
}

function DownloadDetails ({ entry }: { entry: DownloadSnapshot }): React.JSX.Element {
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--color-border)', fontSize: 13 }}>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', margin: 0 }}>
        <dt className="muted">Info hash</dt><dd style={{ wordBreak: 'break-all' }}>{entry.infoHash ?? '—'}</dd>
        <dt className="muted">Elapsed</dt><dd>{formatDuration(entry.elapsedMs)}</dd>
        <dt className="muted">Average speed</dt><dd>{averageSpeed(entry)}</dd>
        <dt className="muted">Size</dt><dd>{formatBytes(entry.length)}</dd>
        {entry.savedTo && (<><dt className="muted">Saved to</dt><dd style={{ wordBreak: 'break-all' }}>{entry.savedTo}</dd></>)}
      </dl>
      <div className="muted" style={{ marginTop: 8 }}>Peers ({entry.peers.length})</div>
      {entry.peers.length === 0
        ? <Muted>no active peers</Muted>
        : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0' }}>
            {entry.peers.map((peer, i) => (
              <li key={i} style={{ display: 'flex', gap: 10, padding: '3px 0' }}>
                <span className="muted" style={{ width: 60 }}>{peer.type}</span>
                <span style={{ flex: 1 }}>{peer.addr}</span>
                <span className="muted">{formatBytes(peer.speedBytesPerSec)}/s</span>
              </li>
            ))}
          </ul>
          )}
    </div>
  )
}

export function DownloadsScreen (): React.JSX.Element {
  const downloads = useDownloads()
  const uploads = useUploads()
  const [detailsFor, setDetailsFor] = useState<string | null>(null)

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
            <button className="link-btn muted" onClick={() => setDetailsFor(detailsFor === d.path ? null : d.path)}>
              {detailsFor === d.path ? 'Hide details' : 'Details'}
            </button>
          </div>
          {detailsFor === d.path && <DownloadDetails entry={d} />}
        </Card>
      ))}
    </div>
  )
}
