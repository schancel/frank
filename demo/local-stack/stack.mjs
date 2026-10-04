#!/usr/bin/env node
// Launcher for the local end-to-end stack: two native relays, a local EVM chain, loopback HTTPS
// fronts, and the production app build. See README.md in this directory.
//
//   node demo/local-stack/stack.mjs build            build cashwebd (one cargo slot) and the app
//   node demo/local-stack/stack.mjs up               wipe state, start everything, write the policy
//   node demo/local-stack/stack.mjs status
//   node demo/local-stack/stack.mjs policy           (re)write the bootstrap policy (valid 1 hour)
//   node demo/local-stack/stack.mjs bot-export [live|stub|blackjack]   write the bot's public export (disposable roots)
//   node demo/local-stack/stack.mjs install [ui-export.json] [bot-export.json]
//   node demo/local-stack/stack.mjs bot-start [live|stub|blackjack]    Qwen on local Ollama, Qwen stub, or the dealer
//   node demo/local-stack/stack.mjs restart-relays [relay-a|relay-b]   also restarts a running bot
//   node demo/local-stack/stack.mjs balance <0xaddress>...
//   node demo/local-stack/stack.mjs e2e-blackjack [plan]               blackjack variant, driven in headless Chrome
//   node demo/local-stack/stack.mjs bot-stop
//   node demo/local-stack/stack.mjs restart-relays
//   node demo/local-stack/stack.mjs fund <0xaddress> [MON]
//   node demo/local-stack/stack.mjs chrome [driven]  open Chrome on the app (empty profile, or the driver's)
//   node demo/local-stack/stack.mjs provision <ui-export.json> [live|stub|blackjack]   bot export + install + fund bot + start bot
//   node demo/local-stack/stack.mjs e2e [live|stub] ["message"]   everything, driven in headless Chrome
//   node demo/local-stack/stack.mjs down
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HDNodeWallet, JsonRpcProvider, SigningKey, computeAddress, formatEther, parseEther } from 'ethers'
import { BURN_ADDRESS, DEV_MNEMONIC, FRONTS, HERE, HOST, NETWORK, ORIGINS, P, PINNED_GENESIS, PORTS, REPO, STATE } from './config.mjs'

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
  const cashweb = join(REPO, 'backend', 'cashweb')
  const protoc = execFileSync('bash', [join(cashweb, 'protoc-tool', 'resolve.sh'), REPO]).toString().trim()
  run(cashweb, 'bash', [join(REPO, '.agents', 'scripts', 'with-cargo-slot'), 'cargo', 'build', '-p', 'cashwebd-exe', '--bin', 'cashwebd-exe'], { PROTOC: protoc })
  // The app bundle imports the compiled output of these two workspace packages (as app/Dockerfile does).
  for (const pkg of ['nakamoto', 'crypto-box']) run(join(REPO, 'packages', pkg), join(REPO, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json', '--pretty', 'false'])
  run(join(REPO, 'app'), join(REPO, 'app', 'node_modules', '.bin', 'quasar'), ['build', '-m', 'spa'], {
    QCLI_MONAD_RELAY_BASE_URL: ORIGINS['relay-a'],
    QCLI_MONAD_RPC_CHAIN: NETWORK.network,
    QCLI_MONAD_STAMP_BURN_ADDRESS: BURN_ADDRESS,
  })
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
  for (const name of ['app', ...FRONTS.map(f => f.name)]) {
    writeFileSync(join(P.tls, `${name}.ext`), `subjectAltName=IP:${HOST},DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`)
    openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', `/CN=frank-local-${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`])
    openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '7', '-extfile', `${name}.ext`, '-out', `${name}.pem`])
  }
}
/** Base64 SHA-256 of each certificate's public key, for Chrome's --ignore-certificate-errors-spki-list. */
function spkiList() {
  return ['ca', 'app', ...FRONTS.map(f => f.name)].map(name => {
    const der = new X509Certificate(readFileSync(join(P.tls, `${name}.pem`))).publicKey.export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(der).digest('base64')
  })
}
const certFingerprint = name => new X509Certificate(readFileSync(join(P.tls, `${name}.pem`))).fingerprint256.replace(/:/g, '').toLowerCase()

