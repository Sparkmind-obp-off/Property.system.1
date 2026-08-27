/**
 * Vitest configuration.
 * Traceability: PS-MASTER-001 §34 (testing)
 *
 * Kept separate from vite.config.ts on purpose: that config carries the
 * Cloudflare Pages build plugin, which has no business running during tests.
 *
 * `node:sqlite` is a built-in module used only by the integration harness
 * (tests/integration/harness.ts) to provide a real SQLite database. It must be
 * externalized so Vite does not attempt to bundle it — it is never part of the
 * deployed Worker.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // Integration specs each own an in-memory database plus the module-level
    // bootstrap memo, so they must not share a worker with one another.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }
  },
  ssr: {
    external: ['node:sqlite']
  },
  optimizeDeps: {
    exclude: ['node:sqlite']
  }
})
