import React, { useCallback, useEffect, useState } from 'react'
import { errMessage, type AdminMount, type AdminUser, type Role } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { useToast } from '../context/ToastContext'
import { Button, Card, ErrorText, Input, Muted } from '../components/Primitives'
import {
  FolderPlusIcon, HardDriveIcon, KeyIcon, RefreshIcon, ShieldIcon, TrashIcon, UserPlusIcon, UsersIcon
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

export function AdminScreen (): React.JSX.Element {
  const app = useApp()
  const notify = useToast()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [mounts, setMounts] = useState<AdminMount[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!app.client) return
    setError('')
    try {
      const [u, m] = await Promise.all([app.client.adminUsers(), app.client.adminMounts()])
      setUsers(u.users)
      setMounts(m.mounts)
    } catch (err) {
      setError(errMessage(err))
    }
  }, [app.client])

  useEffect(() => { void load() }, [load])

  const setRole = (username: string, role: 'user' | 'admin'): void => {
    if (!app.client) return
    setBusy(true)
    void app.client.adminSetUserRole(username, role)
      .then(async () => {
        notify(`"${username}" is now ${role === 'admin' ? 'an admin' : 'a regular user'}`)
        await load()
        await app.refreshMounts()
      })
      .catch(err => notify(errMessage(err)))
      .finally(() => setBusy(false))
  }

  const deleteUser = (user: AdminUser): void => {
    if (!app.client) return
    if (!window.confirm(`Delete the user "${user.username}"?\n\nThis revokes all of their sessions and mount access grants — it can't be undone.`)) return
    setBusy(true)
    void app.client.adminDeleteUser(user.username)
      .then(async () => { notify(`User "${user.username}" deleted`); await load(); await app.refreshMounts() })
      .catch(err => notify(errMessage(err)))
      .finally(() => setBusy(false))
  }

  const deleteMount = (mount: AdminMount): void => {
    if (!app.client) return
    if (!window.confirm(`Remove the mount "${mount.name}"?\n\nThis only stops sharing it — nothing on disk is touched.`)) return
    setBusy(true)
    void app.client.adminDeleteMount(mount.id)
      .then(async () => { notify(`Mount "${mount.name}" removed`); await load(); await app.refreshMounts() })
      .catch(err => notify(errMessage(err)))
      .finally(() => setBusy(false))
  }

  const revokeAccess = (mount: AdminMount, userId: number, username: string): void => {
    if (!app.client) return
    setBusy(true)
    void app.client.adminRevokeMountAccess(mount.id, userId)
      .then(async () => { notify(`Revoked "${username}"'s access to "${mount.name}"`); await load(); await app.refreshMounts() })
      .catch(err => notify(errMessage(err)))
      .finally(() => setBusy(false))
  }

  if (error) {
    return (
      <Section title="Admin" icon={<ShieldIcon size={15} />}>
        <ErrorText>{error}</ErrorText>
        <Button variant="secondary" onClick={() => { void load() }}><RefreshIcon size={13} />Retry</Button>
      </Section>
    )
  }

  return (
    <>
      <UsersSection
        users={users} busy={busy} onSetRole={setRole}
        onCreated={() => { void load() }}
        onDelete={deleteUser}
      />

      <MountsSection
        mounts={mounts} users={users} busy={busy}
        onCreated={() => { void load(); void app.refreshMounts() }}
        onDelete={deleteMount}
        onGranted={() => { void load(); void app.refreshMounts() }}
        onRevoke={revokeAccess}
      />
    </>
  )
}

function UsersSection ({
  users, busy, onSetRole, onCreated, onDelete
}: {
  users: AdminUser[] | null
  busy: boolean
  onSetRole: (username: string, role: 'user' | 'admin') => void
  onCreated: () => void
  onDelete: (user: AdminUser) => void
}): React.JSX.Element {
  const app = useApp()
  const notify = useToast()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)

  const createUser = (): void => {
    if (!app.client || creating || !username.trim() || !password) return
    setCreating(true)
    setCreateError('')
    app.client.adminCreateUser(username.trim(), password, role)
      .then(() => {
        notify(`User "${username.trim()}" created`)
        setUsername('')
        setPassword('')
        setRole('user')
        onCreated()
      })
      .catch(err => setCreateError(errMessage(err)))
      .finally(() => setCreating(false))
  }

  return (
    <Section title={`Users${users ? ` (${users.length})` : ''}`} icon={<UsersIcon size={15} />}>
      <div className="btn-row" style={{ marginTop: 0, alignItems: 'center' }}>
        <Input placeholder="username" value={username} disabled={creating} onChange={e => setUsername(e.target.value)} style={{ flex: 1 }} />
        <Input
          type="password" placeholder="password (min 12 characters)" value={password} disabled={creating}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createUser() }}
          style={{ flex: 1 }}
        />
        <select className="input" value={role} disabled={creating} onChange={e => setRole(e.target.value as Role)}>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <Button className="sm" disabled={creating || !username.trim() || !password} onClick={createUser}>
          <UserPlusIcon size={13} />Add user
        </Button>
      </div>
      <ErrorText>{createError}</ErrorText>

      {users === null && <Muted>loading…</Muted>}
      {users?.map(u => (
        <div key={u.id} className="admin-row">
          <span className="admin-row-main">
            <strong>{u.username}</strong>
            <span className={`badge${u.role === 'admin' ? ' accent' : ''}`}>{u.role}</span>
          </span>
          <span className="btn-row" style={{ margin: 0 }}>
            <Button
              variant="secondary" className="sm" disabled={busy}
              onClick={() => onSetRole(u.username, u.role === 'admin' ? 'user' : 'admin')}
            >
              <ShieldIcon size={13} />
              {u.role === 'admin' ? 'Demote to user' : 'Promote to admin'}
            </Button>
            <Button variant="danger" className="sm" disabled={busy} onClick={() => onDelete(u)}>
              <TrashIcon size={13} />Delete
            </Button>
          </span>
        </div>
      ))}
    </Section>
  )
}

