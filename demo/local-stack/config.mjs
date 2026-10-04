// Shared constants for the local end-to-end stack. Everything mutable lives under STATE, never in the repo.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..', '..')
export const STATE = process.env.FRANK_STACK_DIR ?? '/private/tmp/frank-stack/open'

export const HOST = '127.0.0.1'
export const PORTS = {
  chain: 18545, // local EVM node (plain HTTP, loopback)
  chainShim: 18546, // what the relays use as their upstream
  relayA: 18098, // cashwebd, plain HTTP, loopback
  relayB: 18099,
  httpsApp: 18440, // the app built for relay-a
  httpsAppB: 18441, // the same app built for relay-b
  httpsRelayA: 18443,
  httpsRelayB: 18444,
}
export const ORIGINS = {
  'app': `https://${HOST}:${PORTS.httpsApp}`,
  'app-b': `https://${HOST}:${PORTS.httpsAppB}`,
  'relay-a': `https://${HOST}:${PORTS.httpsRelayA}`,
  'relay-b': `https://${HOST}:${PORTS.httpsRelayB}`,
}
export const FRONTS = [
  { name: 'relay-a', listen: PORTS.httpsRelayA, upstream: PORTS.relayA },
  { name: 'relay-b', listen: PORTS.httpsRelayB, upstream: PORTS.relayB },
]
/** The app is built once per relay it talks to; each build is served on its own origin. */
export const APPS = [
  { name: 'app', listen: PORTS.httpsApp, relay: 'relay-a' },
  { name: 'app-b', listen: PORTS.httpsAppB, relay: 'relay-b' },
]

export const NETWORK = { networkTag: 'MONT', network: 'monad-testnet', chainId: '10143' }
// Protocol-pinned Monad testnet height-zero hash (docs/protocol/chains/v1.json). The relay refuses
// to start unless its upstream reports it; the chain shim presents it for the local stand-in chain.
export const PINNED_GENESIS = '0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9'
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD'
// Hardhat's well-known development mnemonic. Local chain only; worthless anywhere else.
export const DEV_MNEMONIC = 'test test test test test test test test test test test junk'

export const P = {
  logs: join(STATE, 'logs'),
  run: join(STATE, 'run'),
  pids: join(STATE, 'run', 'pids.json'),
  accounts: join(STATE, 'run', 'accounts'),
  tls: join(STATE, 'tls'),
  ca: join(STATE, 'tls', 'ca.pem'),
  chainDir: join(STATE, 'chain'),
  rawTx: join(STATE, 'run', 'raw-transactions.json'),
  relay: name => join(STATE, name),
  relayConfig: name => join(STATE, name, 'cashwebd.toml'),
  relayDb: name => join(STATE, name, 'db'),
  bots: join(STATE, 'bots'),
  botAccounts: join(STATE, 'run', 'bot-accounts.json'),
  appBuild: name => join(STATE, 'builds', name),
  buildInfo: join(STATE, 'builds', 'build.json'),
  appDist: join(REPO, 'app', 'dist', 'spa'),
  shots: join(STATE, 'shots'),
  wire: join(STATE, 'logs', 'wire.jsonl'),
  chromeProfiles: join(STATE, 'chrome-profiles'),
  cashwebd: join(STATE, 'run', 'cashwebd-path'),
}
