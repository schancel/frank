// Test-side helpers for the ordinary, packaged Monad-testnet UI. No session/store imports.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  lstat,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import { FetchRequest, JsonRpcProvider } from 'ethers'

const WEI = 10n ** 18n
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const MARKER = 'frank-account.json'
const SCHEMA = 'frank/browser-fixture/v1'

export function monWei(value) {
  const match =
    typeof value === 'string' && /^(0|[1-9]\d*)(?:\.(\d{1,18}))?$/.exec(value)
  if (!match) throw new Error('Expected an exact nonnegative MON decimal')
  return BigInt(match[1]) * WEI + BigInt((match[2] ?? '').padEnd(18, '0'))
}

export function mon(value) {
  if (typeof value !== 'bigint' || value < 0n)
    throw new Error('Expected a nonnegative wei amount')
  const fraction = (value % WEI).toString().padStart(18, '0').replace(/0+$/, '')
  return (value / WEI).toString() + (fraction ? '.' + fraction : '')
}

function exactTitle(value) {
  const match = /^(\d+(?:\.\d{1,18})?) MONT$/.exec(value ?? '')
  if (!match) throw new Error('Exact Monad-testnet balance is not available')
  return monWei(match[1])
}

export function absoluteFixturePath(value, label) {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value === '/')
    throw new Error(
      `${label} must be an explicit canonical absolute fixture path`,
    )
  return value
}

// Root owns the fixture servers, TLS and source admission. Rules only prevent silent public DNS.
export function browserFixture(env = process.env) {
  let origin
  try {
    origin = new URL(env.ACCOUNT_APP_ORIGIN ?? '')
  } catch {
    throw new Error('An explicit valid isolated app origin is required')
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    !(
      (local && ['http:', 'https:'].includes(origin.protocol)) ||
      origin.origin === 'https://signet.mx'
    )
  )
    throw new Error(
      'Explicit app origin must be the isolated final origin or a loopback fixture',
    )
  const hosts = new Set()
  const rules = String(env.E2E_BROWSER_RESOLVER_RULES ?? '')
    .split(',')
    .map(x => x.trim())
  if (rules.length !== 2)
    throw new Error(
      'Explicit app and relay fixture resolver rules are required',
    )
  for (const rule of rules) {
    const match = /^MAP (signet\.mx|relay\.signet\.mx) ([0-9.]+)$/.exec(rule)
    const ip = match?.[2]
    const octets = ip?.split('.').map(Number)
    if (
      !match ||
      isIP(ip) !== 4 ||
      hosts.has(match[1]) ||
      !(
        octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)
      )
    )
      throw new Error(
        'Resolver rules must map both exact hosts to private fixture IPv4 addresses',
      )
    hosts.add(match[1])
  }
  return {
    origin: origin.origin,
    resolverArgument: '--host-resolver-rules=' + rules.join(', '),
  }
}

async function smallJson(path) {
  const facts = await lstat(path)
  if (!facts.isFile() || facts.isSymbolicLink() || facts.size > 4096)
    throw new Error('Fixture marker is not a bounded regular file')
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(4097)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 4096) throw new Error('Fixture marker exceeds its bound')
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await file.close()
  }
}

function publicAccount(account) {
  if (
    !account ||
    typeof account.profile !== 'string' ||
    typeof account.receive !== 'string' ||
    !ADDRESS.test(account.profile) ||
    !ADDRESS.test(account.receive) ||
    Object.keys(account).some(key => !['profile', 'receive'].includes(key))
  )
    throw new Error('Fixture account marker is invalid; preserve the profile')
  return {
    profile: account.profile.toLowerCase(),
    receive: account.receive.toLowerCase(),
  }
}

