#!/usr/bin/env node
// Launcher for the local end-to-end stack: two native relays, a local EVM chain, loopback HTTPS
// fronts, the production app build, and two bots (Qwen chat and blackjack) running as ordinary
// accounts. See README.md in this directory.
//
//   node demo/local-stack/stack.mjs build                 build cashwebd (one cargo slot), the app (once per relay), Hardhat
//   node demo/local-stack/stack.mjs up [live|stub]        wipe state and start everything; Qwen via the Alibaba Cloud API in ~/.frank-demo-qwen.env (live) or its stub
//   node demo/local-stack/stack.mjs status
//   node demo/local-stack/stack.mjs fund <0xaddress> [MON]
//   node demo/local-stack/stack.mjs chrome [profile-name] [a|b]   open Chrome with its own throwaway profile (b: the app on relay-b)
//   node demo/local-stack/stack.mjs e2e [live|stub]       everything, driven in real Chrome (drive.cjs)
//   node demo/local-stack/stack.mjs down
//   node demo/local-stack/stack.mjs e2e-interrupted-hand  on a stack where "e2e" left alice and bob: one hand, dealer killed mid-deal
//   also: balance <0xaddress>..., restart-relay <relay-a|relay-b>, stop <name>, start-relay <name>, start-bot <qwen|blackjack>
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HDNodeWallet, JsonRpcProvider, SigningKey, formatEther, parseEther } from 'ethers'
import { APPS, BURN_ADDRESS, DEV_MNEMONIC, FRONTS, HERE, HOST, NETWORK, ORIGINS, P, PINNED_GENESIS, PORTS, REPO, STATE } from './config.mjs'

const RELAYS = ['relay-a', 'relay-b']
const delay = ms => new Promise(r => setTimeout(r, ms))
const say = line => console.log(line)
const die = line => {
  console.error(`local-stack: ${line}`)
  process.exit(1)
}
const sha = text => createHash('sha256').update(text).digest('hex')

// ---------------------------------------------------------------- processes
const readPids = () => (existsSync(P.pids) ? JSON.parse(readFileSync(P.pids, 'utf8')) : {})
const writePids = pids => writeFileSync(P.pids, JSON.stringify(pids, null, 2))
const born = pid => {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)]).toString().trim() || null
  } catch {
    return null
  }
}
const alive = entry => !!entry && born(entry.pid) === entry.born
function start(name, command, args, env = {}, cwd = REPO) {
  const pids = readPids()
  if (alive(pids[name])) die(`${name} is already running (pid ${pids[name].pid}); run "down" first`)
  const log = openSync(join(P.logs, `${name}.log`), 'a')
  const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', log, log], env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } })
  closeSync(log)
  child.unref()
  pids[name] = { pid: child.pid, born: born(child.pid), command: [command, ...args].join(' ') }
  writePids(pids)
  return child.pid
}
async function stop(name) {
  const pids = readPids()
  const entry = pids[name]
  if (alive(entry)) {
    // Each child leads its own process group (detached), so signal the group: Hardhat and tsx fork.
    const signal = s => {
      try {
        process.kill(-entry.pid, s)
      } catch (e) {
        if (e.code !== 'ESRCH') throw e
      }
    }
    signal('SIGTERM')
    for (let i = 0; i < 50 && alive(entry); i++) await delay(100)
    if (alive(entry)) signal('SIGKILL')
    for (let i = 0; i < 20 && alive(entry); i++) await delay(100)
    if (alive(entry)) die(`could not stop ${name} (pid ${entry.pid})`)
  }
  delete pids[name]
  writePids(pids)
}
async function waitFor(label, probe, seconds = 60) {
  const end = Date.now() + seconds * 1000
  let last
  while (Date.now() < end) {
    try {
      if (await probe()) return
    } catch (e) {
      last = e
    }
    await delay(250)
  }
  die(`timed out waiting for ${label}${last ? `: ${last.message}` : ''} (see ${P.logs})`)
}

