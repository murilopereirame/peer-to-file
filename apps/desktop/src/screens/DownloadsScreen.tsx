import React, { useState } from 'react'
import { formatBytes, formatDuration } from '@p2f/shared'
import { useDownloads } from '../context/DownloadsContext'
import { useUploads, type UploadEntry } from '../context/UploadsContext'
import type { DownloadSnapshot } from '../lib/torrentDownloads'
import { SpeedChart } from '../components/SpeedChart'
import { SPEED_HISTORY_SIZE, useSpeedHistory, type SpeedSample } from '../hooks/useSpeedHistory'
import {
  AlertIcon, ArrowDownIcon, ArrowUpIcon, CheckIcon, ClockIcon, DownloadIcon, GaugeIcon, UploadIcon, UsersIcon
} from '../components/icons'

function statusLabel (status: string): string {
  switch (status) {
    case 'preparing': return 'Preparing…'
    case 'downloading': return 'Downloading'
    case 'paused': return 'Paused'
    case 'saving': return 'Saving…'
    case 'done': return 'Done'
    case 'error': return 'Failed'
    default: return status
  }
}

function statusTone (status: string): string {
  switch (status) {
    case 'downloading':
    case 'saving': return 'accent'
    case 'paused': return 'warning'
    case 'done': return 'positive'
    case 'error': return 'negative'
    default: return ''
  }
}

function averageSpeed (entry: DownloadSnapshot): string {
  if (entry.elapsedMs <= 0 || entry.downloaded <= 0) return '—'
  return `${formatBytes(entry.downloaded / (entry.elapsedMs / 1000))}/s`
}

function etaLabel (entry: DownloadSnapshot): string | null {
  if (entry.status !== 'downloading' || entry.speedBytesPerSec <= 0 || entry.length <= 0) return null
  const remaining = entry.length - entry.downloaded
  if (remaining <= 0) return null
  return `ETA ${formatDuration((remaining / entry.speedBytesPerSec) * 1000)}`
}

function uploadEta (entry: UploadEntry): string | null {
  if (entry.speedBytesPerSec <= 0) return null
  const remaining = entry.size - entry.sent
  if (remaining <= 0) return null
  return `ETA ${formatDuration((remaining / entry.speedBytesPerSec) * 1000)}`
}

function checksumLabel (status: DownloadSnapshot['checksumStatus']): string {
  switch (status) {
    case 'ok': return '✓ verified against the server'
    case 'mismatch': return '⚠ mismatch — the saved file may be corrupt, try again'
    case 'verifying': return 'verifying…'
    default: return 'not verified'
  }
}

