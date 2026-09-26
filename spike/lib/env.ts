// THROWAWAY spike helper. Loads frank/.env without adding a dotenv dependency.
// Looks first at the worktree root (in case a .env is ever added there), then
// falls back to the main repo checkout at ~/repos/frank/.env, since that's
// where the real Alchemy RPC URL currently lives (it's gitignored and was
// never copied into this worktree).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!fs.existsSync(filePath)) return out
  const raw = fs.readFileSync(filePath, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    out[key] = value
  }
  return out
}

const candidates = [
  path.resolve(__dirname, '../../.env'), // worktree root
  path.join(os.homedir(), 'repos/frank/.env'), // main repo checkout (real source of truth)
]

let loaded: Record<string, string> = {}
let loadedFrom = ''
for (const candidate of candidates) {
  const parsed = parseEnvFile(candidate)
  if (Object.keys(parsed).length > 0) {
    loaded = parsed
    loadedFrom = candidate
    break
  }
}

export const ENV = loaded
export const ENV_SOURCE = loadedFrom

export function requireEnv(key: string, fallback?: string): string {
  const value = ENV[key] ?? process.env[key] ?? fallback
  if (!value) {
    throw new Error(
      `Missing required env var ${key} (looked in ${ENV_SOURCE || 'no .env found'})`,
    )
  }
  return value
}