// ---------------------------------------------------------------- build
function cashwebdPath() {
  if (process.env.CASHWEBD_BIN) return process.env.CASHWEBD_BIN
  // The same per-worktree target directory `.agents/scripts/with-cargo-slot` selects.
  const git = args => execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', ...args]).toString().replace(/\n$/, '')
  const real = dir => execFileSync('/bin/sh', ['-c', 'cd -- "$1" && pwd -P', 'sh', dir]).toString().replace(/\n$/, '')
  const cache = process.env.XDG_CACHE_HOME?.startsWith('/') ? process.env.XDG_CACHE_HOME : join(process.env.HOME, '.cache')
  return join(cache, 'cargo-target', sha(real(git(['--git-common-dir']))), sha(real(git(['--show-toplevel']))), 'debug', 'cashwebd-exe')
}
function build() {
  const run = (cwd, command, args, env = {}) => {
    say(`$ (cd ${cwd} && ${command} ${args.join(' ')})`)
    const done = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
    if (done.status !== 0) die(`${command} failed`)
  }
  // The bundler must compile this checkout's packages. A node_modules that is a link into another
  // checkout would silently bundle that checkout's sources instead.
  const linked = execFileSync('/bin/sh', ['-c', 'cd -- "$1" && pwd -P', 'sh', join(REPO, 'node_modules', '@frank', 'wallet')]).toString().trim()
  const here = execFileSync('/bin/sh', ['-c', 'cd -- "$1" && pwd -P', 'sh', join(REPO, 'packages', 'wallet')]).toString().trim()
  if (linked !== here) die(`node_modules/@frank/wallet resolves to ${linked}, not this checkout; run a real "yarn install" here first`)
  if (!process.env.SKIP_CARGO) {
    const cashweb = join(REPO, 'backend', 'cashweb')
    const protoc = execFileSync('bash', [join(cashweb, 'protoc-tool', 'resolve.sh'), REPO]).toString().trim()
    run(cashweb, 'bash', [join(REPO, '.agents', 'scripts', 'with-cargo-slot'), 'cargo', 'build', '-p', 'cashwebd-exe', '--bin', 'cashwebd-exe'], { PROTOC: protoc })
  }
  // The app bundle imports the compiled output of these two workspace packages (as app/Dockerfile does).
  for (const pkg of ['nakamoto', 'crypto-box']) run(join(REPO, 'packages', pkg), join(REPO, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json', '--pretty', 'false'])
  // One production build per relay: the relay an app build talks to is fixed at build time.
  for (const app of APPS) {
    run(join(REPO, 'app'), join(REPO, 'node_modules', '.bin', 'quasar'), ['build', '-m', 'spa'], {
      QCLI_MONAD_RELAY_BASE_URL: ORIGINS[app.relay],
      QCLI_MONAD_RPC_CHAIN: NETWORK.network,
      QCLI_MONAD_STAMP_BURN_ADDRESS: BURN_ADDRESS,
    })
    rmSync(P.appBuild(app.name), { recursive: true, force: true })
    cpSync(P.appDist, P.appBuild(app.name), { recursive: true })
    // The build must be this checkout's code and must name its relay.
    const bundle = readdirSync(join(P.appBuild(app.name), 'assets')).filter(f => f.endsWith('.js')).map(f => readFileSync(join(P.appBuild(app.name), 'assets', f), 'utf8')).join('\n')
    for (const needle of [ORIGINS[app.relay], 'blackjack-challenge-form', '/relay/v1/info']) if (!bundle.includes(needle)) die(`the ${app.name} build does not contain ${JSON.stringify(needle)}; it was not built from this checkout`)
  }
  const git = args => execFileSync('git', ['-C', REPO, ...args]).toString().trim()
  writeFileSync(P.buildInfo, JSON.stringify({ built: new Date().toISOString(), commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--', 'app', 'packages']) !== '', apps: Object.fromEntries(APPS.map(a => [a.name, ORIGINS[a.relay]])) }, null, 2))
  if (!existsSync(join(P.chainDir, 'node_modules', '.bin', 'hardhat'))) {
    mkdirSync(P.chainDir, { recursive: true })
    writeFileSync(join(P.chainDir, 'package.json'), JSON.stringify({ name: 'frank-stack-chain', private: true }))
    run(P.chainDir, 'npm', ['install', '--no-audit', '--no-fund', 'hardhat@^2.26.0'])
  }
}

// ---------------------------------------------------------------- TLS
function tls() {
  mkdirSync(P.tls, { recursive: true })
  const openssl = args => {
    const done = spawnSync('openssl', args, { cwd: P.tls, stdio: ['ignore', 'ignore', 'pipe'] })
    if (done.status !== 0) die(`openssl ${args[0]} failed: ${done.stderr}`)
  }
  openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '7', '-subj', '/CN=Frank local stack throwaway CA', '-keyout', 'ca.key', '-out', 'ca.pem', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  for (const name of [...APPS, ...FRONTS].map(f => f.name)) {
    writeFileSync(join(P.tls, `${name}.ext`), `subjectAltName=IP:${HOST},DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`)
    openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', `/CN=frank-local-${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`])
    openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '7', '-extfile', `${name}.ext`, '-out', `${name}.pem`])
  }
}
/** Base64 SHA-256 of each certificate's public key, for Chrome's --ignore-certificate-errors-spki-list. */
function spkiList() {
  return ['ca', ...[...APPS, ...FRONTS].map(f => f.name)].map(name => {
    const der = new X509Certificate(readFileSync(join(P.tls, `${name}.pem`))).publicKey.export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(der).digest('base64')
  })
}
// ---------------------------------------------------------------- relays
// A relay's whole directory configuration is its own tuple: who it is and where it is reached.
// No account is named. The identity point's private half is not used by this relay build, so a
// throwaway point is generated per relay and its private half discarded.
function relayTuple(name) {
  const file = join(P.relay(name), 'tuple.json')
  if (!existsSync(file)) {
    mkdirSync(P.relay(name), { recursive: true })
    writeFileSync(file, JSON.stringify({ relayId: randomBytes(16).toString('hex'), relayIdentity: new SigningKey('0x' + randomBytes(32).toString('hex')).compressedPublicKey.slice(2), bindingExpiryNs: (BigInt(Date.now() + 2 * 365 * 24 * 3600 * 1000) * 1_000_000n).toString() }))
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}
function relayToml(name) {
  const port = name === 'relay-a' ? PORTS.relayA : PORTS.relayB
  const tuple = relayTuple(name)
  // Both bots live on relay-a, and without forwarding only accounts on relay-a can reach them, so
  // only relay-a suggests them as default contacts.
  const defaults = name === 'relay-a' && existsSync(P.botAccounts) ? Object.entries(JSON.parse(readFileSync(P.botAccounts, 'utf8'))) : []
  return `# Generated by demo/local-stack/stack.mjs for ${name}. Loopback only, behind an HTTPS front.
host = "${HOST}:${port}"
url = "${ORIGINS[name]}/"

[registry]
db_path = "${P.relayDb(name)}"
net = "mainnet"
peers = []
public_relay_urls = []

[registry.directory]
network = "${NETWORK.network}"
relay_id = "${tuple.relayId}"
relay_identity = "${tuple.relayIdentity}"
endpoint = "${ORIGINS[name]}"
binding_expiry_ns = "${tuple.bindingExpiryNs}"
# Every account of this stack publishes from 127.0.0.1.
enrollments_per_source_per_hour = 100000

[registry.monad_mailbox]
enabled = true
min_value_wei = "1000000000000"
expected_chain_id = ${NETWORK.chainId}

[registry.evm_rpc]
enabled = true
capability_ttl_ms = 3600000

[[registry.evm_rpc.chains]]
id = "${NETWORK.network}"
expected_chain_id = ${NETWORK.chainId}
upstream_env = "MONAD_TESTNET_HTTP_RPC_URL"
checkpoint_block_number = 0
checkpoint_block_hash = "${PINNED_GENESIS}"
max_get_logs_range = 10

[registry.pop]
enabled = false
monad_rpc_url = "http://unused.invalid"
hmac_secret = "unused-because-pop-is-disabled"
payment_recipient = "0x0000000000000000000000000000000000000000"
min_value_wei = "0"
${getChronikUrl() ? `
[registry.bitcoin_proxy]
enabled = true

[[registry.bitcoin_proxy.chains]]
id = "xec-testnet"
chronik_upstream_env = "XEC_TESTNET_CHRONIK_URL"
checkpoint_height = 1421481
checkpoint_hash = "00000000062c7f32591d883c99fc89ebe74a83287c0f2b7ffeef72e62217d40b"
` : ''}
${getSolanaDevnetUrl() ? `
[registry.solana_proxy]
enabled = true

[[registry.solana_proxy.chains]]
id = "solana-devnet"
upstream_env = "SOLANA_DEVNET_HTTP_RPC_URL"
expected_genesis_hash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
` : ''}
${defaults.map(([kind, bot]) => `\n[[registry.curated_defaults]]\naddress = "${bot.address}"\nname = "${BOT_NAMES[kind]}"\n`).join('')}`
}
const loadDotEnv = () => {
  const envFile = join(REPO, '.env')
  if (!existsSync(envFile)) return {}
  const res = {}
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim()
      res[key] = val
    }
  }
  return res
}
const DOTENV = loadDotEnv()
const getChainRpcUrl = () =>
  process.env.MONAD_TESTNET_HTTP_RPC_URL ||
  DOTENV.MONAD_TESTNET_HTTP_RPC_URL ||
  `http://${HOST}:${PORTS.chainShim}`

const getChronikUrl = () =>
  process.env.XEC_TESTNET_CHRONIK_URL ||
  DOTENV.XEC_TESTNET_CHRONIK_URL ||
  ''

const getSolanaDevnetUrl = () =>
  process.env.SOLANA_DEVNET_HTTP_RPC_URL ||
  DOTENV.SOLANA_DEVNET_HTTP_RPC_URL ||
  ''

const relayEnv = () => ({
  MONAD_TESTNET_HTTP_RPC_URL: getChainRpcUrl(),
  FRANK_NETWORK_TAG: process.env.FRANK_NETWORK_TAG || DOTENV.FRANK_NETWORK_TAG || NETWORK.networkTag,
  MONAD_STAMP_BURN_ADDRESS: process.env.MONAD_STAMP_BURN_ADDRESS || DOTENV.MONAD_STAMP_BURN_ADDRESS || BURN_ADDRESS,
  ...(getChronikUrl() ? { XEC_TESTNET_CHRONIK_URL: getChronikUrl() } : {}),
  ...(getSolanaDevnetUrl() ? { SOLANA_DEVNET_HTTP_RPC_URL: getSolanaDevnetUrl() } : {}),
})
async function startRelay(name) {
  const bin = cashwebdPath()
  if (!existsSync(bin)) die(`relay binary not found at ${bin}; run "build" first (or set CASHWEBD_BIN)`)
  mkdirSync(P.relay(name), { recursive: true })
  writeFileSync(P.relayConfig(name), relayToml(name))
  const check = spawnSync(bin, ['--check-config', P.relayConfig(name)], { env: { ...process.env, ...relayEnv() }, encoding: 'utf8' })
  if (check.status !== 0) die(`${name} configuration rejected:\n${check.stdout}${check.stderr}`)
  start(name, bin, [P.relayConfig(name)], relayEnv())
  const port = name === 'relay-a' ? PORTS.relayA : PORTS.relayB
  await waitFor(`${name} on :${port}`, async () => {
    if (!alive(readPids()[name])) die(`${name} exited during startup; see ${join(P.logs, `${name}.log`)}`)
    return (await fetch(`http://${HOST}:${port}/relay/v1/info`)).ok
  })
}
/** Whether a relay holds a current directory entry for an address (plain loopback read). */
async function published(relay, address) {
  const port = relay === 'relay-a' ? PORTS.relayA : PORTS.relayB
  return (await fetch(`http://${HOST}:${port}/directory/v1/${NETWORK.network}/address/${address}`)).status === 200
}

// ---------------------------------------------------------------- chain
const provider = () => new JsonRpcProvider(getChainRpcUrl(), Number(NETWORK.chainId), { staticNetwork: true })
const devWallet = () => HDNodeWallet.fromPhrase(DEV_MNEMONIC).connect(provider())
async function fund(address, amount = '5') {
  const rpcUrl = getChainRpcUrl()
  if (rpcUrl.includes('alchemy.com') || (!rpcUrl.includes(HOST) && !rpcUrl.includes('localhost'))) {
    say(`skipping local funding for ${address}: using external RPC ${rpcUrl}`)
    return
  }
  const wallet = devWallet()
  const tx = await wallet.sendTransaction({ to: address, value: parseEther(amount) })
  await tx.wait()
  say(`funded ${address} with ${amount} local MON (tx ${tx.hash}); balance now ${formatEther(await wallet.provider.getBalance(address))}`)
  wallet.provider.destroy()
}

// ---------------------------------------------------------------- bots
// Two ordinary accounts on relay-a. Each signs and publishes its own directory entry at start;
// nothing about them is installed anywhere. Their secrets are disposable and generated here.
const BOT_NAMES = { qwen: 'Qwen (chat bot)', blackjack: 'Blackjack (bot)' }
const BOT_SCRIPTS = { qwen: 'qwen-bot.livecheck.ts', blackjack: 'blackjack-p2p-bot.livecheck.ts' }
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const BOT_CWD = join(REPO, 'packages', 'bot')
const STAMP_WEI = '10000000000000000' // 0.01 MON, the app's default stamp
// Live mode talks to Alibaba Cloud's Qwen API (no local model). The key and endpoint come from the
// owner's env file, never from this repository: QWEN_ENV_FILE, default ~/.frank-demo-qwen.env, with
// QWEN_API_KEY and QWEN_OPENAI_COMPATIBLE_ENDPOINT (and optionally QWEN_MODEL; unset = the bot's default).
const QWEN_ENV_FILE = process.env.QWEN_ENV_FILE ?? join(process.env.HOME ?? '', '.frank-demo-qwen.env')
function qwenCloud() {
  if (!existsSync(QWEN_ENV_FILE)) die(`live mode needs the Qwen API settings in ${QWEN_ENV_FILE} (QWEN_API_KEY, QWEN_OPENAI_COMPATIBLE_ENDPOINT), or use "stub"`)
  const file = Object.fromEntries(readFileSync(QWEN_ENV_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
    const at = l.indexOf('=')
    return [l.slice(0, at).replace(/^export\s+/, '').trim(), l.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]
  }))
  const pick = name => process.env[name] ?? file[name]
  if (!pick('QWEN_API_KEY') || !pick('QWEN_OPENAI_COMPATIBLE_ENDPOINT')) die(`${QWEN_ENV_FILE} must set QWEN_API_KEY and QWEN_OPENAI_COMPATIBLE_ENDPOINT`)
  return { QWEN_API_KEY: pick('QWEN_API_KEY'), QWEN_OPENAI_COMPATIBLE_ENDPOINT: pick('QWEN_OPENAI_COMPATIBLE_ENDPOINT'), ...(pick('QWEN_MODEL') ? { QWEN_MODEL: pick('QWEN_MODEL') } : {}) }
}
function botEnv(kind, mode) {
  const dir = join(P.bots, kind)
  mkdirSync(dir, { recursive: true })
  const common = { NODE_EXTRA_CA_CERTS: P.ca, MONAD_RELAY_BASE_URL: ORIGINS['relay-a'], E2E_DEMO_RELAY_URL: ORIGINS['relay-a'], MONAD_RPC_CHAIN: NETWORK.network, MONAD_TESTNET_HTTP_RPC_URL: getChainRpcUrl(), MONAD_STAMP_BURN_ADDRESS: BURN_ADDRESS, FRANK_DM_DEFAULT_STAMP_VALUE_WEI: STAMP_WEI }
  if (kind === 'qwen') {
    const model = mode === 'stub' ? { QWEN_BOT_MODE: 'stub' } : { QWEN_BOT_MODE: 'live', ...qwenCloud() }
    return { ...common, ...model, QWEN_BOT_CANONICAL_ROOTS_JSON: join(dir, 'roots.json'), QWEN_BOT_STATE_DIR: join(dir, 'state'), QWEN_BOT_WALLET_STATE_DIR: join(dir, 'wallet'), QWEN_BOT_HANDOFF_JSON: join(dir, 'handoff.json'), QWEN_BOT_STAMP_VALUE_WEI: STAMP_WEI, QWEN_BOT_POLL_INTERVAL_MS: '2000' }
  }
  const root = join(dir, 'account-root.hex')
  if (!existsSync(root)) writeFileSync(root, randomBytes(32).toString('hex'), { mode: 0o600 })
  return { ...common, BLACKJACK_P2P_ACCOUNT_ROOT_HEX: readFileSync(root, 'utf8').trim(), BLACKJACK_P2P_STATE_DIR: join(dir, 'state'), BLACKJACK_P2P_INTERVAL_MS: '2000', BLACKJACK_P2P_NEW_ACCOUNTS_URL: `${ORIGINS['relay-a']}/directory/v1/${NETWORK.network}/accounts` }
}
/** The bots' public addresses, derived from their secrets without contacting a relay. */
function botAccounts() {
  if (existsSync(P.botAccounts)) return JSON.parse(readFileSync(P.botAccounts, 'utf8'))
  const accounts = {}
  for (const kind of ['qwen', 'blackjack']) {
    const done = spawnSync(TSX, [join(HERE, 'bot-accounts.mts'), kind], { cwd: BOT_CWD, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...botEnv(kind, 'stub') } })
    if (done.status !== 0) die(`could not derive the ${kind} bot's addresses:\n${done.stdout}${done.stderr}`)
    accounts[kind] = JSON.parse(done.stdout.trim().split('\n').pop())
  }
  writeFileSync(P.botAccounts, JSON.stringify(accounts, null, 2))
  return accounts
}
const botMode = () => (existsSync(join(P.bots, 'mode')) ? readFileSync(join(P.bots, 'mode'), 'utf8').trim() : 'live')
async function startBot(kind, mode = botMode()) {
  const accounts = botAccounts()
  // Neither bot should spend stamps answering the other.
  const other = kind === 'qwen' ? accounts.blackjack.address : accounts.qwen.address
  start(`${kind}-bot`, TSX, [BOT_SCRIPTS[kind]], { ...botEnv(kind, mode), FRANK_BOT_PEER_DENYLIST: other }, BOT_CWD)
  await waitFor(`the ${kind} bot to publish its own directory entry`, async () => {
    if (!alive(readPids()[`${kind}-bot`])) die(`the ${kind} bot exited; see ${join(P.logs, `${kind}-bot.log`)}`)
    return published('relay-a', accounts[kind].address)
  }, 120)
  say(`${kind} bot running as ${accounts[kind].address}; log ${join(P.logs, `${kind}-bot.log`)}`)
}
async function startBots(mode) {
  if (mode !== 'live' && mode !== 'stub') die('the Qwen bot mode must be "live" (Alibaba Cloud Qwen API) or "stub"')
  if (mode === 'live') qwenCloud() // fail before anything starts if the API settings are missing
  mkdirSync(P.bots, { recursive: true })
  writeFileSync(join(P.bots, 'mode'), mode + '\n')
  // Qwen first: the blackjack bot challenges accounts published after it started, and the other
  // bot should not be one of them.
  await startBot('qwen', mode)
  await startBot('blackjack', mode)
}

