import { useCallback, useEffect, useState } from 'react'
import type { AdminMount, AdminUser, Role } from '@p2f/shared'
import { useApi } from '../context/ApiContext'
import { useMount } from '../context/MountContext'
import { useToast } from '../context/ToastContext'
import { errMessage, HttpError } from '../lib/format'
import {
  FolderPlusIcon, HardDriveIcon, KeyIcon, RefreshIcon, ShieldIcon, StarIcon, TrashIcon, UserMinusIcon,
  UserPlusIcon, UsersIcon
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

  const setDefaultMount = (username: string, mountId: number | null, mountName: string): void => {
    setBusy(true)
    void (async () => {
      try {
        await apiFetch(`/api/admin/users/${encodeURIComponent(username)}/default-mount`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mountId })
        })
        notify(mountId === null ? `"${username}"'s default mount reset to the global default` : `"${username}"'s default mount set to "${mountName}"`)
        await load()
      } catch (err) {
        notify(err instanceof HttpError ? err.message : errMessage(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  const deleteUser = (user: AdminUser): void => {
    if (!window.confirm(`Delete the user "${user.username}"?\n\nThis revokes all of their sessions and mount access grants — it can't be undone.`)) return
    setBusy(true)
    void (async () => {
      try {
        await apiFetch(`/api/admin/users/${encodeURIComponent(user.username)}`, { method: 'DELETE' })
        notify(`User "${user.username}" deleted`)
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

  const allowAccess = (mount: AdminMount, userId: number, username: string): void => {
    setBusy(true)
    void (async () => {
      try {
        await apiFetch(`/api/admin/mounts/${mount.id}/deny/${userId}`, { method: 'DELETE' })
        notify(`Restored "${username}"'s access to the default mount "${mount.name}"`)
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
      <UsersCard
        users={visibleUsers} mounts={mounts} loading={users === null} busy={busy} onSetRole={setRole}
        onCreated={() => { void load() }}
        onDelete={deleteUser}
        onSetDefaultMount={setDefaultMount}
      />
      <MountsCard
        mounts={visibleMounts} users={users} loading={mounts === null} busy={busy}
        onCreated={() => { void load(); void refreshMounts() }}
        onDelete={deleteMount}
        onGranted={() => { void load(); void refreshMounts() }}
        onRevoke={revokeAccess}
        onDenied={() => { void load(); void refreshMounts() }}
        onAllowed={allowAccess}
      />
    </>
  )
}

function UsersCard ({
  users, mounts, loading, busy, onSetRole, onCreated, onDelete, onSetDefaultMount
}: {
  users: AdminUser[] | undefined
  mounts: AdminMount[] | null
  loading: boolean
  busy: boolean
  onSetRole: (username: string, role: 'user' | 'admin') => void
  onCreated: () => void
  onDelete: (user: AdminUser) => void
  onSetDefaultMount: (username: string, mountId: number | null, mountName: string) => void
}): React.JSX.Element {
  const { apiFetch } = useApi()
  const notify = useToast()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const createUser = (): void => {
    if (creating || !username.trim() || !password) return
    setCreating(true)
    setCreateError(null)
    void (async () => {
      try {
        await apiFetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.trim(), password, role })
        })
        notify(`User "${username.trim()}" created`)
        setUsername('')
        setPassword('')
        setRole('user')
        onCreated()
      } catch (err) {
        setCreateError(errMessage(err))
      } finally {
        setCreating(false)
      }
    })()
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          <UsersIcon size={15} />
          Users
          {users && <span className="muted-count">{users.length}</span>}
        </h2>
      </div>

      <div className="card-body admin-mount-create">
        <input
          type="text" placeholder="username" value={username} disabled={creating}
          onChange={e => setUsername(e.target.value)}
        />
        <input
          type="password" placeholder="password (min 12 characters)" value={password} disabled={creating}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createUser() }}
        />
        <select value={role} disabled={creating} onChange={e => setRole(e.target.value as Role)}>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <button type="button" className="btn primary sm" disabled={creating || !username.trim() || !password} onClick={createUser}>
          <UserPlusIcon size={13} />
          Add user
        </button>
      </div>
      {createError && <div className="entry-error admin-mount-create-error">{createError}</div>}

      <ul className="admin-list">
        {loading && <li className="empty loading">loading…</li>}
        {!loading && users?.length === 0 && <li className="empty">no users match this filter</li>}
        {!loading && users?.map(u => (
          <li key={u.id} className="admin-row">
            <span className="admin-row-main">
              <strong>{u.username}</strong>
              <span className={`badge${u.role === 'admin' ? ' accent' : ''}`}>{u.role}</span>
              {u.defaultMountId !== null && (
                <span className="hint-inline">
                  default: {mounts?.find(m => m.id === u.defaultMountId)?.name ?? 'unknown mount'}
                </span>
              )}
            </span>
            <span className="admin-row-actions">
              <span className="admin-default-mount-picker">
                <StarIcon size={13} />
                <select
                  aria-label={`default mount for ${u.username}`}
                  value={u.defaultMountId ?? ''}
                  disabled={busy || !mounts || mounts.length === 0}
                  onChange={e => {
                    const value = e.target.value
                    if (value === '') { onSetDefaultMount(u.username, null, ''); return }
                    const mount = mounts?.find(m => m.id === Number(value))
                    if (mount) onSetDefaultMount(u.username, mount.id, mount.name)
                  }}
                >
                  <option value="">global default</option>
                  {mounts?.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </span>
              <button
                type="button" className="btn outline sm" disabled={busy}
                onClick={() => onSetRole(u.username, u.role === 'admin' ? 'user' : 'admin')}
              >
                <ShieldIcon size={13} />
                {u.role === 'admin' ? 'Demote to user' : 'Promote to admin'}
              </button>
              <button type="button" className="btn danger sm" disabled={busy} onClick={() => onDelete(u)}>
                <TrashIcon size={13} />
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function MountsCard ({
  mounts, users, loading, busy, onCreated, onDelete, onGranted, onRevoke, onDenied, onAllowed
}: {
  mounts: AdminMount[] | undefined
  users: AdminUser[] | null
  loading: boolean
  busy: boolean
  onCreated: () => void
  onDelete: (mount: AdminMount) => void
  onGranted: () => void
  onRevoke: (mount: AdminMount, userId: number, username: string) => void
  onDenied: () => void
  onAllowed: (mount: AdminMount, userId: number, username: string) => void
}): React.JSX.Element {
  const { apiFetch } = useApi()
  const notify = useToast()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [grantFor, setGrantFor] = useState<number | null>(null)
  const [grantUsername, setGrantUsername] = useState('')
  const [denyFor, setDenyFor] = useState<number | null>(null)
  const [denyUsername, setDenyUsername] = useState('')

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

  const denyAccess = (mount: AdminMount): void => {
    if (!denyUsername.trim()) return
    void (async () => {
      try {
        await apiFetch(`/api/admin/mounts/${mount.id}/deny`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: denyUsername.trim() })
        })
        notify(`Removed "${denyUsername.trim()}" from the default mount "${mount.name}"`)
        setDenyUsername('')
        setDenyFor(null)
        onDenied()
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
              {m.isDefault ? (
                <button type="button" className="btn outline sm" disabled={busy} onClick={() => setDenyFor(denyFor === m.id ? null : m.id)}>
                  <UserMinusIcon size={13} />
                  Remove user
                </button>
              ) : (
                <>
                  <button type="button" className="btn outline sm" disabled={busy} onClick={() => setGrantFor(grantFor === m.id ? null : m.id)}>
                    <KeyIcon size={13} />
                    Access
                  </button>
                  <button type="button" className="btn danger sm" disabled={busy} onClick={() => onDelete(m)}>
                    <TrashIcon size={13} />
                    Remove
                  </button>
                </>
              )}
            </div>
            {m.isDefault ? (
              <div className="admin-mount-access">
                {m.denials.length === 0 && <span className="hint-inline">every user has access</span>}
                {m.denials.map(d => (
                  <span key={d.user_id} className="badge admin-access-badge negative">
                    {d.username}
                    <button
                      type="button" className="icon-btn xs" aria-label={`restore ${d.username}'s access`}
                      disabled={busy} onClick={() => onAllowed(m, d.user_id, d.username)}
                    >
                      <TrashIcon size={11} />
                    </button>
                  </span>
                ))}
                {denyFor === m.id && (
                  <span className="admin-grant-form">
                    <input
                      type="text" list="admin-usernames" placeholder="username" value={denyUsername} autoFocus
                      onChange={e => setDenyUsername(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') denyAccess(m) }}
                    />
                    <button type="button" className="btn danger sm" disabled={!denyUsername.trim()} onClick={() => denyAccess(m)}>
                      Remove
                    </button>
                  </span>
                )}
              </div>
            ) : (
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