function DownloadDetails ({ entry }: { entry: DownloadSnapshot }): React.JSX.Element {
  // WebTorrent leaves the last rate on a finished/paused torrent; graphing it
  // would keep drawing bandwidth that is no longer moving.
  const speed = entry.status === 'downloading' ? entry.speedBytesPerSec : 0
  // Keyed on the download's path so expanding a different row graphs that
  // one's speed rather than continuing the previous series.
  const history = useSpeedHistory(entry.path, speed, 0)

  return (
    <div className="detail-grid">
      <div>
        <dl>
          <dt>Info hash</dt><dd>{entry.infoHash ?? '—'}</dd>
          <dt>Elapsed</dt><dd>{formatDuration(entry.elapsedMs)}</dd>
          <dt>Average speed</dt><dd>{averageSpeed(entry)}</dd>
          <dt>Size</dt><dd>{formatBytes(entry.length)}</dd>
          {entry.savedTo && (<><dt>Saved to</dt><dd>{entry.savedTo}</dd></>)}
          {entry.status === 'done' && (
            <>
              <dt>Checksum</dt>
              <dd style={{ color: entry.checksumStatus === 'mismatch' ? 'var(--negative)' : undefined }}>
                {checksumLabel(entry.checksumStatus)}
              </dd>
            </>
          )}
        </dl>
      </div>

      <div>
        <SpeedChart
          label="Speed" tone="download" compact icon={<GaugeIcon size={13} />}
          values={history.map(s => s.down)} capacity={SPEED_HISTORY_SIZE} current={speed}
        />
      </div>

      <div>
        <div className="peers-title"><UsersIcon size={13} />Peers ({entry.peers.length})</div>
        {entry.peers.length === 0
          ? <div className="muted">no active peers</div>
          : (
            <ul className="peers">
              {entry.peers.map((peer, i) => (
                <li key={i}>
                  <span className="badge accent">{peer.type}</span>
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

export function DownloadsScreen ({ history, downSpeed, upSpeed }: {
  /** Sampled up in MainShell rather than here, so the series survives a tab
   *  switch instead of restarting every time this screen mounts. */
  history: SpeedSample[]
  downSpeed: number
  upSpeed: number
}): React.JSX.Element {
  const downloads = useDownloads()
  const uploads = useUploads()
  const [detailsFor, setDetailsFor] = useState<string | null>(null)

  const activeUploads = uploads.uploads.filter(u => u.status === 'running').length

  return (
    <>
      <div className="speed-charts">
        <div className="card">
          <div className="card-body">
            <SpeedChart
              label="Download" tone="download" icon={<ArrowDownIcon size={13} />}
              values={history.map(s => s.down)} capacity={SPEED_HISTORY_SIZE} current={downSpeed}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <SpeedChart
              label="Upload" tone="upload" icon={<ArrowUpIcon size={13} />}
              values={history.map(s => s.up)} capacity={SPEED_HISTORY_SIZE} current={upSpeed}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">
            <UploadIcon size={15} />
            Uploads
            {uploads.uploads.length > 0 && <span className="muted-count">{uploads.uploads.length}</span>}
          </span>
          {activeUploads > 0 && <span className="badge accent">{activeUploads} in flight</span>}
        </div>
        {uploads.uploads.length === 0 && (
          <div className="empty">
            <UploadIcon className="empty-icon" size={26} />
            no uploads yet — send files from the Browse view
          </div>
        )}
        {uploads.uploads.map(u => (
          <div key={u.id} className="transfer-row">
            <div className="transfer-head">
              <span className="transfer-name">{u.name}</span>
              {u.status === 'running' && <span className="transfer-percent">{Math.round(u.progress * 100)}%</span>}
              <span
                className={`badge ${u.status === 'done' ? 'positive' : u.status === 'error' ? 'negative' : 'accent'}`}
                title={u.error}
              >
                {u.status === 'running' ? 'Uploading…' : u.status === 'done' ? 'Done' : 'Failed'}
              </span>
            </div>

            {u.status !== 'error' && (
              <div className={`progress-bar ${u.status === 'done' ? 'done' : ''}`}>
                <div style={{ width: `${Math.round(u.progress * 100)}%` }} />
              </div>
            )}

            {/* Actions first, labels second: `.stacked` gives the labels a
                full-width line of their own, so they sit under Clear rather
                than beside it. */}
            <div className="transfer-foot stacked">
              <div className="transfer-actions">
                {(u.status === 'done' || u.status === 'error') && (
                  <button className="link-btn muted" onClick={() => uploads.remove(u.id)}>Clear</button>
                )}
              </div>
              <div className="transfer-stats">
                {u.status !== 'error' && (
                  <span className="stat">
                    <UploadIcon size={13} />
                    {formatBytes(u.sent)} / {formatBytes(u.size)}
                  </span>
                )}
                {u.status === 'running' && (
                  <span className="stat"><ArrowUpIcon size={13} />{formatBytes(u.speedBytesPerSec)}/s</span>
                )}
                {u.status === 'running' && uploadEta(u) !== null && (
                  <span className="stat"><ClockIcon size={13} />{uploadEta(u)}</span>
                )}
                {u.status === 'error' && u.error && (
                  <span className="stat" style={{ color: 'var(--negative)' }}><AlertIcon size={13} />{u.error}</span>
                )}
                {u.status === 'done' && <span className="stat"><CheckIcon size={13} />sent to the server</span>}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <span className="card-title">
            <DownloadIcon size={15} />
            Downloads
            {downloads.downloads.length > 0 && <span className="muted-count">{downloads.downloads.length}</span>}
          </span>
        </div>
        {downloads.downloads.length === 0 && (
          <div className="empty">
            <DownloadIcon className="empty-icon" size={26} />
            no downloads yet — click Download next to a file in Browse
          </div>
        )}
        {downloads.downloads.map(d => (
          <div key={d.path} className="transfer-row">
            <div className="transfer-head">
              <span className="transfer-name">{d.name}</span>
              {d.length > 0 && d.status !== 'error' && (
                <span className="transfer-percent">{Math.round(d.progress * 100)}%</span>
              )}
              <span className={`badge ${statusTone(d.status)}`} title={d.message}>{statusLabel(d.status)}</span>
            </div>

            <div className={`progress-bar ${d.status === 'done' ? 'done' : d.status === 'paused' ? 'paused' : ''}`}>
              <div style={{ width: `${Math.round(d.progress * 100)}%` }} />
            </div>

            <div className="transfer-foot">
              <div className="transfer-stats">
                <span className="stat">
                  <DownloadIcon size={13} />
                  {formatBytes(d.downloaded)}{d.length > 0 ? ` / ${formatBytes(d.length)}` : ''}
                </span>
                {d.status === 'downloading' && (
                  <span className="stat"><ArrowDownIcon size={13} />{formatBytes(d.speedBytesPerSec)}/s</span>
                )}
                {etaLabel(d) !== null && <span className="stat"><ClockIcon size={13} />{etaLabel(d)}</span>}
                {d.status === 'downloading' && d.numPeers > 0 && (
                  <span className="stat"><UsersIcon size={13} />{d.numPeers} peer{d.numPeers === 1 ? '' : 's'}</span>
                )}
                {d.status === 'done' && d.checksumStatus === 'ok' && (
                  <span className="stat" style={{ color: 'var(--positive)' }}><CheckIcon size={13} />verified</span>
                )}
                {d.status === 'done' && d.checksumStatus === 'mismatch' && (
                  <span className="stat" style={{ color: 'var(--negative)' }}>
                    <AlertIcon size={13} />checksum mismatch
                  </span>
                )}
                {d.message !== undefined && d.message !== '' && (
                  <span className="stat" style={{ color: 'var(--negative)' }}><AlertIcon size={13} />{d.message}</span>
                )}
              </div>

              <div className="transfer-actions">
                {d.status === 'downloading' && (
                  <button className="link-btn" onClick={() => downloads.pause(d.path)}>Pause</button>
                )}
                {d.status === 'paused' && (
                  <button className="link-btn" onClick={() => downloads.resume(d.path)}>Resume</button>
                )}
                {(d.status === 'downloading' || d.status === 'paused') && (
                  <button className="link-btn danger" onClick={() => downloads.cancel(d.path)}>Cancel</button>
                )}
                {(d.status === 'done' || d.status === 'error') && (
                  <button className="link-btn muted" onClick={() => downloads.remove(d.path)}>Clear</button>
                )}
                <button className="link-btn muted" onClick={() => setDetailsFor(detailsFor === d.path ? null : d.path)}>
                  {detailsFor === d.path ? 'Hide details' : 'Details'}
                </button>
              </div>
            </div>

            {detailsFor === d.path && <DownloadDetails entry={d} />}
          </div>
        ))}
      </div>
    </>
  )
}
