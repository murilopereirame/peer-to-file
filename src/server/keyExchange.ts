import crypto from 'node:crypto'

const CURVE = 'prime256v1' // NIST P-256 — matches Web Crypto's 'P-256', so raw
                            // uncompressed-point public keys and derived
                            // shared secrets are byte-identical between
                            // Node and every browser-engine client (web,
                            // desktop).
const HKDF_INFO = 'p2f-key-wrap'
const NONCE_LEN = 12
const TAG_LEN = 16

export class KeyExchangeError extends Error {}

export interface KeyExchange {
  /** This server's stable ECDH public key (raw uncompressed point, base64) — safe to publish (see /api/info). */
  publicKeyBase64: string
  /**
   * AES-256-GCM-wraps `plaintext` (the transfer's AES key + IV) so only the
   * holder of the matching ECDH private key for `clientPublicKeyBase64` can
   * recover it — this is what keeps the key from being recoverable by
   * anyone who can merely observe the wire (the whole point of transfer
   * encryption on a deployment with no TLS/VPN).
   */
  wrap (clientPublicKeyBase64: string, plaintext: Buffer): string
  /** Reverses wrap(), verifying the GCM tag. Throws KeyExchangeError on any failure. */
  unwrap (clientPublicKeyBase64: string, wrappedBase64: string): Buffer
}

/**
 * ECDH-based key wrapping: the AES-256-CTR key/IV that actually encrypts a
 * transfer (cipher.ts for downloads, client-generated for uploads)
 * still has to reach the other side somehow. Sending it as plain JSON/
 * headers alongside the ciphertext — which earlier revisions of this
 * feature did — gives a passive network observer everything they need in
 * one capture, defeating the point of encrypting the transfer at all on a
 * deployment with no TLS. Wrapping it under a key derived from ECDH(this
 * server's stable keypair, the client's fresh per-request ephemeral
 * keypair) means an observer would have to solve the discrete log problem
 * to recover it, even having captured every byte on the wire.
 */
export function createKeyExchange (privateKey: Buffer): KeyExchange {
  const ecdh = crypto.createECDH(CURVE)
  ecdh.setPrivateKey(privateKey)
  const publicKeyBase64 = ecdh.getPublicKey().toString('base64')

  function deriveWrapKey (clientPublicKeyBase64: string): Buffer {
    let clientPublicKey: Buffer
    try {
      clientPublicKey = Buffer.from(clientPublicKeyBase64, 'base64')
    } catch {
      throw new KeyExchangeError('invalid client public key')
    }
    let shared: Buffer
    try {
      shared = ecdh.computeSecret(clientPublicKey)
    } catch {
      throw new KeyExchangeError('invalid client public key')
    }
    return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32))
  }

  return {
    publicKeyBase64,
    wrap (clientPublicKeyBase64, plaintext) {
      const wrapKey = deriveWrapKey(clientPublicKeyBase64)
      const nonce = crypto.randomBytes(NONCE_LEN)
      const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, nonce)
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')
    },
    unwrap (clientPublicKeyBase64, wrappedBase64) {
      const wrapKey = deriveWrapKey(clientPublicKeyBase64)
      let blob: Buffer
      try {
        blob = Buffer.from(wrappedBase64, 'base64')
      } catch {
        throw new KeyExchangeError('invalid wrapped key')
      }
      if (blob.length < NONCE_LEN + TAG_LEN) throw new KeyExchangeError('invalid wrapped key')
      const nonce = blob.subarray(0, NONCE_LEN)
      const ciphertext = blob.subarray(NONCE_LEN, blob.length - TAG_LEN)
      const tag = blob.subarray(blob.length - TAG_LEN)
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey, nonce)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(ciphertext), decipher.final()])
      } catch {
        throw new KeyExchangeError('key unwrap failed')
      }
    }
  }
}