export async function persistentProfile(check) {
  const directory = absoluteFixturePath(
    process.env.E2E_PROFILE_DIR,
    'E2E_PROFILE_DIR',
  )
  const { origin } = browserFixture()
  if (!/^[a-z0-9-]{1,64}$/.test(check))
    throw new Error('Invalid fixture check name')
  let fresh = false
  try {
    await lstat(directory)
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('Fixture directory could not be inspected')
    // Never adopt an existing directory, even if it is empty or its marker is missing.
    await mkdir(directory, { mode: 0o700 })
    fresh = true
  }
  const facts = await lstat(directory)
  if (
    !facts.isDirectory() ||
    facts.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    throw new Error('Fixture profile must be a canonical owned directory')
  const marker = join(directory, MARKER)
  let saved
  if (fresh) {
    saved = {
      schema: SCHEMA,
      owner: randomUUID(),
      check,
      origin,
      chainIdentifier: 'monad-testnet',
      account: null,
    }
    await writeFile(marker, JSON.stringify(saved), { mode: 0o600, flag: 'wx' })
  } else {
    try {
      saved = await smallJson(marker)
    } catch {
      throw new Error(
        'Existing fixture marker is missing or malformed; profile preserved, no new account',
      )
    }
    if (
      saved.schema !== SCHEMA ||
      saved.check !== check ||
      saved.origin !== origin ||
      saved.chainIdentifier !== 'monad-testnet' ||
      typeof saved.owner !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(saved.owner)
    )
      throw new Error(
        'Existing fixture ownership does not match; profile preserved',
      )
    saved.account = publicAccount(saved.account)
  }
  return {
    directory,
    fresh,
    get account() {
      return saved.account
    },
    async recordAccount(addresses) {
      const account = publicAccount(addresses)
      if (
        saved.account &&
        JSON.stringify(saved.account) !== JSON.stringify(account)
      )
        throw new Error(
          'Fixture identity changed; no replacement account accepted',
        )
      const observed = await smallJson(marker)
      if (JSON.stringify(observed) !== JSON.stringify(saved))
        throw new Error('Fixture marker changed')
      const next = { ...saved, account }
      const temporary = marker + '.' + randomUUID()
      await writeFile(temporary, JSON.stringify(next), {
        mode: 0o600,
        flag: 'wx',
      })
      await rename(temporary, marker)
      saved = next
    },
  }
}

// Unknown console/error bodies are omitted by consumers; only selected public evidence uses this.
export function evidenceUrl(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol))
      return '[URL scheme omitted]'
    const path = url.pathname.replace(
      /(\/chain-rpc\/[^/]+\/cap\/)[^/]+/g,
      '$1[redacted]',
    )
    return (url.protocol + '//' + url.host + path).slice(0, 512)
  } catch {
    return '[invalid URL omitted]'
  }
}

export function appendEvidence(list, value) {
  if (list.length < 200) list.push(String(value).slice(0, 512))
}

export async function scanBackendLog(path, offset) {
  const initial = await lstat(path)
  if (!initial.isFile() || initial.isSymbolicLink())
    return ['[backend log is not a regular fixture file]']
  const file = await open(path, 'r')
  const errors = []
  let consumed = 0
  let pending = ''
  try {
    const facts = await file.stat()
    if (!facts.isFile() || offset < 0 || offset > facts.size)
      return ['[backend log replaced or unavailable]']
    const buffer = Buffer.alloc(65536)
    for (;;) {
      if (consumed >= 1048576) {
        appendEvidence(
          errors,
          '[backend log evidence limit; not fully verified]',
        )
        break
      }
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
        offset + consumed,
      )
      if (!bytesRead) break
      consumed += bytesRead
      const content = pending + buffer.subarray(0, bytesRead).toString('utf8')
      if (
        /ERROR|panic|unhandledRejection|FAILED to start|could not be started|FUNDING WALLET EXHAUSTED|QWEN BOT FAILED/.test(
          content,
        )
      )
        appendEvidence(errors, '[backend error marker; body omitted]')
      pending = content.slice(-64)
    }
    if (/ERROR|panic|unhandledRejection/.test(pending))
      appendEvidence(errors, '[backend error marker; body omitted]')
    return errors
  } finally {
    await file.close()
  }
}

export async function readPublicAccount(page) {
  await page.evaluate(`location.hash = '#/qr'`)
  await page.until(
    `!!document.querySelector('[data-test="identity-address-input"] input')?.value`,
    60000,
    'public identity ready',
  )
  const profile = await page.evaluate(
    `document.querySelector('[data-test="identity-address-input"] input').value`,
  )
  await page.evaluate(`location.hash = '#/wallet/monad'`)
  await page.until(
    `!!document.querySelector('[data-testid="wallet-copy-address"]')?.closest('.q-field')?.querySelector('input')?.value`,
    60000,
    'public receive address ready',
  )
  const receive = await page.evaluate(
    `document.querySelector('[data-testid="wallet-copy-address"]').closest('.q-field').querySelector('input').value`,
  )
  return publicAccount({ profile, receive })
}