function MountsSection ({
  mounts, users, busy, onCreated, onDelete, onGranted, onRevoke
}: {
  mounts: AdminMount[] | null
  users: AdminUser[] | null
  busy: boolean
  onCreated: () => void
  onDelete: (mount: AdminMount) => void
  onGranted: () => void
  onRevoke: (mount: AdminMount, userId: number, username: string) => void
}): React.JSX.Element {
  const app = useApp()
  const notify = useToast()
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)
  const [grantFor, setGrantFor] = useState<number | null>(null)
  const [grantUsername, setGrantUsername] = useState('')

  const createMount = (): void => {
    if (!app.client || creating || !name.trim() || !path.trim()) return
    setCreating(true)
    setCreateError('')
    app.client.adminCreateMount(name.trim(), path.trim())
      .then(() => { notify(`Mount "${name.trim()}" created`); setName(''); setPath(''); onCreated() })
      .catch(err => setCreateError(errMessage(err)))
      .finally(() => setCreating(false))
  }

  const grantAccess = (mount: AdminMount): void => {
    if (!app.client || !grantUsername.trim()) return
    app.client.adminGrantMountAccess(mount.id, grantUsername.trim())
      .then(() => { notify(`Granted "${grantUsername.trim()}" access to "${mount.name}"`); setGrantUsername(''); setGrantFor(null); onGranted() })
      .catch(err => notify(errMessage(err)))
  }

  return (
    <Section title={`Mounts${mounts ? ` (${mounts.length})` : ''}`} icon={<HardDriveIcon size={15} />}>
      <div className="btn-row" style={{ marginTop: 0, alignItems: 'center' }}>
        <Input placeholder="name" value={name} disabled={creating} onChange={e => setName(e.target.value)} style={{ flex: 1 }} />
        <Input
          placeholder="/absolute/path/to/share" value={path} disabled={creating}
          onChange={e => setPath(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createMount() }}
          style={{ flex: 2 }}
        />
        <Button className="sm" disabled={creating || !name.trim() || !path.trim()} onClick={createMount}>
          <FolderPlusIcon size={13} />Add mount
        </Button>
      </div>
      <ErrorText>{createError}</ErrorText>

      {mounts === null && <Muted>loading…</Muted>}
      {mounts?.map(m => (
        <div key={m.id} className="admin-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className="admin-row-main" style={{ justifyContent: 'space-between', width: '100%' }}>
            <span className="admin-row-main">
              <strong>{m.name}</strong>
              {m.isDefault && <span className="badge accent">default</span>}
              <span className="muted">{m.path}</span>
            </span>
            <span className="btn-row" style={{ margin: 0 }}>
              {!m.isDefault && (
                <Button variant="secondary" className="sm" disabled={busy} onClick={() => setGrantFor(grantFor === m.id ? null : m.id)}>
                  <KeyIcon size={13} />Access
                </Button>
              )}
              {!m.isDefault && (
                <Button variant="danger" className="sm" disabled={busy} onClick={() => onDelete(m)}>
                  <TrashIcon size={13} />Remove
                </Button>
              )}
            </span>
          </div>
          {!m.isDefault && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '.4rem', marginTop: '.4rem' }}>
              {m.access.length === 0 && <span className="muted">nobody granted yet</span>}
              {m.access.map(a => (
                <span key={a.user_id} className="badge" style={{ gap: '.35rem', textTransform: 'none', fontWeight: 500 }}>
                  {a.username}
                  <button
                    type="button" className="icon-btn" style={{ width: '1.1rem', height: '1.1rem' }}
                    aria-label={`revoke ${a.username}'s access`} disabled={busy}
                    onClick={() => onRevoke(m, a.user_id, a.username)}
                  >
                    <TrashIcon size={11} />
                  </button>
                </span>
              ))}
              {grantFor === m.id && (
                <span style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
                  <Input
                    list="admin-usernames" placeholder="username" value={grantUsername} autoFocus
                    onChange={e => setGrantUsername(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') grantAccess(m) }}
                    style={{ width: '11rem', height: '1.8rem' }}
                  />
                  <Button className="sm" disabled={!grantUsername.trim()} onClick={() => grantAccess(m)}>Grant</Button>
                </span>
              )}
            </div>
          )}
        </div>
      ))}
      <datalist id="admin-usernames">
        {users?.map(u => <option key={u.id} value={u.username} />)}
      </datalist>
    </Section>
  )
}