// ---------------------------------------------------------------- relays
function relayToml(name) {
  const port = name === 'relay-a' ? PORTS.relayA : PORTS.relayB
  const base = `# Generated by demo/local-stack/stack.mjs for ${name}. Loopback only, behind an HTTPS front.
host = "${HOST}:${port}"
url = "${ORIGINS[name]}/"

[registry]
db_path = "${P.relayDb(name)}"
net = "mainnet"
peers = []
public_relay_urls = []

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
`
  // Operator install: the section the operator CLI wrote for this relay, if one was installed.
  const section = join(P.operatorOut, `${name}.directory.toml`)
  if (!existsSync(join(P.operator, 'installed')) || !existsSync(section)) return base
  // The CLI writes one mode for every principal. A principal the relay has already enrolled has a
  // continuity file and must be reopened; one it has not must still be "new".
  let continuity
  const directory = readFileSync(section, 'utf8')
    .split('\n')
    .map(line => {
      const file = /^continuity_file = (".*")$/.exec(line)
      if (file) continuity = JSON.parse(file[1])
      return /^mode = /.test(line) ? `mode = "${existsSync(continuity) ? 'reopen' : 'new'}"` : line
    })
    .join('\n')
  return `${base}\n# --- operator-installed directory section (${section})\n${directory}`
}
const relayEnv = () => ({
  MONAD_TESTNET_HTTP_RPC_URL: `http://${HOST}:${PORTS.chainShim}`,
  FRANK_NETWORK_TAG: NETWORK.networkTag,
  MONAD_STAMP_BURN_ADDRESS: BURN_ADDRESS,
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
    return (await fetch(`http://${HOST}:${port}/chains`)).ok
  })
}

// ---------------------------------------------------------------- chain
const provider = () => new JsonRpcProvider(`http://${HOST}:${PORTS.chainShim}`, Number(NETWORK.chainId), { staticNetwork: true })
const devWallet = () => HDNodeWallet.fromPhrase(DEV_MNEMONIC).connect(provider())
async function fund(address, amount = '5') {
  const wallet = devWallet()
  const tx = await wallet.sendTransaction({ to: address, value: parseEther(amount) })
  await tx.wait()
  say(`funded ${address} with ${amount} local MON (tx ${tx.hash}); balance now ${formatEther(await wallet.provider.getBalance(address))}`)
  wallet.provider.destroy()
}

