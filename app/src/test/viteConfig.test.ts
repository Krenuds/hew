/**
 * vite.config.ts's `__HEW_REPORT_DEV_PROXY__` define — regression coverage
 * for the leak this once had: gating only on `Boolean(process.env.
 * HEW_REPORT_PROXY)` bakes whatever that var happened to be at BUILD time
 * into a production bundle too, since `vite build` reads the same
 * `process.env` a dev server would. The fix needs `command === 'serve'`
 * (the function form of `defineConfig`) so a `vite build` run always bakes
 * `false`, regardless of the ambient environment it runs in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

type ConfigFactory = (env: { command: 'build' | 'serve'; mode: string }) => { define?: Record<string, unknown> }

// `reportProxyTarget` is read from `process.env` once at module top level (by
// design — a real `vite build`/`vite serve` invocation is a fresh process),
// so each case here needs its OWN fresh module instance: set the env var,
// THEN reset the module registry, THEN import.
async function loadConfigFactory(): Promise<ConfigFactory> {
  vi.resetModules()
  const mod = await import('../../vite.config')
  return mod.default as unknown as ConfigFactory
}

describe('vite.config __HEW_REPORT_DEV_PROXY__', () => {
  const originalEnv = process.env.HEW_REPORT_PROXY

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HEW_REPORT_PROXY
    else process.env.HEW_REPORT_PROXY = originalEnv
  })

  it('is baked false for `vite build`, even with HEW_REPORT_PROXY set in the environment', async () => {
    process.env.HEW_REPORT_PROXY = 'http://127.0.0.1:8788'
    const configFactory = await loadConfigFactory()
    const config = configFactory({ command: 'build', mode: 'production' })
    expect(config.define?.__HEW_REPORT_DEV_PROXY__).toBe('false')
  })

  it('is baked true for `vite serve` when HEW_REPORT_PROXY is set', async () => {
    process.env.HEW_REPORT_PROXY = 'http://127.0.0.1:8788'
    const configFactory = await loadConfigFactory()
    expect(configFactory({ command: 'serve', mode: 'development' }).define?.__HEW_REPORT_DEV_PROXY__).toBe('true')
  })

  it('is baked false for `vite serve` when HEW_REPORT_PROXY is unset', async () => {
    delete process.env.HEW_REPORT_PROXY
    const configFactory = await loadConfigFactory()
    expect(configFactory({ command: 'serve', mode: 'development' }).define?.__HEW_REPORT_DEV_PROXY__).toBe('false')
  })
})
