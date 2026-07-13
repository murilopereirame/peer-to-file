import { invoke } from '@tauri-apps/api/core'

/**
 * The webview enforces real browser CORS, which the peer-to-file server's
 * fixed `Access-Control-Allow-Origin: *` doesn't satisfy for WebTorrent's
 * webseed (Range requests) or tracker (WebSocket) connections — see
 * src-tauri/src/proxy.rs for the full explanation. Both get routed through
 * this local, loopback-only proxy instead of the real server directly; once
 * the tracker handshake completes, the actual WebRTC data channel is a
 * direct peer-to-peer connection that never touches this proxy.
 */

let cachedPort: Promise<number> | null = null

function proxyPort (): Promise<number> {
  cachedPort ??= invoke<number>('proxy_port')
  return cachedPort
}

export async function proxiedHttp (targetUrl: string): Promise<string> {
  const port = await proxyPort()
  return `http://127.0.0.1:${port}/proxy?target=${encodeURIComponent(targetUrl)}`
}

export async function proxiedWs (targetUrl: string): Promise<string> {
  const port = await proxyPort()
  return `ws://127.0.0.1:${port}/proxy/ws?target=${encodeURIComponent(targetUrl)}`
}