// ---------------------------------------------------------------- operator
const operatorCli = args => {
  const done = spawnSync(join(REPO, 'node_modules', '.bin', 'tsx'), ['--tsconfig', 'packages/bot/tsconfig.json', 'app/scripts/directory-operator.mts', ...args], { cwd: REPO, encoding: 'utf8' })
  process.stdout.write(done.stdout)
  if (done.status !== 0) die(`directory-operator ${args[0]} failed:\n${done.stderr}`)
}
function policy() {
  mkdirSync(P.operator, { recursive: true })
  mkdirSync(P.appDirectory, { recursive: true })
  // The relay tuple names a relay identity point. This preview relay holds no identity key, so the
  // operator only needs a valid public point per relay; the private halves are discarded here.
  const tuples = join(P.operator, 'relay-tuples.json')
  if (!existsSync(tuples))
    writeFileSync(tuples, JSON.stringify(RELAYS.map(processId => ({ processId, id: randomBytes(16).toString('hex'), key: new SigningKey('0x' + randomBytes(32).toString('hex')).compressedPublicKey.slice(2) })), null, 2))
  const input = {
    ...NETWORK,
    validSeconds: 3600,
    participants: ['relay-a', 'relay-b', 'bot'].map(processId => ({ processId, origin: ORIGINS[processId], trustReference: `local-stack-leaf-sha256:${certFingerprint(processId)}` })),
    // The endpoint is the bare origin. The policy parser also admits a trailing slash, but the
    // canonical mailbox client compares the signed endpoint with the slashless origin, so a
    // trailing-slash tuple can never authenticate to its inbox.
    relayTuples: JSON.parse(readFileSync(tuples, 'utf8')).map(t => ({ ...t, endpoint: ORIGINS[t.processId], expirySeconds: 7 * 24 * 3600 })),
  }
  writeFileSync(join(P.operator, 'policy-input.json'), JSON.stringify(input, null, 2))
  operatorCli(['policy', join(P.operator, 'policy-input.json'), join(P.operator, 'bootstrap-policy.json')])
  copyFileSync(join(P.operator, 'bootstrap-policy.json'), join(P.appDirectory, 'bootstrap-policy.json'))
  say(`policy served at ${ORIGINS.app}/directory/bootstrap-policy.json (exports must be made within one hour)`)
}
async function install(ui, bot) {
  ui ??= join(P.operator, 'frank-ui-public-export.json')
  bot ??= join(P.operator, 'bot-export.json')
  for (const file of [ui, bot]) if (!existsSync(file)) die(`export not found: ${file}`)
  const reinstall = existsSync(join(P.operator, 'installed'))
  operatorCli(['approve', join(P.operator, 'bootstrap-policy.json'), ui, bot, P.operatorOut, P.directoryState, 'new'])
  for (const relay of RELAYS) for (const dir of ['bundle', 'continuity']) mkdirSync(join(P.directoryState, relay, dir), { recursive: true })
  for (const relay of RELAYS) copyFileSync(join(P.operatorOut, 'approved-bundle.json'), join(P.directoryState, relay, 'bundle', 'approved-bundle.json'))
  writeFileSync(join(P.operator, 'installed'), new Date().toISOString() + '\n')
  await restartRelays()
  copyFileSync(join(P.operatorOut, 'approved-bundle.json'), join(P.appDirectory, 'approved-bundle.json'))
  say(`${reinstall ? 're' : ''}installed: both relays restarted with the directory section; bundle served at ${ORIGINS.app}/directory/approved-bundle.json`)
  say(`the bot needs: ${join(P.operator, 'bootstrap-policy.json')} and ${join(P.operatorOut, 'approved-bundle.json')}`)
}
async function restartRelays(only) {
  // The bots treat a failed inbox read as fatal, so a relay restart ends a running bot. Stop it
  // first and start it again afterwards.
  const hadBot = alive(readPids().bot)
  if (hadBot) await stop('bot')
  for (const relay of only ? [only] : RELAYS) {
    await stop(relay)
    await startRelay(relay)
    say(`${relay} restarted`)
  }
  if (hadBot) {
    await botStart()
    await waitBotStatus()
    say('the bot was stopped for the relay restart and is running again')
  }
}

