/**
 * OS-level completion notifications, shared verbatim by both apps — the web
 * Notification API works natively in Electron's renderer too, so no IPC or
 * main-process plumbing is needed there.
 */

/** Call from an existing user-gesture handler (e.g. a Download/Upload click) — browsers throttle or auto-deny a bare request on mount. */
export function requestNotificationPermission (): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') void Notification.requestPermission()
}

export function notifyOS (title: string, body: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try { new Notification(title, { body }) } catch { /* unsupported on this platform */ }
}
