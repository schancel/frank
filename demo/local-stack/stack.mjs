#!/usr/bin/env node
// Launcher for the local end-to-end stack: two native relays, a local EVM chain, loopback HTTPS
// fronts, and the production app build. See README.md in this directory.
//
//   node demo/local-stack/stack.mjs build            build cashwebd (one cargo slot) and the app
//   node demo/local-stack/stack.mjs up               wipe state, start everything, write the policy
//   node demo/local-stack/stack.mjs status
//   node demo/local-stack/stack.mjs policy           (re)write the bootstrap policy (valid 1 hour)
//   node demo/local-stack/stack.mjs bot-export       write the Qwen bot's public export (disposable roots)
//   node demo/local-stack/stack.mjs install [ui-export.json] [bot-export.json]
//   node demo/local-stack/stack.mjs bot-start [live|stub]   run the Qwen bot (live = local Ollama)
//   node demo/local-stack/stack.mjs bot-stop
//   node demo/local-stack/stack.mjs restart-relays
//   node demo/local-stack/stack.mjs fund <0xaddress> [MON]
//   node demo/local-stack/stack.mjs chrome           open a throwaway-profile Chrome on the app
//   node demo/local-stack/stack.mjs down
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HDNodeWallet, JsonRpcProvider, SigningKey, formatEther, parseEther } from 'ethers'
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
    relayTuples: JSON.parse(readFileSync(tuples, 'utf8')).map(t => ({ ...t, endpoint: `${ORIGINS[t.processId]}/`, expirySeconds: 7 * 24 * 3600 })),
  }
  writeFileSync(join(P.operator, 'policy-input.json'), JSON.stringify(input, null, 2))
  operatorCli(['policy', join(P.operator, 'policy-input.json'), join(P.operator, 'bootstrap-policy.json')])
  copyFileSync(join(P.operator, 'bootstrap-policy.json'), join(P.appDirectory, 'bootstrap-policy.json'))
  say(`policy served at ${ORIGINS.app}/directory/bootstrap-policy.json (exports must be made within one hour)`)
}
async function install(ui = join(P.operator, 'frank-ui-public-export.json'), bot = join(P.operator, 'bot-export.json')) {
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
async function restartRelays() {
  for (const relay of RELAYS) {
    await stop(relay)
    await startRelay(relay)
  }
}

// ---------------------------------------------------------------- bot
// The bot runs from a checkout that contains its canonical mode (packages/bot/README.md,
// "Canonical mode"). Its roots are disposable and generated here; nothing else creates them.
const BOT_SRC = process.env.FRANK_BOT_SRC ?? join(STATE, 'bot-src')
const BOT = join(STATE, 'bot')
function botEnv(extra) {
  const roots = join(BOT, 'roots.json')
  if (!existsSync(join(BOT_SRC, 'packages', 'bot', 'qwen-bot.livecheck.ts'))) die(`bot checkout not found at ${BOT_SRC} (set FRANK_BOT_SRC)`)
  if (!existsSync(roots)) {
    mkdirSync(BOT, { recursive: true })
    const root = () => randomBytes(32).toString('hex')
    writeFileSync(roots, JSON.stringify({ registry: 'frank-domain-roots-v1', roots: { 'evm-wallet': root(), 'identity-authentication': root(), 'messaging-encryption': root() } }), { mode: 0o600 })
  }
  return {
    QWEN_BOT_CANONICAL_ROOTS_JSON: roots,
    QWEN_BOT_CANONICAL_POLICY_JSON: join(P.operator, 'bootstrap-policy.json'),
    QWEN_BOT_STATE_DIR: join(BOT, 'state'),
    QWEN_BOT_WALLET_STATE_DIR: join(BOT, 'wallet'),
    QWEN_BOT_HANDOFF_JSON: join(BOT, 'handoff.json'),
    NODE_EXTRA_CA_CERTS: P.ca,
    ...extra,
  }
}
const botCommand = () => [join(BOT_SRC, 'node_modules', '.bin', 'tsx'), ['qwen-bot.livecheck.ts'], join(BOT_SRC, 'packages', 'bot')]
function botExport() {
  const [tsx, args, cwd] = botCommand()
  const out = join(P.operator, 'bot-export.json')
  const done = spawnSync(tsx, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...botEnv({ QWEN_BOT_MODE: 'stub', QWEN_BOT_CANONICAL_HOME: 'relay-a', QWEN_BOT_CANONICAL_EXPORT_JSON: out }) } })
  writeFileSync(join(P.logs, 'bot-export.log'), done.stdout + done.stderr)
  process.stdout.write(done.stdout)
  if (done.status !== 0 || !existsSync(out)) die(`bot export failed:\n${done.stderr}`)
  say(`bot export -> ${out}`)
}
async function botStart(mode = 'live') {
  if (!['live', 'stub'].includes(mode)) die('usage: bot-start [live|stub]')
  const [tsx, args, cwd] = botCommand()
  const model = mode === 'live' ? { QWEN_BOT_MODE: 'live', QWEN_API_KEY: 'local-ollama-placeholder', QWEN_OPENAI_COMPATIBLE_ENDPOINT: 'http://127.0.0.1:11434/v1', QWEN_MODEL: process.env.QWEN_MODEL ?? 'qwen2.5:7b' } : { QWEN_BOT_MODE: 'stub' }
  start('bot', tsx, args, botEnv({ ...model, QWEN_BOT_CANONICAL_BUNDLE_JSON: join(P.operatorOut, 'approved-bundle.json'), QWEN_BOT_CANONICAL_STATUS_PORT: String(PORTS.bot), QWEN_BOT_STAMP_VALUE_WEI: '10000000000000000', QWEN_BOT_POLL_INTERVAL_MS: '2000' }), cwd)
  say(`bot started (${mode}); log ${join(P.logs, 'bot.log')}`)
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
next:
  1. node demo/local-stack/stack.mjs chrome     (or: node demo/local-stack/drive.cjs export)
  2. create an account, Settings -> Networking -> "Export public directory evidence", save the JSON
  3. produce the bot export against ${join(P.operator, 'bootstrap-policy.json')}
  4. node demo/local-stack/stack.mjs install <ui-export.json> <bot-export.json>
  5. node demo/local-stack/stack.mjs fund <the account's main EVM address>
  6. in the app: Settings -> Networking -> "Check installation"`)
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
function chrome() {
  const binary = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = join(STATE, 'chrome-profile-manual')
  const child = spawn(binary, [...chromeArgs(profile), `${ORIGINS.app}/`], { detached: true, stdio: 'ignore' })
  child.unref()
  say(`Chrome started (pid ${child.pid}) with throwaway profile ${profile}; it trusts only this stack's certificates.`)
  say('Quit that Chrome window when finished; "up" does not reuse this profile after a restart of the stack.')
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
  'bot-export': botExport,
  'bot-start': () => botStart(args[0]),
  'bot-stop': () => stop('bot'),
  'restart-relays': restartRelays,
  'fund': () => (/^0x[0-9a-fA-F]{40}$/.test(args[0] ?? '') ? fund(args[0], args[1]) : die('usage: fund <0xaddress> [MON]')),
  chrome,
  'chrome-args': () => say(JSON.stringify(chromeArgs(args[0] ?? P.chromeProfile))),
}
if (!commands[command]) die(`usage: stack.mjs ${Object.keys(commands).join('|')}`)
await commands[command]()