// ---------------------------------------------------------------- bot
// The bot runs from a checkout that contains its canonical mode (packages/bot/README.md,
// "Canonical mode"). Its roots are disposable and generated here; nothing else creates them.
const BOT_SRC = process.env.FRANK_BOT_SRC ?? REPO
const BOT = join(STATE, 'bot')
// Exactly one bot is installed per stack: the Qwen bot ("live" on local Ollama, or "stub") or the
// blackjack dealer. The choice made at export time is remembered so restarts start the same bot.
const BOT_KINDS = { live: 'qwen', stub: 'qwen', blackjack: 'blackjack' }
const botChoice = () => (existsSync(join(BOT, 'choice')) ? readFileSync(join(BOT, 'choice'), 'utf8').trim() : undefined)
function botEnv(choice, extra) {
  const kind = BOT_KINDS[choice]
  if (!kind) die('bot must be one of: live, stub, blackjack')
  const script = kind === 'qwen' ? 'qwen-bot.livecheck.ts' : 'blackjack-bot.livecheck.ts'
  if (!existsSync(join(BOT_SRC, 'packages', 'bot', script))) die(`bot checkout not found at ${BOT_SRC} (set FRANK_BOT_SRC)`)
  mkdirSync(BOT, { recursive: true })
  const roots = join(BOT, 'roots.json')
  if (!existsSync(roots)) {
    const root = () => randomBytes(32).toString('hex')
    writeFileSync(roots, JSON.stringify({ registry: 'frank-domain-roots-v1', roots: { 'evm-wallet': root(), 'identity-authentication': root(), 'messaging-encryption': root() } }), { mode: 0o600 })
  }
  const prefix = kind === 'qwen' ? 'QWEN_BOT_' : 'BLACKJACK_BOT_'
  const named = Object.fromEntries(
    Object.entries({
      CANONICAL_ROOTS_JSON: roots,
      CANONICAL_POLICY_JSON: join(P.operator, 'bootstrap-policy.json'),
      STATE_DIR: join(BOT, 'state'),
      WALLET_STATE_DIR: join(BOT, 'wallet'),
      HANDOFF_JSON: join(BOT, 'handoff.json'),
      ...extra,
    }).map(([key, value]) => [prefix + key, value]),
  )
  const model = choice === 'live' ? { QWEN_BOT_MODE: 'live', QWEN_API_KEY: 'local-ollama-placeholder', QWEN_OPENAI_COMPATIBLE_ENDPOINT: 'http://127.0.0.1:11434/v1', QWEN_MODEL: process.env.QWEN_MODEL ?? 'qwen2.5:7b' } : choice === 'stub' ? { QWEN_BOT_MODE: 'stub' } : {}
  return { script, env: { ...named, ...model, NODE_EXTRA_CA_CERTS: P.ca } }
}
const botRun = script => [join(BOT_SRC, 'node_modules', '.bin', 'tsx'), [script], join(BOT_SRC, 'packages', 'bot')]
function botExport(choice = 'live') {
  const out = join(P.operator, 'bot-export.json')
  const { script, env } = botEnv(choice, { CANONICAL_HOME: 'relay-a', CANONICAL_EXPORT_JSON: out })
  const [tsx, args, cwd] = botRun(script)
  const done = spawnSync(tsx, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env, ...(choice === 'live' ? { QWEN_BOT_MODE: 'stub' } : {}) } })
  writeFileSync(join(P.logs, 'bot-export.log'), done.stdout + done.stderr)
  process.stdout.write(done.stdout)
  if (done.status !== 0 || !existsSync(out)) die(`bot export failed:\n${done.stdout}${done.stderr}`)
  writeFileSync(join(BOT, 'choice'), choice + '\n')
  say(`bot export (${choice}) -> ${out}`)
  return /canonical stamp account to fund: (0x[0-9a-fA-F]{40})/.exec(done.stdout)?.[1]
}
/** The dealer pays winnings from a separate plain key; the launcher makes a disposable one. */
function bankroll() {
  const file = join(BOT, 'bankroll.json')
  if (!existsSync(file)) {
    const key = new SigningKey('0x' + randomBytes(32).toString('hex'))
    writeFileSync(file, JSON.stringify({ address: computeAddress(key), privateKey: key.privateKey }), { mode: 0o600 })
  }
  return { file, address: JSON.parse(readFileSync(file, 'utf8')).address }
}
async function botStart(choice = botChoice() ?? 'live') {
  if (botChoice() && BOT_KINDS[choice] !== BOT_KINDS[botChoice()]) die(`this stack's installed bot is "${botChoice()}"; "${choice}" needs a fresh "up" and its own export`)
  const common = { CANONICAL_BUNDLE_JSON: join(P.operatorOut, 'approved-bundle.json'), CANONICAL_STATUS_PORT: String(PORTS.bot), STAMP_VALUE_WEI: '10000000000000000', POLL_INTERVAL_MS: '2000' }
  const { script, env } = botEnv(choice, BOT_KINDS[choice] === 'blackjack' ? { ...common, BANKROLL_WALLET_JSON: bankroll().file, IDLE_TIMEOUT_MS: '86400000', CANONICAL_PROFILE: '0' } : common)
  const [tsx, args, cwd] = botRun(script)
  start('bot', tsx, args, { ...env, ...(process.env.LOCAL_STACK_DEBUG_FATAL ? { LOCAL_STACK_DEBUG_FATAL: '1' } : {}) }, cwd)
  say(`bot started (${choice}); log ${join(P.logs, 'bot.log')}`)
}
async function waitBotStatus() {
  const bundle = JSON.parse(readFileSync(join(P.operatorOut, 'approved-bundle.json'), 'utf8')).bundleIdentity
  await waitFor('bot installation status', async () => {
    if (!alive(readPids().bot)) die(`the bot exited; see ${join(P.logs, 'bot.log')}`)
    return spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--cacert', P.ca, `${ORIGINS.bot}/directory-installation/${bundle}`], { encoding: 'utf8' }).stdout === '200'
  }, 90)
}

