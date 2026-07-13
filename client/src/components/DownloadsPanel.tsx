import { useState } from 'react'
import type { DownloadEntry, DownloadManager } from '../lib/downloadManager'
import { formatBytes, formatDuration } from '../lib/format'

const STATE_LABEL: Record<DownloadEntry['status'], string> = {
  preparing: 'preparing…',
  downloading: 'downloading',
  waiting: 'waiting for server…',
  paused: 'paused',
  saving: 'saving…',
  done: 'done',
  error: '' // uses entry.message instead
}

function statsText (entry: DownloadEntry): string {
  if (entry.status === 'preparing') return ''
  if (entry.status === 'error' && !entry.started) return ''
  if (entry.status === 'done') return formatBytes(entry.length)
  if (entry.status === 'paused') {
    return `${(entry.progress * 100).toFixed(1)}% · ${formatBytes(entry.downloaded)} / ${formatBytes(entry.length)}`
  }
  return `${(entry.progress * 100).toFixed(1)}% · ${formatBytes(entry.downloaded)} / ${formatBytes(entry.length)} · ` +
    `${formatBytes(entry.speedBytesPerSec)}/s · ETA ${formatDuration(entry.etaMs)} · ` +
    `${entry.numPeers} peer${entry.numPeers === 1 ? '' : 's'}`
}

export function DownloadsPanel ({ entries, manager }: { entries: DownloadEntry[], manager: DownloadManager }): React.JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <section id="downloads-panel" className="card">
      <h2>Downloads</h2>
      <ul id="downloads">
        {[...entries].reverse().map(entry => (
          <DownloadRow key={entry.path} entry={entry} manager={manager} />
        ))}
      </ul>
    </section>
  )
}

function DownloadRow ({ entry, manager }: { entry: DownloadEntry, manager: DownloadManager }): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const cssClass = entry.status === 'error' || entry.status === 'paused' || entry.status === 'done' ? entry.status : ''

  return (
    <li
      data-path={entry.path}
      data-state={entry.status}
      data-progress={entry.progress}
      data-downloaded={entry.downloaded}
      data-infohash={entry.infoHash ?? ''}
    >
      <span className="dl-name">{entry.name}</span>
      <div className="dl-bar"><div style={{ width: `${(entry.progress * 100).toFixed(1)}%` }} /></div>
      <span className="dl-stats">{statsText(entry)}</span>
      <span className={`dl-state ${cssClass}`}>{entry.status === 'error' ? entry.message : STATE_LABEL[entry.status]}</span>
      <button type="button" onClick={() => setDetailsOpen(v => !v)}>
        {detailsOpen ? 'Hide details' : 'Details'}
      </button>
      {entry.canPause && (
        <button type="button" onClick={() => manager.togglePause(entry.path)}>
          {entry.paused ? 'Resume' : 'Pause'}
        </button>
      )}
      <button type="button" onClick={() => manager.cancel(entry.path)}>
        {entry.status === 'done' ? 'Clear' : 'Cancel'}
      </button>
      {detailsOpen && <DownloadDetails entry={entry} />}
    </li>
  )
}

function averageSpeed (entry: DownloadEntry): string {
  if (entry.elapsedMs <= 0 || entry.downloaded <= 0) return '—'
  return `${formatBytes(entry.downloaded / (entry.elapsedMs / 1000))}/s`
}

function DownloadDetails ({ entry }: { entry: DownloadEntry }): React.JSX.Element {
  return (
    <div className="dl-details">
      <dl>
        <dt>Info hash</dt><dd>{entry.infoHash ?? '—'}</dd>
        <dt>Elapsed</dt><dd>{formatDuration(entry.elapsedMs)}</dd>
        <dt>Average speed</dt><dd>{averageSpeed(entry)}</dd>
        <dt>Size</dt><dd>{formatBytes(entry.length)}</dd>
      </dl>
      <div className="peers-title">Peers ({entry.peers.length})</div>
      {entry.peers.length === 0
        ? <div className="no-peers">no active peers</div>
        : (
          <ul className="peers">
            {entry.peers.map((peer, i) => (
              <li key={i}>
                <span className="peer-type">{peer.type}</span>
                <span className="peer-addr">{peer.addr}</span>
                <span className="peer-speed">{formatBytes(peer.speedBytesPerSec)}/s</span>
              </li>
            ))}
          </ul>
          )}
    </div>
  )
}
