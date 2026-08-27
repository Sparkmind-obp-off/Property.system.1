#!/usr/bin/env node
/**
 * Generates a production admin credential: a strong random password plus its
 * PBKDF2-SHA256 hash in the exact format `src/shared/crypto.ts` verifies
 * ("pbkdf2$<iterations>$<saltB64url>$<hashB64url>").
 *
 * Output goes to stdout as JSON. NEVER commit the generated password.
 * Traceability: PS-MASTER-001 §45 (secret management), §3 (ADMIN role)
 *
 * Usage:
 *   node scripts/gen-admin-credential.mjs                       # random password
 *   node scripts/gen-admin-credential.mjs --password "<secret>"  # hash a given one
 */
import { webcrypto as crypto } from 'node:crypto'

// Must stay in sync with PBKDF2_ITERATIONS in src/shared/crypto.ts
const ITERATIONS = 100_000
const PASSWORD_LENGTH = 24
// Ambiguous glyphs (0/O, 1/l/I) removed so the password can be transcribed safely.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

const enc = new TextEncoder()

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function randomPassword() {
  // Rejection sampling keeps the distribution uniform over ALPHABET.
  const limit = 256 - (256 % ALPHABET.length)
  const out = []
  while (out.length < PASSWORD_LENGTH) {
    const buf = new Uint8Array(PASSWORD_LENGTH)
    crypto.getRandomValues(buf)
    for (const byte of buf) {
      if (byte < limit && out.length < PASSWORD_LENGTH) out.push(ALPHABET[byte % ALPHABET.length])
    }
  }
  return out.join('')
}

async function hashPassword(password) {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits'
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256
  )
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`
}

const flagIndex = process.argv.indexOf('--password')
const password = flagIndex !== -1 ? process.argv[flagIndex + 1] : randomPassword()

if (!password) {
  console.error('--password requires a value')
  process.exit(1)
}

console.log(JSON.stringify({ password, password_hash: await hashPassword(password) }, null, 2))
