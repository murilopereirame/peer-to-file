import { useCallback, useEffect, useState } from 'react'
import type { AdminMount, AdminUser } from '@p2f/shared'
import { useApi } from '../context/ApiContext'
import { useMount } from '../context/MountContext'
import { useToast } from '../context/ToastContext'
import { errMessage, HttpError } from '../lib/format'
import {
  FolderPlusIcon, HardDriveIcon, KeyIcon, RefreshIcon, ShieldIcon, TrashIcon, UsersIcon
} from './icons'

export function AdminPanel ({ search = '' }: { search?: string }): React.JSX.Element {
  const { apiFetch } = useApi()
  const { refresh: refreshMounts } = useMount()
  const notify = useToast()

  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [mounts, setMounts] = useState<AdminMount[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const [usersRes, mountsRes] = await Promise.all([
        apiFetch('/api/admin/users'),
        apiFetch('/api/admin/mounts')
      ])
      const usersBody = await usersRes.json() as { users: AdminUser[] }
      const mountsBody = await mountsRes.json() as { mounts: AdminMount[] }
      setUsers(usersBody.users)
      setMounts(mountsBody.mounts)
    } catch (err) {
      setError(errMessage(err))
    }
  }, [apiFetch])

  useEffect(() => { void load() }, [load])

  const setRole = (username: string, role: 'user' | 'admin'): void => {
    setBusy(true)
    void (async () => {
      try {
        await apiFetch(`/api/admin/users/${encodeURIComponent(username)}/role`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role })
        })
        notify(`"${username}" is now ${role === 'admin' ? 'an admin' : 'a regular user'}`)
        await load()
        void refreshMounts()
      } catch (err) {
        notify(err instanceof HttpError ? err.message : errMessage(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  const deleteMount = (mount: AdminMount): void => {
    if (!window.confirm(`Remove the mount "${mount.name}"?\n\nThis only stops sharing it — nothing on disk is touched.`)) return
    setBusy(true)
    void (async () => {
      try {
        await apiFetch(`/api/admin/mounts/${mount.id}`, { method: 'DELETE' })
        notify(`Mount "${mount.name}" removed`)
        await load()
        void refreshMounts()
      } catch (err) {
        notify(errMessage(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  const revokeAccess = (mount: AdminMount, userId: number, username: string): void => {
    setBusy(true)
    void (async () => {
      try {
        await apiFetch(`/api/admin/mounts/${mount.id}/access/${userId}`, { method: 'DELETE' })
        notify(`Revoked "${username}"'s access to "${mount.name}"`)
        await load()
        void refreshMounts()
      } catch (err) {
        notify(errMessage(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  const query = search.trim().toLowerCase()
  const visibleUsers = users?.filter(u => query === '' || u.username.toLowerCase().includes(query))
  const visibleMounts = mounts?.filter(m => query === '' || m.name.toLowerCase().includes(query))

  if (error) {
    return (
      <section className="card">
        <div className="card-body">
          <div className="entry-error">{error}</div>
          <button type="button" className="btn outline sm" onClick={() => { void load() }}>
            <RefreshIcon size={13} />
            Retry
          </button>
        </div>
      </section>
    )
  }

  return (
    <>
      <UsersCard users={visibleUsers} loading={users === null} busy={busy} onSetRole={setRole} />
      <MountsCard
        mounts={visibleMounts} users={users} loading={mounts === null} busy={busy}
        onCreated={() => { void load(); void refreshMounts() }}
        onDelete={deleteMount}
        onGranted={() => { void load(); void refreshMounts() }}
        onRevoke={revokeAccess}
      />
    </>
  )
}

function UsersCard ({
  users, loading, busy, onSetRole
}: {
  users: AdminUser[] | undefined
  loading: boolean
  busy: boolean
  onSetRole: (username: string, role: 'user' | 'admin') => void
}): React.JSX.Element {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          <UsersIcon size={15} />
          Users
          {users && <span className="muted-count">{users.length}</span>}
        </h2>
      </div>
      <ul className="admin-list">
        {loading && <li className="empty loading">loading…</li>}
        {!loading && users?.length === 0 && <li className="empty">no users match this filter</li>}
        {!loading && users?.map(u => (
          <li key={u.id} className="admin-row">
            <span className="admin-row-main">
              <strong>{u.username}</strong>
              <span className={`badge${u.role === 'admin' ? ' accent' : ''}`}>{u.role}</span>
            </span>
            <button
              type="button" className="btn outline sm" disabled={busy}
              onClick={() => onSetRole(u.username, u.role === 'admin' ? 'user' : 'admin')}
            >
              <ShieldIcon size={13} />
              {u.role === 'admin' ? 'Demote to user' : 'Promote to admin'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function MountsCard ({
  mounts, users, loading, busy, onCreated, onDelete, onGranted, onRevoke
}: {
  mounts: AdminMount[] | undefined
  users: AdminUser[] | null
  loading: boolean
  busy: boolean
  onCreated: () => void
  onDelete: (mount: AdminMount) => void
  onGranted: () => void
  onRevoke: (mount: AdminMount, userId: number, username: string) => void
}): React.JSX.Element {
  const { apiFetch } = useApi()
  const notify = useToast()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [grantFor, setGrantFor] = useState<number | null>(null)
  const [grantUsername, setGrantUsername] = useState('')

  const createMount = (): void => {
    if (creating || !name.trim() || !path.trim()) return
    setCreating(true)
    setCreateError(null)
    void (async () => {
      try {
        await apiFetch('/api/admin/mounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), path: path.trim() })
        })
        notify(`Mount "${name.trim()}" created`)
        setName('')
        setPath('')
        onCreated()
      } catch (err) {
        setCreateError(errMessage(err))
      } finally {
        setCreating(false)
      }
    })()
  }

  const grantAccess = (mount: AdminMount): void => {
    if (!grantUsername.trim()) return
    void (async () => {
      try {
        await apiFetch(`/api/admin/mounts/${mount.id}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: grantUsername.trim() })
        })
        notify(`Granted "${grantUsername.trim()}" access to "${mount.name}"`)
        setGrantUsername('')
        setGrantFor(null)
        onGranted()
      } catch (err) {
        notify(errMessage(err))
      }
    })()
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          <HardDriveIcon size={15} />
          Mounts
          {mounts && <span className="muted-count">{mounts.length}</span>}
        </h2>
      </div>

      <div className="card-body admin-mount-create">
        <input
          type="text" placeholder="name" value={name} disabled={creating}
          onChange={e => setName(e.target.value)}
        />
        <input
          type="text" placeholder="/absolute/path/to/share" value={path} disabled={creating}
          onChange={e => setPath(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createMount() }}
        />
        <button type="button" className="btn primary sm" disabled={creating || !name.trim() || !path.trim()} onClick={createMount}>
          <FolderPlusIcon size={13} />
          Add mount
        </button>
      </div>
      {createError && <div className="entry-error admin-mount-create-error">{createError}</div>}

      <ul className="admin-list">
        {loading && <li className="empty loading">loading…</li>}
        {!loading && mounts?.length === 0 && <li className="empty">no mounts match this filter</li>}
        {!loading && mounts?.map(m => (
          <li key={m.id} className="admin-row admin-row-mount">
            <div className="admin-row-main">
              <strong>{m.name}</strong>
              {m.isDefault && <span className="badge accent">default</span>}
              <span className="hint-inline">{m.path}</span>
            </div>
            <div className="admin-row-actions">
              {!m.isDefault && (
                <button type="button" className="btn outline sm" disabled={busy} onClick={() => setGrantFor(grantFor === m.id ? null : m.id)}>
                  <KeyIcon size={13} />
                  Access
                </button>
              )}
              {!m.isDefault && (
                <button type="button" className="btn danger sm" disabled={busy} onClick={() => onDelete(m)}>
                  <TrashIcon size={13} />
                  Remove
                </button>
              )}
            </div>
            {!m.isDefault && (
              <div className="admin-mount-access">
                {m.access.length === 0 && <span className="hint-inline">nobody granted yet</span>}
                {m.access.map(a => (
                  <span key={a.user_id} className="badge admin-access-badge">
                    {a.username}
                    <button
                      type="button" className="icon-btn xs" aria-label={`revoke ${a.username}'s access`}
                      disabled={busy} onClick={() => onRevoke(m, a.user_id, a.username)}
                    >
                      <TrashIcon size={11} />
                    </button>
                  </span>
                ))}
                {grantFor === m.id && (
                  <span className="admin-grant-form">
                    <input
                      type="text" list="admin-usernames" placeholder="username" value={grantUsername} autoFocus
                      onChange={e => setGrantUsername(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') grantAccess(m) }}
                    />
                    <button type="button" className="btn primary sm" disabled={!grantUsername.trim()} onClick={() => grantAccess(m)}>
                      Grant
                    </button>
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <datalist id="admin-usernames">
        {users?.map(u => <option key={u.id} value={u.username} />)}
      </datalist>
    </section>
  )
}