// ---------------------------------------------------------------- lifecycle
const PROCESSES = ['chain', 'chain-shim', 'relay-a', 'relay-b', 'fronts', 'qwen-bot', 'blackjack-bot']
async function down() {
  for (const name of Object.keys(readPids()).reverse()) await stop(name)
  say('all stack processes stopped')
}
async function up(mode = 'live') {
  if (Object.values(readPids()).some(alive)) die('the stack is already running; run "down" first')
  for (const app of APPS) if (!existsSync(join(P.appBuild(app.name), 'index.html'))) die('app build not found; run "build" first')
  if (!existsSync(join(P.chainDir, 'node_modules', '.bin', 'hardhat'))) die('local chain not installed; run "build" first')
  // A fresh start every time: the local chain keeps no state across restarts, so relay databases,
  // bot state and browser profiles from an earlier run would no longer match it.
  for (const dir of [P.run, P.tls, P.relay('relay-a'), P.relay('relay-b'), P.bots, P.chromeProfiles]) rmSync(dir, { recursive: true, force: true })
  for (const dir of [P.logs, P.run, P.shots, P.accounts]) mkdirSync(dir, { recursive: true })
  for (const name of [...PROCESSES, 'chrome']) rmSync(join(P.logs, `${name}.log`), { force: true })
  rmSync(P.wire, { force: true })
  tls()

  writeFileSync(
    join(P.chainDir, 'hardhat.config.cjs'),
    `// Generated by demo/local-stack/stack.mjs. Local stand-in chain with Monad testnet's chain id.\nmodule.exports = { solidity: '0.8.24', networks: { hardhat: { chainId: ${NETWORK.chainId}, accounts: { mnemonic: ${JSON.stringify(DEV_MNEMONIC)}, count: 3, accountsBalance: '1000000000000000000000000' }, mining: { auto: true, interval: 1000 } } } }\n`,
  )
  start('chain', join(P.chainDir, 'node_modules', '.bin', 'hardhat'), ['--config', join(P.chainDir, 'hardhat.config.cjs'), 'node', '--hostname', HOST, '--port', String(PORTS.chain)], { HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true' }, P.chainDir)
  const rpc = async (port, method, params = []) => (await (await fetch(`http://${HOST}:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result
  await waitFor('local chain', async () => (await rpc(PORTS.chain, 'eth_chainId')) === '0x' + Number(NETWORK.chainId).toString(16))
  start('chain-shim', process.execPath, [join(HERE, 'chain-shim.mjs')])
  await waitFor('chain shim', async () => (await rpc(PORTS.chainShim, 'eth_getBlockByNumber', ['0x0', false])).hash === PINNED_GENESIS)
  // Derived before the relays start so relay-a can suggest the two bots as default contacts.
  const accounts = botAccounts()
  for (const relay of RELAYS) await startRelay(relay)
  start('fronts', process.execPath, [join(HERE, 'fronts.mjs')])
  await waitFor('HTTPS fronts', async () => {
    const done = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--cacert', P.ca, `${ORIGINS['relay-a']}/relay/v1/info`], { encoding: 'utf8' })
    return done.stdout === '200'
  })
  await fund(accounts.qwen.fund, '5')
  await fund(accounts.blackjack.fund, '50')
  await startBots(mode)
  say('')
  await status()
  say(`
next (or run "e2e" to have it driven for you):
  node demo/local-stack/stack.mjs chrome alice      # first person: create an account
  node demo/local-stack/stack.mjs chrome bob        # second person, in a separate window and profile
  node demo/local-stack/stack.mjs fund <the address on each app's Receive page>
  Both bots are already in each new account's contact list. To message each other, Add Contact
  with the address shown on the other person's Wallet page.`)
}
async function status() {
  const pids = readPids()
  for (const name of PROCESSES) say(`  ${name.padEnd(13)} ${alive(pids[name]) ? `running (pid ${pids[name].pid})` : 'stopped'}`)
  for (const app of APPS) say(`  ${app.name.padEnd(13)} ${ORIGINS[app.name]}/   (the app, using ${app.relay})`)
  for (const name of RELAYS) say(`  ${name.padEnd(13)} ${ORIGINS[name]}/`)
  say(`  chain         http://${HOST}:${PORTS.chainShim} (chain id ${NETWORK.chainId}; dev account ${HDNodeWallet.fromPhrase(DEV_MNEMONIC).address})`)
  if (existsSync(P.botAccounts)) for (const [kind, bot] of Object.entries(JSON.parse(readFileSync(P.botAccounts, 'utf8')))) say(`  ${(kind + ' bot').padEnd(13)} message it at ${bot.address}   (its stamps are paid from ${bot.fund})`)
  if (existsSync(P.buildInfo)) say(`  build         ${JSON.parse(readFileSync(P.buildInfo, 'utf8')).commit}${JSON.parse(readFileSync(P.buildInfo, 'utf8')).dirty ? ' + uncommitted changes' : ''}`)
  say(`  CA            ${P.ca}  (Node clients: NODE_EXTRA_CA_CERTS=${P.ca})`)
  say(`  logs          ${P.logs}   state ${STATE}`)
}
const chromeProfile = name => join(P.chromeProfiles, name)
const chromeArgs = profile => ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spkiList().join(',')}`]
/** A Chrome window with its own throwaway profile, so several people can be open side by side. */
function chrome(name = 'user-1', app = 'a') {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) die('profile name: lower-case letters, digits and "-" only')
  if (app !== 'a' && app !== 'b') die('usage: chrome [profile-name] [a|b]')
  const binary = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = chromeProfile(name)
  const origin = ORIGINS[app === 'a' ? 'app' : 'app-b']
  const child = spawn(binary, [...chromeArgs(profile), `${origin}/`], { detached: true, stdio: 'ignore' })
  child.unref()
  say(`Chrome started (pid ${child.pid}) on ${origin}/ with profile ${profile}; it trusts only this stack's certificates.`)
  say('Quit that window before "up" or "down"; both remove every profile under ' + P.chromeProfiles + '.')
}
async function restartRelay(name) {
  if (!RELAYS.includes(name)) die('usage: restart-relay <relay-a|relay-b>')
  await stop(name)
  await startRelay(name)
  say(`${name} restarted`)
}
/** One driver step in real Chrome. A leading object sets driver options (see drive.cjs). */
const drive = (...step) => {
  const options = typeof step[0] === 'object' ? step.shift() : {}
  say(`\n== drive ${step.join(' ')}${Object.keys(options).length ? '  ' + JSON.stringify(options) : ''}`)
  const done = spawnSync(process.execPath, [join(HERE, 'drive.cjs'), ...step], { stdio: 'inherit', env: { ...process.env, ...options } })
  if (done.status !== 0) die(`driver step "${step.join(' ')}" failed; see ${P.logs} and ${P.shots}`)
}
const account = name => JSON.parse(readFileSync(join(P.accounts, `${name}.json`), 'utf8'))
/** One hand between two people, one window at a time, each pressing what their role is offered. */
function humanHand(challenger, other, role, options, interrupt) {
  drive(options, challenger, 'challenge', account(other).address, role, '0.05')
  // The other person moves first in both cases: a player bets, a dealer accepts.
  const order = [other, challenger]
  const turn = (who, extra = {}) => drive({ ...options, BET: '0.04', ...extra }, who, 'play', account(who === other ? challenger : other).address, 'turn')
  let next = 0
  const recovery = join(P.run, 'hand-recovery.log')
  if (interrupt) {
    rmSync(recovery, { force: true })
    // The dealer's window is killed while its deal is on its way, before it is delivered. When
    // the window is opened again the same deal must go out once and the hand must finish.
    turn(other)
    turn(challenger, { KILL_WHEN_SENDING: 'Cards dealt', LABEL: 'killed' })
    next = 1
  }
  for (let turns = 0; turns < 14 && !existsSync(join(P.run, 'hand-resolved')); turns++, next++) turn(order[next % 2])
  if (!existsSync(join(P.run, 'hand-resolved'))) die(`the hand between ${challenger} and ${other} did not resolve`)
  if (interrupt) {
    const lines = existsSync(recovery) ? readFileSync(recovery, 'utf8').trim() : ''
    say(lines
      ? `interrupted hand: the reopened dealer recovered the deal by the resend path:\n${lines}`
      : 'interrupted hand: NOTE the deal was recovered by settling its recorded payment (killed after the payment set was saved), not by the resend path')
  }
  // What each of them sees at the end.
  for (const who of order) drive({ LABEL: 'result', VIEW_RESULT: '1' }, who, 'play', account(who === other ? challenger : other).address, 'turn')
}
// The whole flow from clean state, in real Chrome, one window at a time.
async function e2e(mode = 'live') {
  const started = Date.now()
  await up(mode)
  const bots = botAccounts()
  // Two people, each through normal onboarding. Messaging needs no Settings step.
  for (const name of ['alice', 'bob']) {
    drive(name, 'onboard')
    await fund(account(name).fund)
  }
  // Alice adds Bob by address and writes (hammering Send); Bob reads and answers; Alice reads it.
  drive({ SPAM: '1' }, 'alice', 'send', account('bob').address, 'Hello Bob, this is Alice.')
  drive('bob', 'expect', account('alice').address, 'Hello Bob, this is Alice.')
  drive('bob', 'send', account('alice').address, 'Hello Alice, Bob here.')
  drive('alice', 'expect', account('bob').address, 'Hello Alice, Bob here.')
  // An address nobody published cannot be added, and nothing is paid.
  drive('alice', 'refused', '0x00000000000000000000000000000000000000aa')
  // The Qwen bot answers once.
  drive('alice', 'ask', bots.qwen.address, 'Reply with one short sentence: what is two plus two?')
  // Blackjack with the bot. Its own challenge (the bot deals) reached the new account by itself;
  // then Alice challenges it as dealer, so the bot plays.
  drive({ SPAM: '1' }, 'alice', 'play', bots.blackjack.address, 'bot')
  drive('alice', 'challenge', bots.blackjack.address, 'dealer', '0.05')
  drive({ SPAM: '1' }, 'alice', 'play', bots.blackjack.address, 'bot')
  // Blackjack between the two people, one hand in each role assignment.
  humanHand('alice', 'bob', 'dealer', { SPAM: '1' })
  humanHand('alice', 'bob', 'player', {})
  // The stuck-hand case: the dealer's window closes between the bet arriving and the deal leaving.
  humanHand('alice', 'bob', 'dealer', {}, true)
  // A third person on relay-b. The relays do not replicate or forward yet, so neither side can
  // add the other, and nothing is paid.
  drive('carol', 'onboard', 'b')
  await fund(account('carol').fund)
  drive({ LABEL: 'cross-relay' }, 'alice', 'refused', account('carol').address)
  drive({ LABEL: 'cross-relay' }, 'carol', 'refused', account('alice').address)
  await down()
  rmSync(P.chromeProfiles, { recursive: true, force: true })
  say(`\ne2e finished in ${Math.round((Date.now() - started) / 1000)} s; the stack is down. Evidence: ${P.logs} and ${P.shots}`)
}

const [command, ...args] = process.argv.slice(2)
mkdirSync(P.logs, { recursive: true })
mkdirSync(P.run, { recursive: true })
const commands = {
  build,
  'up': () => up(args[0]),
  'down': async () => {
    await down()
    rmSync(P.chromeProfiles, { recursive: true, force: true })
  },
  status,
  'balance': async () => {
    const p = provider()
    for (const a of args) say(`${a} ${formatEther(await p.getBalance(a))}`)
    p.destroy()
  },
  'fund': () => (/^0x[0-9a-fA-F]{40}$/.test(args[0] ?? '') ? fund(args[0], args[1]) : die('usage: fund <0xaddress> [MON]')),
  'chrome': () => chrome(args[0], args[1]),
  'e2e': () => e2e(args[0]),
  'restart-relay': () => restartRelay(args[0]),
  'stop': () => (PROCESSES.includes(args[0]) ? stop(args[0]) : die(`usage: stop <${PROCESSES.join('|')}>`)),
  'start-relay': () => (RELAYS.includes(args[0]) ? startRelay(args[0]) : die('usage: start-relay <relay-a|relay-b>')),
  'start-bot': () => (BOT_SCRIPTS[args[0]] ? startBot(args[0]) : die('usage: start-bot <qwen|blackjack>')),
  // One more hand between alice and bob on a stack that is up, with the dealer killed mid-deal.
  'e2e-interrupted-hand': () => humanHand('alice', 'bob', 'dealer', {}, true),
  'chrome-args': () => say(JSON.stringify(chromeArgs(chromeProfile(args[0] ?? 'driven')))),
}
if (!commands[command]) die(`usage: stack.mjs ${Object.keys(commands).join('|')}`)
await commands[command]()
