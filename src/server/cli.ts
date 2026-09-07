// User / API-token / mount management CLI.
//
//   node src/server/cli.ts add-user <username>     (password prompted, or P2F_PASSWORD)
//   node src/server/cli.ts del-user <username>
//   node src/server/cli.ts list-users
//   node src/server/cli.ts set-role <username> <user|admin>
//   node src/server/cli.ts add-token <username> [name] [--ttl <dur>]  (token printed once)
//   node src/server/cli.ts list-tokens [username]
//   node src/server/cli.ts del-token <id>
//   node src/server/cli.ts list-mounts
//   node src/server/cli.ts add-mount <name> <path>
//   node src/server/cli.ts del-mount <name>
//   node src/server/cli.ts grant-mount <name> <username>
//   node src/server/cli.ts revoke-mount <name> <username>
//
// --ttl accepts a duration like 90d, 12h, 30m, or 'never' (0 = never). When
// omitted, tokens default to a finite 90-day lifetime (F9).
//
// Uses the same P2F_DB path as the server (default ./p2f.db). In Docker:
//   docker compose exec peer-to-file node src/server/cli.ts add-user alice

import readline from 'node:readline'
import { Writable } from 'node:stream'
import { AuthDb } from './db.ts'
import { resolveDirectory } from './config.ts'

const dbPath = process.env.P2F_DB || './p2f.db'

const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

function usage (): never {
  console.error(`usage:
  cli.ts add-user <username>       create a user (password from prompt or P2F_PASSWORD)
  cli.ts del-user <username>       delete a user (and their sessions/tokens)
  cli.ts list-users                list users
  cli.ts set-role <username> <user|admin>   change a user's role
  cli.ts add-token <username> [name] [--ttl <dur>]  create an API token (printed once)
  cli.ts list-tokens [username]    list API tokens
  cli.ts del-token <id>            delete an API token
  cli.ts list-mounts                        list mounts and who has access
  cli.ts add-mount <name> <path>            share an extra directory as a mount
  cli.ts del-mount <name>                   remove a (non-default) mount
  cli.ts grant-mount <name> <username>      give a user access to a mount
  cli.ts revoke-mount <name> <username>     take away a user's access to a mount

  --ttl <dur>   token lifetime: e.g. 90d, 12h, 30m, or 'never' (default 90d)

database: ${dbPath}  (override with P2F_DB)`)
  process.exit(2)
}

/** Parses a duration like 90d/12h/30m/45s, or 'never'/'0' → null (non-expiring). */
function parseTtl (value: string): number | null {
  if (value === 'never' || value === '0') return null
  const m = /^(\d+)([smhd])$/.exec(value)
  if (!m) {
    console.error(`invalid --ttl: ${value} (use e.g. 90d, 12h, 30m, or 'never')`)
    process.exit(2)
  }
  const n = Number(m[1])
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd']
  return n * unit
}

async function promptPassword (prompt: string): Promise<string> {
  if (process.env.P2F_PASSWORD) return process.env.P2F_PASSWORD
  // mask the typed password
  let muted = false
  const mutable = new Writable({
    write (chunk: Buffer, _enc, cb) {
      if (!muted) process.stdout.write(chunk)
      cb()
    }
  })
  const rl = readline.createInterface({ input: process.stdin, output: mutable, terminal: true })
  process.stdout.write(prompt)
  muted = true
  const answer = await new Promise<string>(resolve => rl.question('', resolve))
  muted = false
  rl.close()
  process.stdout.write('\n')
  return answer
}

const [command, arg1, arg2] = process.argv.slice(2)
const db = new AuthDb(dbPath)

