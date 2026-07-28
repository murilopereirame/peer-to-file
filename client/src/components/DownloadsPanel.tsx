import { useState } from 'react'
import type { DownloadEntry, DownloadManager } from '../lib/downloadManager'
import { formatBytes, formatDuration } from '../lib/format'
import { SPEED_HISTORY_SIZE, useSpeedHistory } from '../hooks/useSpeedHistory'
import { SpeedChart } from './SpeedChart'
import {
  ArrowDownIcon, ClockIcon, CloseIcon, DownloadIcon, GaugeIcon, InfoIcon, PauseIcon, PlayIcon, SearchIcon, UsersIcon
} from './icons'

const STATE_LABEL: Record<DownloadEntry['status'], string> = {
  preparing: 'Preparing…',
  downloading: 'Downloading',
  waiting: 'Waiting for server…',
  paused: 'Paused',
  saving: 'Saving…',
  done: 'Done',
  error: '' // uses entry.message instead
}

const STATE_TONE: Record<DownloadEntry['status'], string> = {
  preparing: '',
  downloading: 'accent',
  waiting: 'warning',
  paused: 'warning',
  saving: 'accent',
  done: 'positive',
  error: 'negative'
}

interface Stat {
  key: string
  icon: React.ReactNode
  text: string
}

/** The per-status line of numbers under the progress bar, as labelled chips. */
function stats (entry: DownloadEntry): Stat[] {
  if (entry.status === 'preparing') return []
  if (entry.status === 'error' && !entry.started) return []
  if (entry.status === 'done') {
    return [{ key: 'size', icon: <DownloadIcon size={13} />, text: formatBytes(entry.length) }]
  }
  const transferred: Stat = {
    key: 'transferred',
    icon: <DownloadIcon size={13} />,
    text: `${formatBytes(entry.downloaded)} / ${formatBytes(entry.length)}`
  }
  if (entry.status === 'paused') return [transferred]
  return [
    transferred,
    { key: 'speed', icon: <ArrowDownIcon size={13} />, text: `${formatBytes(entry.speedBytesPerSec)}/s` },
    { key: 'eta', icon: <ClockIcon size={13} />, text: `ETA ${formatDuration(entry.etaMs)}` },
    { key: 'peers', icon: <UsersIcon size={13} />, text: `${entry.numPeers} peer${entry.numPeers === 1 ? '' : 's'}` }
  ]
}

export function DownloadsPanel ({
  entries, manager, search = ''
}: {
  entries: DownloadEntry[]
  manager: DownloadManager
  /** Free-text filter from the top bar; matches the file name. */
  search?: string
}): React.JSX.Element {
  const query = search.trim().toLowerCase()
  const visible = query === '' ? entries : entries.filter(e => e.name.toLowerCase().includes(query))

  return (
    <section id="downloads-panel" className="card">
      <div className="card-head">
        <h2 className="card-title">
          <DownloadIcon size={15} />
          Downloads
          {entries.length > 0 && <span className="muted-count">{entries.length}</span>}
        </h2>
      </div>
      {entries.length === 0 && (
        <div className="empty">
          <DownloadIcon className="empty-icon" size={26} />
          no downloads yet — pick a file on the Browse view to start one
        </div>
      )}
      {entries.length > 0 && visible.length === 0 && (
        <div className="empty">
          <SearchIcon className="empty-icon" size={26} />
          no download matches &ldquo;{search.trim()}&rdquo;
        </div>
      )}
      {visible.length > 0 && (
        <ul id="downloads">
          {[...visible].reverse().map(entry => (
            <DownloadRow key={entry.path} entry={entry} manager={manager} />
          ))}
        </ul>
      )}
    </section>
  )
}