// ---------------------------------------------------------------- lifecycle
async function down() {
  for (const name of Object.keys(readPids()).reverse()) await stop(name)
  say('all stack processes stopped')
}
async function up() {
  if (Object.values(readPids()).some(alive)) die('the stack is already running; run "down" first')
  if (!existsSync(join(P.appDist, 'index.html'))) die('app build not found; run "build" first')
  if (!existsSync(join(P.chainDir, 'node_modules', '.bin', 'hardhat'))) die('local chain not installed; run "build" first')
  // A fresh start every time: the local chain keeps no state across restarts, so relay databases,
  // directory state and browser profiles from an earlier run would no longer match it.
  for (const dir of [P.run, P.tls, P.relay('relay-a'), P.relay('relay-b'), P.directoryState, P.operator, P.appDirectory, BOT, P.chromeProfile, join(STATE, 'chrome-profile-manual')]) rmSync(dir, { recursive: true, force: true })
  for (const dir of [P.logs, P.run, P.shots, P.appDirectory]) mkdirSync(dir, { recursive: true })
  for (const name of ['chain', 'chain-shim', 'clock', 'relay-a', 'relay-b', 'fronts', 'bot', 'bot-export']) rmSync(join(P.logs, `${name}.log`), { force: true })
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
  start('clock', process.execPath, [join(HERE, 'clock.mjs'), ...RELAYS.map(relay => join(P.directoryState, relay, 'clock'))])
  for (const relay of RELAYS) await startRelay(relay)
  start('fronts', process.execPath, [join(HERE, 'fronts.mjs')])
  await waitFor('HTTPS fronts', async () => {
    const done = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--cacert', P.ca, `${ORIGINS['relay-a']}/chains`], { encoding: 'utf8' })
    return done.stdout === '200'
  })
  policy()
  say('')
  await status()
  say(`
next (or run "e2e" / "e2e-blackjack" to have all of it driven for you):
  1. node demo/local-stack/stack.mjs chrome
  2. create an account; Settings -> Networking -> "Export public directory evidence"; download the file
  3. node demo/local-stack/stack.mjs provision <frank-ui-public-export.json> [live|stub|blackjack]
  4. node demo/local-stack/stack.mjs fund <the address on the app's Receive page>
  5. in the app: Settings -> Networking -> "Check installation", then Add Contact with the bot address shown`)
}
async function status() {
  const pids = readPids()
  for (const name of ['chain', 'chain-shim', 'clock', 'relay-a', 'relay-b', 'fronts', 'bot']) say(`  ${name.padEnd(11)} ${alive(pids[name]) ? `running (pid ${pids[name].pid})` : 'stopped'}`)
  say(`  app         ${ORIGINS.app}/`)
  for (const name of ['relay-a', 'relay-b', 'bot']) say(`  ${name.padEnd(11)} ${ORIGINS[name]}/${name === 'bot' ? `  (front only; expects the bot's status server on http://${HOST}:${PORTS.bot})` : ''}`)
  say(`  chain       http://${HOST}:${PORTS.chainShim} (chain id ${NETWORK.chainId}; dev account ${HDNodeWallet.fromPhrase(DEV_MNEMONIC).address})`)
  say(`  CA          ${P.ca}  (Node clients: NODE_EXTRA_CA_CERTS=${P.ca})`)
  say(`  logs        ${P.logs}   state ${STATE}`)
}
const chromeArgs = profile => ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spkiList().join(',')}`]
function chrome(which) {
  const binary = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  // "driven" opens the profile the driver used (account already created, installed and funded by
  // "e2e"); the default is an empty profile for doing every step by hand.
  const profile = which === 'driven' ? P.chromeProfile : join(STATE, 'chrome-profile-manual')
  const child = spawn(binary, [...chromeArgs(profile), `${ORIGINS.app}/`], { detached: true, stdio: 'ignore' })
  child.unref()
  say(`Chrome started (pid ${child.pid}) with profile ${profile}; it trusts only this stack's certificates.`)
  say('Quit that Chrome window before running the driver again or "up"; "up" deletes both profiles.')
}
/** Bot export, operator approval and install, funding and start of the chosen bot. */
async function provisionBot(ui, choice) {
  const stampAccount = botExport(choice)
  if (!stampAccount) die('the bot did not print its stamp account')
  await install(ui)
  await fund(stampAccount)
  if (BOT_KINDS[choice] === 'blackjack') await fund(bankroll().address, '50')
  await botStart(choice)
  await waitBotStatus()
}
/** After a person exported the UI evidence by hand: everything the operator and the bot then do. */
async function provision(ui, choice = 'live') {
  if (!ui || !existsSync(ui)) die('usage: provision <frank-ui-public-export.json> [live|stub|blackjack]')
  await provisionBot(ui, choice)
  say('now: fund the address on the app\'s Receive page ("fund <address>"), then Settings -> Networking -> "Check installation"')
}
const drive = (...phase) => {
  say(`\n== drive ${phase.join(' ')}`)
  const done = spawnSync(process.execPath, [join(HERE, 'drive.cjs'), ...phase], { stdio: 'inherit', env: process.env })
  if (done.status !== 0) die(`driver phase "${phase[0]}" failed; see ${join(P.logs, `drive-${phase[0]}.json`)} and ${P.shots}`)
}
async function driveToReady(choice) {
  await up()
  drive('export')
  await provisionBot(undefined, choice)
  drive('check')
  drive('address')
  await fund(readFileSync(join(P.operator, 'ui-wallet-address.txt'), 'utf8').trim())
}
// The whole flow from clean state, with the browser steps driven in headless Chrome.
async function e2e(choice = 'live', message) {
  if (BOT_KINDS[choice] !== 'qwen') die('usage: e2e [live|stub] ["message"]')
  const started = Date.now()
  await driveToReady(choice)
  drive('chat', ...(message ? [message] : []))
  say(`\ne2e finished in ${Math.round((Date.now() - started) / 1000)} s; the stack is still up (policy valid one hour from "up")`)
}
/** Run a driver phase in the background and call `during` once it reports that it is paused. */
async function driveWithInterruption(label, plan, settleMs, during) {
  say(`\n== drive blackjack ${plan} (${label})`)
  const gate = join(P.run, 'blackjack-resume')
  for (const file of [gate, gate + '.waiting']) rmSync(file, { force: true })
  const child = spawn(process.execPath, [join(HERE, 'drive.cjs'), 'blackjack', plan], { stdio: 'inherit', env: { ...process.env, BJ_PAUSE_AFTER_BET: gate, BJ_PAUSE_SETTLE_MS: String(settleMs), DRIVE_REPORT: `drive-blackjack-${label}.json`, SHOT_PREFIX: label + '-' } })
  const exited = new Promise(resolve => child.on('exit', resolve))
  let code
  exited.then(c => (code = c))
  await waitFor('the driver to pause after its bet', () => code !== undefined || existsSync(gate + '.waiting'), 240)
  if (code !== undefined) die(`driver failed before pausing (${label})`)
  await during()
  writeFileSync(gate, '')
  if ((await exited) !== 0) die(`driver failed after the interruption (${label}); see ${join(P.logs, `drive-blackjack-${label}.json`)}`)
}
async function kill9(name) {
  const entry = readPids()[name]
  if (!alive(entry)) die(`${name} is not running`)
  process.kill(-entry.pid, 'SIGKILL')
  for (let i = 0; i < 50 && alive(entry); i++) await delay(100)
  const pids = readPids()
  delete pids[name]
  writePids(pids)
  say(`${name} killed with SIGKILL`)
}
/** Hostile cases on a provisioned blackjack stack: dealer killed mid-hand, relay-a restarted mid-hand. */
async function blackjackHostile() {
  // Kill the dealer once the wager is on chain: at two points, before it can have read the bet
  // message and a few seconds later, when it has dealt and may be mid-reply.
  for (const [label, settleMs] of [['kill-early', 0], ['kill-late', Number(process.env.BJ_KILL_LATE_MS ?? 6000)]])
    await driveWithInterruption(label, 'basic', settleMs, async () => {
      await kill9('bot')
      await delay(3000)
      await botStart()
      await waitBotStatus()
    })
  await driveWithInterruption('relay-restart', 'basic', 0, () => restartRelays('relay-a'))
}
async function e2eBlackjack(plan = 'limits,spam,double,basic,basic,hit2') {
  const started = Date.now()
  await driveToReady('blackjack')
  drive('blackjack', plan)
  if (!process.env.BJ_SKIP_HOSTILE) await blackjackHostile()
  say(`\ne2e-blackjack finished in ${Math.round((Date.now() - started) / 1000)} s; the stack is still up (policy valid one hour from "up")`)
}