export async function readWalletState(page) {
  const state = await page.evaluate(`(() => {
    const balance = document.querySelector('[data-testid="wallet-balance"]');
    return {
      gross: balance?.getAttribute('title'), display: balance?.textContent?.trim(),
      available: document.querySelector('[data-testid="wallet-available"] span[title]')?.getAttribute('title'),
      receive: document.querySelector('[data-testid="wallet-copy-address"]')?.closest('.q-field')?.querySelector('input')?.value,
      unavailable: !!document.querySelector('[data-testid="wallet-chain-unreachable"], [data-testid="wallet-balance-error"], [data-test="monad-balance-stale-indicator"]'),
      pending: !!document.querySelector('[data-testid="wallet-pending-operations"]')
    };
  })()`)
  if (
    !state ||
    state.unavailable ||
    !/^<?\d[\d.,\s]*(?:[kKmMbB])?(?:\s+MONT)?$/.test(state.display ?? '') ||
    !ADDRESS.test(state.receive ?? '')
  )
    throw new Error('Fresh owned and available balances are not verified')
  return {
    grossWei: exactTitle(state.gross),
    availableWei: exactTitle(state.available),
    receive: state.receive.toLowerCase(),
    pending: state.pending,
  }
}

async function historyRows(page) {
  await page.evaluate(`location.hash = '#/wallet/monad?tab=history'`)
  await page.until(
    `!!document.querySelector('[data-testid="wallet-activity-list"], [data-testid="wallet-activity-empty"]')`,
    20000,
    'wallet history ready',
  )
  return page.evaluate(`Array.from(document.querySelectorAll('[data-activity-id]')).map(row => ({
    id: row.getAttribute('data-activity-id'),
    hashes: Array.from(row.querySelectorAll('[title]')).map(el => el.getAttribute('title')).filter(value => /^0x[0-9a-fA-F]{64}$/.test(value ?? ''))
  }))`)
}

// EVM receipt/transaction value is the credit evidence, never a wallet balance decrease or page navigation.
export async function creditedPayment(provider, hashes, recipient, valueWei) {
  if (hashes.length > 64)
    throw new Error('Original transaction evidence exceeds its bound')
  let credited = 0n
  const included = []
  for (const hash of new Set(hashes)) {
    if (!HASH.test(hash))
      throw new Error('Invalid original transaction identity')
    const tx = await provider.getTransaction(hash)
    const receipt = await provider.getTransactionReceipt(hash)
    if (
      !tx ||
      !receipt ||
      receipt.status !== 1 ||
      tx.chainId !== 10143n ||
      !receipt.blockHash ||
      tx.hash?.toLowerCase() !== hash.toLowerCase() ||
      receipt.hash?.toLowerCase() !== hash.toLowerCase() ||
      tx.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()
    )
      continue
    if (tx.to?.toLowerCase() === recipient.toLowerCase()) {
      credited += tx.value
      included.push(hash)
    }
  }
  return credited === valueWei && credited > 0n
    ? { creditedWei: credited, transactionHashes: included }
    : undefined
}

function fundTool(repoRoot, args, timeout) {
  return new Promise((resolveRun, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'packages/bot/demo/fund.ts', ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: 'packages/bot/tsconfig.json',
        },
        timeout,
        maxBuffer: 65536,
      },
      (error, stdout) =>
        error
          ? reject(
              new Error(
                'Test funding tool failed; existing operations and profile retained',
              ),
            )
          : resolveRun(stdout.trim()),
    )
  })
}

