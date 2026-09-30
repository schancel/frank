import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { checkDemoMode, DEMO_CHAIN_ID, modeMarkerPath, writeDemoMode } from './demo-mode'

describe('state dir mode marker', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'demo-mode-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const claim = (mode: 'fake-chain' | 'real', chainId?: number) => {
    expect(checkDemoMode(dir, mode, chainId)).toBeUndefined()
    writeDemoMode(dir, mode, chainId)
  }

  it('checking writes nothing; writing records a small non-secret marker', () => {
    expect(checkDemoMode(dir, 'fake-chain')).toBeUndefined()
    expect(existsSync(modeMarkerPath(dir))).toBe(false)
    const now = () => new Date('2026-09-30T00:00:00Z')
    writeDemoMode(dir, 'fake-chain', DEMO_CHAIN_ID, now)
    expect(JSON.parse(readFileSync(modeMarkerPath(dir), 'utf8'))).toEqual({
      mode: 'fake-chain',
      chainId: 10143,
      createdAt: '2026-09-30T00:00:00.000Z',
    })
    expect(statSync(modeMarkerPath(dir)).mode & 0o077).toBe(0)
    expect(checkDemoMode(dir, 'fake-chain')).toBeUndefined()
  })

  it('an existing marker is never overwritten', () => {
    claim('fake-chain')
    writeDemoMode(dir, 'real')
    expect(JSON.parse(readFileSync(modeMarkerPath(dir), 'utf8')).mode).toBe('fake-chain')
  })

  it('refuses a fake-chain state dir for a real-network run, with a clear message', () => {
    claim('fake-chain')
    const msg = checkDemoMode(dir, 'real') as string
    expect(msg).toMatch(/created for the fake chain, but this run is for a real network/)
    expect(msg).toMatch(/new FRANK_DEMO_STATE_DIR, or delete/)
  })

  it('refuses a real-network state dir for a fake-chain run', () => {
    claim('real')
    expect(checkDemoMode(dir, 'fake-chain')).toMatch(
      /created for a real network, but this run is for the fake chain/,
    )
  })

  it('refuses a different chain id', () => {
    claim('real', 10143)
    expect(checkDemoMode(dir, 'real', 143)).toMatch(/chain id 10143, but this run uses 143/)
  })

  it.each([
    ['not JSON', '{nope', /cannot be read/],
    ['null', 'null', /not a valid marker/],
    ['a number', '5', /not a valid marker/],
    ['an array', '[]', /not a valid marker/],
    ['an unknown mode', '{"mode":"x","chainId":1}', /not a valid marker/],
    ['a missing chain id', '{"mode":"real"}', /not a valid marker/],
    ['a string chain id', '{"mode":"real","chainId":"10143"}', /not a valid marker/],
  ])('refuses a marker that is %s, without throwing', (_name, content, message) => {
    writeFileSync(modeMarkerPath(dir), content)
    expect(checkDemoMode(dir, 'real')).toMatch(message)
  })

  it('refuses a symbolic link at the marker path and never writes through it', () => {
    const target = join(dir, 'victim.txt')
    symlinkSync(target, modeMarkerPath(dir)) // dangling
    expect(checkDemoMode(dir, 'fake-chain')).toMatch(/symbolic link/)
    writeDemoMode(dir, 'fake-chain')
    expect(existsSync(target)).toBe(false)
    expect(lstatSync(modeMarkerPath(dir)).isSymbolicLink()).toBe(true)
  })

  it('a pre-marker state dir holding a fake-chain wallet is refused for a real run', () => {
    writeFileSync(join(dir, 'fake-chain-wallet.json'), '{}')
    expect(checkDemoMode(dir, 'real')).toMatch(/created for the fake chain/)
    expect(checkDemoMode(dir, 'fake-chain')).toBeUndefined()
  })
})