const [command, ...args] = process.argv.slice(2)
mkdirSync(P.logs, { recursive: true })
mkdirSync(P.run, { recursive: true })
const commands = {
  build,
  up,
  down,
  status,
  policy,
  'install': () => install(args[0], args[1]),
  'bot-export': () => botExport(args[0]),
  'bot-start': () => botStart(args[0]),
  'balance': async () => {
    const p = provider()
    for (const a of args) say(`${a} ${formatEther(await p.getBalance(a))}`)
    p.destroy()
  },
  'bot-stop': () => stop('bot'),
  'restart-shim': async () => {
    await stop('chain-shim')
    start('chain-shim', process.execPath, [join(HERE, 'chain-shim.mjs')])
  },
  'restart-relays': () => restartRelays(args[0]),
  'fund': () => (/^0x[0-9a-fA-F]{40}$/.test(args[0] ?? '') ? fund(args[0], args[1]) : die('usage: fund <0xaddress> [MON]')),
  'chrome': () => chrome(args[0]),
  'provision': () => provision(args[0], args[1]),
  'e2e': () => e2e(args[0], args[1]),
  'e2e-blackjack': () => e2eBlackjack(args[0]),
  'blackjack-hostile': blackjackHostile,
  'chrome-args': () => say(JSON.stringify(chromeArgs(args[0] ?? P.chromeProfile))),
}
if (!commands[command]) die(`usage: stack.mjs ${Object.keys(commands).join('|')}`)
await commands[command]()