export function testFunds({ repoRoot, directory, profile, page, stop }) {
  let fundedWei = 0n
  let finished
  let info
  let provider
  let verifiedNetwork
  let fundingAttempted = false
  let uncertainPayment = false
  const chain = () =>
    (verifiedNetwork ??= (async () => {
      const rpc = process.env.MONAD_TESTNET_HTTP_RPC_URL
      if (!rpc || rpc.includes(','))
        throw new Error(
          'One explicit testnet RPC is required for receipt verification',
        )
      let url
      try {
        url = new URL(rpc)
      } catch {
        throw new Error('Invalid testnet RPC; no payment authorized')
      }
      if (
        url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        )
      )
        throw new Error(
          'Testnet RPC must use HTTPS or an isolated loopback fixture',
        )
      const request = new FetchRequest(rpc)
      request.timeout = 15000
      provider = new JsonRpcProvider(request)
      const registryFile = await open(
        join(repoRoot, 'docs/protocol/chains/v1.json'),
        'r',
      )
      let registry
      try {
        const bytes = Buffer.alloc(262145)
        const { bytesRead } = await registryFile.read(bytes, 0, bytes.length, 0)
        if (bytesRead > 262144)
          throw new Error('Protocol registry exceeds its bound')
        registry = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
      } finally {
        await registryFile.close()
      }
      const identity = registry.chains.find(row => row.id === 'monad-testnet')
      const checkpoint = identity?.identity_probes.find(
        probe => probe.kind === 'block-hash' && probe.height === 0,
      )
      if (
        !checkpoint ||
        (await provider.getNetwork()).chainId !==
          BigInt(identity.native_chain_id) ||
        (await provider.getBlock(0))?.hash?.toLowerCase() !==
          checkpoint.expected.toLowerCase()
      )
        throw new Error(
          'Testnet RPC identity/checkpoint mismatch; no payment authorized',
        )
      return provider
    })())
  const testWallet = () =>
    (info ??= fundTool(repoRoot, ['--info'], 60000).then(out => {
      const parsed = JSON.parse(out)
      if (
        typeof parsed.address !== 'string' ||
        !ADDRESS.test(parsed.address) ||
        typeof parsed.floatWei !== 'string' ||
        !/^\d+$/.test(parsed.floatWei)
      )
        throw new Error('Invalid public test-wallet information')
      return {
        address: parsed.address.toLowerCase(),
        floatWei: BigInt(parsed.floatWei),
      }
    }))
  const snapshot = async () => {
    await page.evaluate(`location.hash = '#/wallet/monad'`)
    await page.until(
      `!!document.querySelector('[data-testid="wallet-available"] span[title]')?.getAttribute('title')`,
      60000,
      'exact wallet amounts loaded',
    )
    const state = await readWalletState(page)
    if (!profile.account || state.receive !== profile.account.receive)
      throw new Error('Fixture receive identity changed; no payment authorized')
    return state
  }
  const spendable = async () => (await snapshot()).availableWei
  const owned = async () => (await snapshot()).grossWei

  async function sendFromPage(to, amountMon) {
    if (uncertainPayment)
      throw new Error(
        'Original payment remains uncertain; no replacement authorized',
      )
    if (!ADDRESS.test(to)) throw new Error('Invalid test return recipient')
    const valueWei = monWei(amountMon)
    if (!valueWei) throw new Error('A test return must be positive')
    const rpc = await chain()
    const state = await snapshot()
    if (state.pending || state.availableWei < valueWei)
      throw new Error(
        'Existing pending/insufficient operation retained; no new return',
      )
    const previous = new Set((await historyRows(page)).map(row => row.id))
    await page.evaluate(
      `location.hash = '#/send?chainIdentifier=monad-testnet'`,
    )
    await page.typeInput('[data-test="send-address-input"]', to)
    await page.typeInput('[data-test="send-amount-input"]', mon(valueWei))
    await page.click('[data-test="send-review-button"]')
    await page.until(
      `(() => { const b = document.querySelector('[data-test="review-confirm-button"]'); return b && !b.disabled && !b.classList.contains('q-btn--loading') })()`,
      20000,
      'confirm ready',
    )
    const review = await page.evaluate(
      `({ recipient: document.querySelector('[data-test="review-recipient"]')?.textContent?.trim(), amount: document.querySelector('[data-test="review-amount"]')?.textContent?.trim() })`,
    )
    if (
      review.recipient?.toLowerCase() !== to.toLowerCase() ||
      exactTitle(review.amount) !== valueWei
    )
      throw new Error('Return review differs; no payment authorized')
    uncertainPayment = true
    await page.click('[data-test="review-confirm-button"]') // Exactly once, even after timeout.
    await page.until(
      `location.hash.split('?')[0] !== '#/send' || /sent on|reverted/i.test(document.querySelector('[data-test="native-operation-outcome"]')?.textContent ?? '')`,
      120000,
      'original return operation outcome',
    )
    let original
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      const rows = (await historyRows(page)).filter(
        row => row.id.startsWith('native:') && !previous.has(row.id),
      )
      if (!original && rows.length === 1) original = rows[0].id
      if (rows.length > 1)
        throw new Error('Ambiguous original return operation; profile retained')
      const row = rows.find(candidate => candidate.id === original)
      if (row) {
        const receipt = await creditedPayment(rpc, row.hashes, to, valueWei)
        if (receipt) {
          uncertainPayment = false
          return { operationId: original, ...receipt }
        }
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 2000))
    }
    throw new Error(
      'Original return not verified; do not create a replacement payment',
    )
  }

  const finish = () =>
    (finished ??= (async () => {
      let returnedWei = 0n
      let held
      let why = 'return not verified; original operations and profile retained'
      try {
        const state = await snapshot()
        if (state.pending || uncertainPayment) {
          why = 'pending or ambiguous operations retained; no new return'
          process.exitCode = 1
        } else {
          const target = await testWallet()
          if (state.availableWei <= target.floatWei + monWei('0.005'))
            why = 'owned fixture float retained'
          else {
            const receipt = await sendFromPage(
              target.address,
              mon(state.availableWei - target.floatWei),
            )
            returnedWei = receipt.creditedWei
            why = 'original return transaction credit verified'
          }
        }
      } catch {
        process.exitCode = 1
      } finally {
        held = await owned().catch(() => undefined)
        provider?.destroy()
      }
      console.log(
        `[funds] funded ${mon(fundedWei)} MON, recipient credited ${mon(
          returnedWei,
        )} MON, left ${
          held === undefined ? 'unverified' : mon(held) + ' MON'
        } in the persistent fixture ${directory} (${why}; profile preserved)`,
      )
      return { fundedWei, returnedWei, heldWei: held, reason: why }
    })())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.once(signal, () => {
      void finish()
        .finally(() => stop?.())
        .finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
    })
  return {
    testWallet,
    spendable,
    owned,
    sendFromPage,
    finish,
    async ensure(needWei) {
      if (typeof needWei !== 'bigint' || needWei <= 0n)
        throw new Error('Invalid exact fixture funding target')
      const state = await snapshot()
      if (state.pending || uncertainPayment)
        throw new Error(
          'Pending operations retained; no duplicate fixture funding',
        )
      if (state.availableWei >= needWei) return undefined
      if (fundingAttempted)
        throw new Error(
          'Funding was already attempted; reconcile it instead of retrying',
        )
      const missing = needWei - state.availableWei
      const configuredMax =
        process.env.FRANK_TEST_MAX_FUND_WEI ?? '500000000000000000'
      if (!/^\d+$/.test(configuredMax) || missing > BigInt(configuredMax))
        throw new Error(
          'Fixture funding exceeds the existing per-transfer limit',
        )
      await chain()
      const target = await testWallet()
      fundingAttempted = true
      uncertainPayment = true
      const output = await fundTool(
        repoRoot,
        [state.receive, mon(missing)],
        180000,
      )
      const hash = /: (0x[0-9a-fA-F]{64})$/.exec(output)?.[1]
      const receipt =
        hash &&
        (await creditedPayment(provider, [hash], state.receive, missing))
      if (!receipt)
        throw new Error(
          'Funding receipt unverified; original operation/profile retained',
        )
      fundedWei += receipt.creditedWei
      uncertainPayment = false
      return `funded ${mon(receipt.creditedWei)} MON from ${
        target.address
      }: ${hash}`
    },
  }
}

export function accountLine(directory, address, balanceWei) {
  return `ACCOUNT ${address} holds ${mon(
    balanceWei,
  )} MON in its persistent owned profile ${directory}; never delete it`
}
