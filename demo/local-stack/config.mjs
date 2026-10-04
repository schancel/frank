// Shared constants for the local end-to-end stack. Everything mutable lives under STATE, never in the repo.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..', '..')
export const STATE = process.env.FRANK_STACK_DIR ?? '/private/tmp/frank-stack'

export const HOST = '127.0.0.1'
export const PORTS = {
  chain: 18545, // local EVM node (plain HTTP, loopback)
  chainShim: 18546, // what the relays use as their upstream
  relayA: 18098, // cashwebd, plain HTTP, loopback
  relayB: 18099,
  bot: 18097, // plain-HTTP port the bot's status server is expected to listen on
  httpsApp: 18440,
  httpsRelayA: 18443,
  httpsRelayB: 18444,
  httpsBot: 18445,
}
export const ORIGINS = {
  'app': `https://${HOST}:${PORTS.httpsApp}`,
  'relay-a': `https://${HOST}:${PORTS.httpsRelayA}`,
  'relay-b': `https://${HOST}:${PORTS.httpsRelayB}`,
  'bot': `https://${HOST}:${PORTS.httpsBot}`,
}
export const FRONTS = [
  { name: 'relay-a', listen: PORTS.httpsRelayA, upstream: PORTS.relayA },
  { name: 'relay-b', listen: PORTS.httpsRelayB, upstream: PORTS.relayB },
  { name: 'bot', listen: PORTS.httpsBot, upstream: PORTS.bot },
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
  tls: join(STATE, 'tls'),
  ca: join(STATE, 'tls', 'ca.pem'),
  chainDir: join(STATE, 'chain'),
  rawTx: join(STATE, 'run', 'raw-transactions.json'),
  relay: name => join(STATE, name),
  relayConfig: name => join(STATE, name, 'cashwebd.toml'),
  relayDb: name => join(STATE, name, 'db'),
  directoryState: join(STATE, 'directory'),
  operator: join(STATE, 'operator'),
  operatorOut: join(STATE, 'operator', 'out'),
  appDirectory: join(STATE, 'app-directory'),
  appDist: join(REPO, 'app', 'dist', 'spa'),
  shots: join(STATE, 'shots'),
  wire: join(STATE, 'logs', 'wire.jsonl'),
  chromeProfile: join(STATE, 'chrome-profile'),
  cashwebd: join(STATE, 'run', 'cashwebd-path'),
}
