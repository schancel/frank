/**
 * A state directory belongs to ONE mode. Bot identities, stamp-pool records (sub-account indexes,
 * nonces) and the faucet's records made against the fake chain mean nothing on a real network and
 * the other way round, so the launcher records a small NON-secret marker, `<state>/demo-mode.json`,
 * and refuses to start when the requested mode differs.
 *
 * Two steps: `checkDemoMode` only reads (called first, refuses a mismatch); `writeDemoMode` is
 * called once the prerequisite checks passed, so a start that fails on a missing wallet or a busy
 * port leaves no marker behind and cannot poison the directory for the other mode.
 */
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export type DemoMode = 'fake-chain' | 'real'

/** Monad testnet's chain id, which the fake chain also reports. */
export const DEMO_CHAIN_ID = 10143

export interface DemoModeMarker {
  mode: DemoMode
  chainId: number
  createdAt: string
}

export const modeMarkerPath = (stateDir: string) => join(stateDir, 'demo-mode.json')

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Returns an error message when `stateDir` was created for another mode/chain (or its marker is
 * unusable), else undefined. Never writes. */
export function checkDemoMode(
  stateDir: string,
  mode: DemoMode,
  chainId: number = DEMO_CHAIN_ID,
): string | undefined {
  const path = modeMarkerPath(stateDir)
  const other = (m: DemoMode) => (m === 'fake-chain' ? 'the fake chain' : 'a real network')
  const advice = (m: DemoMode) =>
    `this state dir (${stateDir}) was created for ${other(m)}, but this run is for ${other(
      mode,
    )}: its bot identities, stamp-pool records and faucet records do not carry over. Use a new FRANK_DEMO_STATE_DIR, or delete ${stateDir} to start over`
  if (isLink(path)) {
    return `${path} is a symbolic link; delete it (or the state dir) and start again`
  }
  if (existsSync(path)) {
    let marker: unknown
    try {
      marker = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return `${path} cannot be read; delete it (or the state dir) and start again`
    }
    const m = marker as Partial<DemoModeMarker> | null
    if (
      typeof m !== 'object' ||
      m === null ||
      (m.mode !== 'fake-chain' && m.mode !== 'real') ||
      typeof m.chainId !== 'number'
    ) {
      return `${path} is not a valid marker (expected {mode, chainId}); delete it (or the state dir) and start again`
    }
    if (m.mode !== mode) return advice(m.mode)
    if (m.chainId !== chainId) {
      return `this state dir (${stateDir}) was created for chain id ${m.chainId}, but this run uses ${chainId}. Use a new FRANK_DEMO_STATE_DIR`
    }
    return undefined
  }
  // No marker: a state dir from before markers existed. A fake-chain wallet in it is proof of the
  // fake chain; anything else is taken as it comes.
  if (mode === 'real' && existsSync(join(stateDir, 'fake-chain-wallet.json'))) {
    return advice('fake-chain')
  }
  return undefined
}

/** Records the mode if there is no marker yet (a temp file renamed into place, so a symlink or
 * anything else at the path is replaced, never written through). */
export function writeDemoMode(
  stateDir: string,
  mode: DemoMode,
  chainId: number = DEMO_CHAIN_ID,
  now: () => Date = () => new Date(),
): void {
  const path = modeMarkerPath(stateDir)
  if (existsSync(path) || isLink(path)) return
  const marker: DemoModeMarker = { mode, chainId, createdAt: now().toISOString() }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
}
