/**
 * A state directory belongs to ONE mode. Bot identities, stamp-pool records (sub-account indexes,
 * nonces) and the faucet's records made against the fake chain mean nothing on a real network and
 * the other way round, so the launcher writes a small NON-secret marker, `<state>/demo-mode.json`,
 * at first start and refuses to start when the requested mode differs.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
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

/** Returns an error message when `stateDir` was created for another mode/chain, else writes the
 * marker (if there is none) and returns undefined. */
export function checkDemoMode(
  stateDir: string,
  mode: DemoMode,
  chainId: number = DEMO_CHAIN_ID,
  now: () => Date = () => new Date(),
): string | undefined {
  const path = modeMarkerPath(stateDir)
  const other = (m: DemoMode) => (m === 'fake-chain' ? 'the fake chain' : 'a real network')
  const advice = (m: DemoMode) =>
    `this state dir (${stateDir}) was created for ${other(m)}, but this run is for ${other(
      mode,
    )}: its bot identities, stamp-pool records and faucet records do not carry over. Use a new FRANK_DEMO_STATE_DIR, or delete ${stateDir} to start over`
  if (existsSync(path)) {
    let marker: Partial<DemoModeMarker>
    try {
      marker = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return `${path} cannot be read; delete it (or the state dir) and start again`
    }
    if (marker.mode !== 'fake-chain' && marker.mode !== 'real') {
      return `${path} has an unknown mode; delete it (or the state dir) and start again`
    }
    if (marker.mode !== mode) return advice(marker.mode)
    if (marker.chainId !== chainId) {
      return `this state dir (${stateDir}) was created for chain id ${marker.chainId}, but this run uses ${chainId}. Use a new FRANK_DEMO_STATE_DIR`
    }
    return undefined
  }
  // No marker: a state dir from before markers existed. A fake-chain wallet in it is proof of the
  // fake chain; anything else is taken as it comes.
  if (mode === 'real' && existsSync(join(stateDir, 'fake-chain-wallet.json'))) {
    return advice('fake-chain')
  }
  const marker: DemoModeMarker = { mode, chainId, createdAt: now().toISOString() }
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 })
  return undefined
}
