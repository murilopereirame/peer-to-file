import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * Hand-rolled JSON-file store instead of a dependency (electron-store v11+
 * is ESM-only and awkward to `require` from the main process's CommonJS
 * output) — same idea as the plain settings file `@tauri-apps/plugin-store`
 * gave the previous Tauri build, just written directly against `fs`.
 */
export class JsonStore {
  private data: Record<string, unknown> = {}
  private readonly file: string

  constructor (filename: string) {
    this.file = join(app.getPath('userData'), filename)
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      } catch { /* corrupt or unreadable — start fresh rather than crash the app */ }
    }
  }

  get<T> (key: string): T | undefined {
    return this.data[key] as T | undefined
  }

  set (key: string, value: unknown): void {
    this.data[key] = value
    this.persist()
  }

  delete (key: string): void {
    delete this.data[key]
    this.persist()
  }

  private persist (): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}