function DownloadRow ({ entry, manager }: { entry: DownloadEntry, manager: DownloadManager }): React.JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const cssClass = entry.status === 'error' || entry.status === 'paused' || entry.status === 'done' ? entry.status : ''
  const percent = (entry.progress * 100).toFixed(1)

  return (
    <li
      data-path={entry.path}
      data-state={entry.status}
      data-progress={entry.progress}
      data-downloaded={entry.downloaded}
      data-infohash={entry.infoHash ?? ''}
    >
      <div className="dl-head">
        <span className="dl-name">{entry.name}</span>
        {entry.status !== 'preparing' && entry.status !== 'error' && (
          <span className="dl-percent">{percent}%</span>
        )}
        <span
          className={`dl-state badge ${STATE_TONE[entry.status]} ${cssClass}`}
          title={entry.status === 'error' ? entry.message : undefined}
        >
          {entry.status === 'error' ? entry.message : STATE_LABEL[entry.status]}
        </span>
      </div>

      <div className="dl-bar"><div style={{ width: `${percent}%` }} /></div>

      <div className="dl-foot">
        <div className="dl-stats">
          {stats(entry).map(stat => (
            <span key={stat.key} className="stat">{stat.icon}{stat.text}</span>
          ))}
        </div>
        <div className="dl-actions">
          <button type="button" className="btn ghost sm" onClick={() => setDetailsOpen(v => !v)}>
            <InfoIcon size={13} />
            {detailsOpen ? 'Hide details' : 'Details'}
          </button>
          {entry.canPause && (
            <button type="button" className="btn outline sm" onClick={() => manager.togglePause(entry.path)}>
              {entry.paused ? <PlayIcon size={13} /> : <PauseIcon size={13} />}
              {entry.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          <button type="button" className="btn outline sm" onClick={() => manager.cancel(entry.path)}>
            <CloseIcon size={13} />
            {entry.status === 'done' ? 'Clear' : 'Cancel'}
          </button>
        </div>
      </div>

      {detailsOpen && <DownloadDetails entry={entry} />}
    </li>
  )
}

function averageSpeed (entry: DownloadEntry): string {
  if (entry.elapsedMs <= 0 || entry.downloaded <= 0) return '—'
  return `${formatBytes(entry.downloaded / (entry.elapsedMs / 1000))}/s`
}

function DownloadDetails ({ entry }: { entry: DownloadEntry }): React.JSX.Element {
  // WebTorrent leaves the last rate on a finished/paused torrent; graphing it
  // would keep drawing bandwidth that is no longer moving.
  const speed = entry.status === 'downloading' ? entry.speedBytesPerSec : 0
  // Keyed on the download's path so expanding a different row graphs that
  // one's speed rather than continuing the previous series.
  const history = useSpeedHistory(entry.path, speed, 0)

  return (
    <div className="dl-details">
      <div className="detail-block">
        <dl>
          <dt>Info hash</dt><dd>{entry.infoHash ?? '—'}</dd>
          <dt>Elapsed</dt><dd>{formatDuration(entry.elapsedMs)}</dd>
          <dt>Average speed</dt><dd className="avg-speed">{averageSpeed(entry)}</dd>
          <dt>Size</dt><dd>{formatBytes(entry.length)}</dd>
        </dl>
      </div>

      <div className="detail-block">
        <SpeedChart
          label="Speed" tone="download" compact icon={<GaugeIcon size={13} />}
          values={history.map(s => s.down)} capacity={SPEED_HISTORY_SIZE} current={speed}
        />
      </div>

      <div className="detail-block">
        <div className="peers-title"><UsersIcon size={13} />Peers ({entry.peers.length})</div>
        {entry.peers.length === 0
          ? <div className="no-peers">no active peers</div>
          : (
            <ul className="peers">
              {entry.peers.map((peer, i) => (
                <li key={i}>
                  <span className="peer-type badge accent">{peer.type}</span>
                  <span className="peer-addr">{peer.addr}</span>
                  <span className="peer-speed">{formatBytes(peer.speedBytesPerSec)}/s</span>
                </li>
              ))}
            </ul>
            )}
      </div>
    </div>
  )
}
