import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { checkDemoMode, DEMO_CHAIN_ID, modeMarkerPath } from './demo-mode'

describe('state dir mode marker', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'demo-mode-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes a small non-secret marker at first start and accepts the same mode again', () => {
    const now = () => new Date('2026-09-30T00:00:00Z')
    expect(checkDemoMode(dir, 'fake-chain', DEMO_CHAIN_ID, now)).toBeUndefined()
    expect(JSON.parse(readFileSync(modeMarkerPath(dir), 'utf8'))).toEqual({
      mode: 'fake-chain',
      chainId: 10143,
      createdAt: '2026-09-30T00:00:00.000Z',
    })
    expect(statSync(modeMarkerPath(dir)).mode & 0o077).toBe(0)
    expect(checkDemoMode(dir, 'fake-chain')).toBeUndefined()
  })

  it('refuses a fake-chain state dir for a real-network run, with a clear message', () => {
    checkDemoMode(dir, 'fake-chain')
    const msg = checkDemoMode(dir, 'real') as string
    expect(msg).toMatch(/created for the fake chain, but this run is for a real network/)
    expect(msg).toMatch(/new FRANK_DEMO_STATE_DIR, or delete/)
  })

  it('refuses a real-network state dir for a fake-chain run', () => {
    checkDemoMode(dir, 'real')
    expect(checkDemoMode(dir, 'fake-chain')).toMatch(
      /created for a real network, but this run is for the fake chain/,
    )
  })

  it('refuses a different chain id, and an unreadable or unknown marker', () => {
    checkDemoMode(dir, 'real', 10143)
    expect(checkDemoMode(dir, 'real', 143)).toMatch(/chain id 10143, but this run uses 143/)
    writeFileSync(modeMarkerPath(dir), '{nope')
    expect(checkDemoMode(dir, 'real')).toMatch(/cannot be read/)
    writeFileSync(modeMarkerPath(dir), '{"mode":"x"}')
    expect(checkDemoMode(dir, 'real')).toMatch(/unknown mode/)
  })

  it('a pre-marker state dir holding a fake-chain wallet is refused for a real run, never marked', () => {
    writeFileSync(join(dir, 'fake-chain-wallet.json'), '{}')
    expect(checkDemoMode(dir, 'real')).toMatch(/created for the fake chain/)
    expect(existsSync(modeMarkerPath(dir))).toBe(false)
    expect(checkDemoMode(dir, 'fake-chain')).toBeUndefined()
  })
})