try {
  switch (command) {
    case 'add-user': {
      if (!arg1) usage()
      const password = await promptPassword(`password for ${arg1}: `)
      const confirm = process.env.P2F_PASSWORD ?? await promptPassword('confirm password: ')
      if (password !== confirm) {
        console.error('passwords do not match')
        process.exit(1)
      }
      db.createUser(arg1, password)
      console.log(`user ${arg1} created`)
      break
    }
    case 'del-user': {
      if (!arg1) usage()
      console.log(db.deleteUser(arg1) ? `user ${arg1} deleted` : `no such user: ${arg1}`)
      break
    }
    case 'list-users': {
      for (const u of db.listUsers()) {
        console.log(`${u.id}\t${u.username}\t${u.role}\tcreated ${new Date(u.created_at).toISOString()}`)
      }
      break
    }
    case 'set-role': {
      if (!arg1 || (arg2 !== 'user' && arg2 !== 'admin')) usage()
      const target = db.getUserByUsername(arg1)
      if (!target) {
        console.error(`no such user: ${arg1}`)
        process.exit(1)
      }
      if (target.role === 'admin' && arg2 === 'user' && db.countAdmins() <= 1) {
        console.error('cannot demote the last remaining admin')
        process.exit(1)
      }
      db.setUserRole(target.id, arg2)
      console.log(`${arg1} is now ${arg2}`)
      break
    }
    case 'add-token': {
      if (!arg1) usage()
      const rest = process.argv.slice(4) // everything after `add-token <username>`
      const ttlIdx = rest.indexOf('--ttl')
      const ttlMs = ttlIdx === -1 ? DEFAULT_TOKEN_TTL_MS : parseTtl(rest[ttlIdx + 1] ?? '')
      const name = rest.find((a, i) => a !== '--ttl' && rest[i - 1] !== '--ttl') || 'cli'
      const token = db.createApiToken(arg1, name, ttlMs)
      console.log('API token (shown only once — store it now):')
      console.log(token)
      console.log(`expires: ${ttlMs === null ? 'never' : new Date(Date.now() + ttlMs).toISOString()}`)
      console.log('use it as:  Authorization: Bearer <token>')
      break
    }
    case 'list-tokens': {
      for (const t of db.listApiTokens(arg1)) {
        const lastUsed = t.last_used_at ? new Date(t.last_used_at).toISOString() : 'never'
        const expires = t.expires_at ? new Date(t.expires_at).toISOString() : 'never'
        console.log(`${t.id}\t${t.name}\tuser ${t.user_id}\tlast used ${lastUsed}\texpires ${expires}`)
      }
      break
    }
    case 'del-token': {
      if (!arg1) usage()
      console.log(db.deleteApiToken(Number(arg1)) ? `token ${arg1} deleted` : `no such token: ${arg1}`)
      break
    }
    case 'list-mounts': {
      for (const m of db.listMounts()) {
        const access = db.listMountAccess(m.id).map(a => a.username).join(', ')
        const scope = m.is_default ? 'everyone (default)' : (access || 'nobody yet')
        console.log(`${m.id}\t${m.name}\t${m.path}\t${scope}`)
      }
      break
    }
    case 'add-mount': {
      if (!arg1 || !arg2) usage()
      let resolved: string
      try {
        resolved = resolveDirectory(arg2)
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
      if (db.getMountByName(arg1)) {
        console.error(`a mount named "${arg1}" already exists`)
        process.exit(1)
      }
      try {
        db.createMount(arg1, resolved, null)
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
      console.log(`mount "${arg1}" created: ${resolved}`)
      break
    }
    case 'del-mount': {
      if (!arg1) usage()
      const mount = db.getMountByName(arg1)
      if (!mount) {
        console.error(`no such mount: ${arg1}`)
        process.exit(1)
      }
      if (mount.is_default) {
        console.error('cannot remove the default mount')
        process.exit(1)
      }
      db.deleteMount(mount.id)
      console.log(`mount "${arg1}" removed`)
      break
    }
    case 'grant-mount':
    case 'revoke-mount': {
      if (!arg1 || !arg2) usage()
      const mount = db.getMountByName(arg1)
      if (!mount) {
        console.error(`no such mount: ${arg1}`)
        process.exit(1)
      }
      const user = db.getUserByUsername(arg2)
      if (!user) {
        console.error(`no such user: ${arg2}`)
        process.exit(1)
      }
      if (command === 'grant-mount') {
        db.grantMountAccess(mount.id, user.id)
        console.log(`granted "${arg2}" access to mount "${arg1}"`)
      } else {
        db.revokeMountAccess(mount.id, user.id)
        console.log(`revoked "${arg2}"'s access to mount "${arg1}"`)
      }
      break
    }
    default:
      usage()
  }
} finally {
  db.close()
}
