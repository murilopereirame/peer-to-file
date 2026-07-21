// User / API-token management CLI.
//
//   node src/server/cli.ts add-user <username>     (password prompted, or P2F_PASSWORD)
//   node src/server/cli.ts del-user <username>
//   node src/server/cli.ts list-users
//   node src/server/cli.ts add-token <username> [name] [--ttl <dur>]  (token printed once)
//   node src/server/cli.ts list-tokens [username]
//   node src/server/cli.ts del-token <id>
//
// --ttl accepts a duration like 90d, 12h, 30m, or 'never' (0 = never). When
// omitted, tokens default to a finite 90-day lifetime (F9).
//
// Uses the same P2F_DB path as the server (default ./p2f.db). In Docker:
//   docker compose exec peer-to-file node src/server/cli.ts add-user alice

import readline from 'node:readline'
import { Writable } from 'node:stream'
import { AuthDb } from './db.ts'

const dbPath = process.env.P2F_DB || './p2f.db'

const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

function usage (): never {
  console.error(`usage:
  cli.ts add-user <username>       create a user (password from prompt or P2F_PASSWORD)
  cli.ts del-user <username>       delete a user (and their sessions/tokens)
  cli.ts list-users                list users
  cli.ts add-token <username> [name] [--ttl <dur>]  create an API token (printed once)
  cli.ts list-tokens [username]    list API tokens
  cli.ts del-token <id>            delete an API token

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
        console.log(`${u.id}\t${u.username}\tcreated ${new Date(u.created_at).toISOString()}`)
      }
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
    default:
      usage()
  }
} finally {
  db.close()
}
