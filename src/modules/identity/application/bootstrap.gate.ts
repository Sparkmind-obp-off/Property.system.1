/**
 * Bootstrap gate — runs the admin bootstrap at most once per isolate.
 * Traceability: PS-MASTER-001 §4 (bootstrap behavior)
 *
 * Cloudflare Workers have no "application start" hook: an isolate is created
 * lazily on the first request it serves. §4's "when the application starts" is
 * therefore implemented as a memoized guard in front of the request paths that
 * depend on an Admin existing (login and system status).
 *
 * The memo caches only a COMPLETE outcome. A NOT_CONFIGURED / FAILED result is
 * re-evaluated on the next request, so setting the secret and redeploying — or
 * simply retrying after a transient DB error — takes effect without needing a
 * fresh isolate.
 */
import { runBootstrap, type BootstrapResult } from './bootstrap.service'
import type { Bindings } from '../../../shared/types'

let settled: BootstrapResult | null = null
let inFlight: Promise<BootstrapResult> | null = null

export async function ensureBootstrap(env: Bindings): Promise<BootstrapResult> {
  if (settled) return settled
  if (inFlight) return inFlight

  inFlight = runBootstrap(env)
    .then((result) => {
      // Only a completed bootstrap is a permanent fact; anything else must stay
      // retryable so a later configuration fix is picked up (§4).
      if (result.state === 'COMPLETE') settled = result
      return result
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

/** Test-only: drop the memo so each scenario starts from a clean state. */
export function resetBootstrapMemo(): void {
  settled = null
  inFlight = null
}
