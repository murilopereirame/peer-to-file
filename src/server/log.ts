export interface Logger {
  info (msg: string): void
  warn (msg: string): void
  error (msg: string): void
}

export const consoleLogger: Logger = {
  info: msg => console.log(`[p2f] ${msg}`),
  warn: msg => console.warn(`[p2f] warn: ${msg}`),
  error: msg => console.error(`[p2f] error: ${msg}`)
}

export const silentLogger: Logger = {
  info () {},
  warn () {},
  error () {}
}
