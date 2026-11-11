/** @jest-environment jsdom */
/* eslint-env node, jest */
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const ts = require('typescript')

// Execute the checked-in ESM helper through the existing Jest CommonJS gate.
// All fixture files, funding tools and RPC calls below are in-memory doubles.
const source = readFileSync(resolve(__dirname, '../../e2e-profile.mjs'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const address = '0x' + '1'.repeat(40)
const recipient = '0x' + '2'.repeat(40)
const hash = '0x' + '3'.repeat(64)
const blockHash = '0x' + '4'.repeat(64)
const checkpoint = '0x' + '5'.repeat(64)
const rules = 'MAP signet.mx 127.0.0.1, MAP relay.signet.mx 10.1.2.3'

function fixture() {
  const files = new Map()
  const directories = new Set()
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
  const facts = path => {
    if (!files.has(path) && !directories.has(path)) throw missing()
    return {
      size: Buffer.byteLength(files.get(path) ?? ''),
      isFile: () => files.has(path),
      isDirectory: () => directories.has(path),
      isSymbolicLink: () => false,
    }
  }
  const fs = {
    lstat: jest.fn(async path => facts(path)),
    realpath: jest.fn(async path => path),
    mkdir: jest.fn(async path => directories.add(path)),
    writeFile: jest.fn(async (path, data, options) => {
      if (options.flag === 'wx' && files.has(path)) throw new Error('exists')
      files.set(path, data)
    }),
    rename: jest.fn(async (from, to) => {
      files.set(to, files.get(from))
      files.delete(from)
    }),
    open: jest.fn(async path => {
      facts(path)
      return {
        stat: async () => facts(path),
        read: async (buffer, offset, length, position) => {
          const data = Buffer.from(files.get(path))
          const count = Math.min(length, Math.max(0, data.length - position))
          data.copy(buffer, offset, position, position + count)
          return { bytesRead: count }
        },
        close: jest.fn(async () => {}),
      }
    }),
  }
  const process = {
    env: {
      ACCOUNT_APP_ORIGIN: 'https://signet.mx',
      E2E_BROWSER_RESOLVER_RULES: rules,
      E2E_PROFILE_DIR: '/owned/test-profile',
      MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:12345/rpc',
    },
    execPath: '/unused/node',
    once: jest.fn(),
    exit: jest.fn(),
  }
  const rpc = {
    getNetwork: jest.fn(async () => ({ chainId: 10143n })),
    getBlock: jest.fn(async number =>
      number === 0
        ? { hash: checkpoint, number: 0 }
        : { hash: blockHash, number },
    ),
    getBlockNumber: jest.fn(async () => 10),
    getTransaction: jest.fn(async () => ({
      hash,
      blockHash,
      blockNumber: 1,
      chainId: 10143n,
      to: recipient,
      value: 10000000000000000n,
    })),
    getTransactionReceipt: jest.fn(async () => ({
      hash,
      blockHash,
      blockNumber: 1,
      status: 1,
    })),
    destroy: jest.fn(),
  }
  const execFile = jest.fn((executable, args, options, done) => {
    done(
      null,
      args.includes('--info')
        ? JSON.stringify({ address: recipient, floatWei: '20000000000000000' })
        : `funded: ${hash}`,
    )
  })
  files.set(
    '/repo/docs/protocol/chains/v1.json',
    JSON.stringify({
      chains: [
        {
          id: 'monad-testnet',
          native_chain_id: '10143',
          identity_probes: [
            { kind: 'block-hash', height: 0, expected: checkpoint },
          ],
        },
      ],
    }),
  )
  const exports = {}
  const load = name => {
    if (name === 'node:fs/promises') return fs
    if (name === 'node:child_process') return { execFile }
    if (name === 'ethers')
      return {
        FetchRequest: class {
          constructor(url) {
            this.url = url
          }
        },
        JsonRpcProvider: class {
          constructor() {
            return rpc
          }
        },
      }
    return require(name)
  }
  new Function('require', 'exports', 'process', 'Buffer', compiled)(
    load,
    exports,
    process,
    Buffer,
  )
  return { helper: exports, fs, files, directories, process, rpc, execFile }
}

async function ownedProfile(f) {
  const profile = await f.helper.persistentProfile('funds')
  await profile.recordAccount({ profile: recipient, receive: address })
  return profile
}

function walletHtml({
  gross = '10 MONT',
  available = '0.02 MONT',
  display = '10',
  extra = '',
} = {}) {
  document.body.innerHTML = `<div data-testid="wallet-balance" title="${gross}">${display}</div>
    <div data-testid="wallet-available"><span title="${available}"></span></div>
    <div class="q-field"><input value="${address}"><button data-testid="wallet-copy-address"></button></div>${extra}`
}

function domPage() {
  const location = { hash: '#/wallet/monad' }
  const evaluate = jest.fn(async expression =>
    new Function('document', 'location', `return (${expression})`)(
      document,
      location,
    ),
  )
  return {
    evaluate,
    until: jest.fn(async expression => {
      if (!(await evaluate(expression))) throw new Error('not ready')
    }),
    typeInput: jest.fn(async () => {}),
    click: jest.fn(async () => {}),
  }
}

test('exact integers round-trip above Number precision; lossy inputs fail', () => {
  const { helper } = fixture()
  expect(helper.monWei('9007199254740993.000000000000000001')).toBe(
    9007199254740993000000000000000001n,
  )
  expect(helper.mon(helper.monWei('0.000000000000000001'))).toBe(
    '0.000000000000000001',
  )
  for (const value of [
    0.2,
    '1e-3',
    '-1',
    '1.0000000000000000001',
    '1k',
    'NaN',
  ]) {
    expect(() => helper.monWei(value)).toThrow()
  }
})

test('both final hosts require exact private resolver mappings even for loopback apps', () => {
  const { helper } = fixture()
  expect(
    helper.browserFixture({
      ACCOUNT_APP_ORIGIN: 'http://localhost:9000',
      E2E_BROWSER_RESOLVER_RULES: rules,
    }).resolverArgument,
  ).toContain(rules)
  for (const invalid of [
    '',
    'MAP signet.mx 127.0.0.1',
    rules.replace('10.1.2.3', '8.8.8.8'),
    rules.replace('relay.signet.mx', '*'),
  ]) {
    expect(() =>
      helper.browserFixture({
        ACCOUNT_APP_ORIGIN: 'https://signet.mx',
        E2E_BROWSER_RESOLVER_RULES: invalid,
      }),
    ).toThrow()
  }
  expect(() =>
    helper.browserFixture({
      ACCOUNT_APP_ORIGIN: 'https://user:secret@signet.mx',
      E2E_BROWSER_RESOLVER_RULES: rules,
    }),
  ).toThrow()
})

test('ordinary DOM exposes identity and receive address without a session import', async () => {
  const { helper } = fixture()
  const page = domPage()
  document.body.innerHTML = `<div data-test="identity-address-input"><input value="${recipient}"></div>
    <div class="q-field"><input value="${address}"><button data-testid="wallet-copy-address"></button></div>`
  await expect(helper.readPublicAccount(page)).resolves.toEqual({
    profile: recipient,
    receive: address,
  })
})

test('public identity is read from the actual Quasar native input attribute', async () => {
  const { helper } = fixture()
  const page = domPage()
  document.body.innerHTML = `<input data-test="identity-address-input" value="${recipient}">
    <div class="q-field"><input value="${address}"><button data-testid="wallet-copy-address"></button></div>`
  await expect(helper.readPublicAccount(page)).resolves.toEqual({
    profile: recipient,
    receive: address,
  })
})

test('exact available differs from gross and abbreviated display is never used as an amount', async () => {
  const { helper } = fixture()
  walletHtml({ gross: '1234.000000000000000001 MONT', display: '1.23k' })
  await expect(helper.readWalletState(domPage())).resolves.toMatchObject({
    grossWei: 1234000000000000000001n,
    availableWei: 20000000000000000n,
  })
})

test.each([
  { available: '' },
  { gross: 'unknown MONT' },
  { display: '10 (last known)' },
  { extra: '<div data-testid="wallet-chain-unreachable"></div>' },
  { extra: '<div data-testid="wallet-balance-error"></div>' },
  { extra: '<div data-test="monad-balance-stale-indicator"></div>' },
])('unknown/stale balance fails closed: %j', async state => {
  walletHtml(state)
  await expect(fixture().helper.readWalletState(domPage())).rejects.toThrow()
})

test('profile creation and reuse preserve identity; changed identities are refused', async () => {
  const f = fixture()
  const first = await f.helper.persistentProfile('journey')
  expect(first.fresh).toBe(true)
  await first.recordAccount({ profile: recipient, receive: address })
  const reused = await f.helper.persistentProfile('journey')
  expect(reused.fresh).toBe(false)
  expect(reused.account).toEqual(first.account)
  await expect(
    reused.recordAccount({ profile: address, receive: address }),
  ).rejects.toThrow('identity changed')
  expect(f.fs.mkdir).toHaveBeenCalledTimes(1)
})

test.each(['missing', '{malformed', 'null', '{"schema":"old"}'])(
  'existing unowned/malformed marker is preserved: %s',
  async content => {
    const f = fixture()
    f.directories.add('/owned/test-profile')
    if (content !== 'missing')
      f.files.set('/owned/test-profile/frank-account.json', content)
    await expect(f.helper.persistentProfile('journey')).rejects.toThrow()
    expect(f.fs.mkdir).not.toHaveBeenCalled()
    expect(f.fs.writeFile).not.toHaveBeenCalled()
  },
)

test('interrupted onboarding and externally changed markers cannot be adopted', async () => {
  const f = fixture()
  const profile = await f.helper.persistentProfile('journey')
  await expect(f.helper.persistentProfile('journey')).rejects.toThrow()
  f.files.set('/owned/test-profile/frank-account.json', '{}')
  await expect(
    profile.recordAccount({ profile: recipient, receive: address }),
  ).rejects.toThrow('marker changed')
  expect(f.fs.rename).not.toHaveBeenCalled()
})

test('capability paths, auth queries and URL userinfo do not enter evidence', () => {
  const { helper } = fixture()
  expect(
    helper.evidenceUrl(
      'https://user:password@relay.signet.mx/chain-rpc/monad-testnet/cap/SECRET/rpc?token=TOKEN&signature=SIG&nonce=NONCE',
    ),
  ).toBe('https://relay.signet.mx/chain-rpc/monad-testnet/cap/[redacted]/rpc')
  expect(
    helper.evidenceUrl('wss://relay.signet.mx/mailbox/ws?token=SECRET'),
  ).toBe('wss://relay.signet.mx/mailbox/ws')
  const entries = []
  for (let i = 0; i < 300; i++) helper.appendEvidence(entries, 'x'.repeat(1000))
  expect(entries).toHaveLength(200)
  expect(entries.every(value => value.length === 512)).toBe(true)
})

test('backend errors before a long line are classified without exposing their body', async () => {
  const f = fixture()
  f.files.set('/logs/relay', 'ERROR SECRET ' + 'x'.repeat(150000))
  const evidence = await f.helper.scanBackendLog('/logs/relay', 0)
  expect(evidence).toContain('[backend error marker; body omitted]')
  expect(JSON.stringify(evidence)).not.toContain('SECRET')
  await expect(f.helper.scanBackendLog('/logs/relay', 200000)).resolves.toEqual(
    ['[backend log replaced or unavailable]'],
  )
  f.files.set('/logs/relay', 'x'.repeat(1100000))
  expect(await f.helper.scanBackendLog('/logs/relay', 0)).toContain(
    '[backend log evidence limit; not fully verified]',
  )
})

test('receipt proves exact recipient credit, not a gross wallet decrease; duplicates count once', async () => {
  const { helper, rpc } = fixture()
  await expect(
    helper.creditedPayment(rpc, [hash, hash], recipient, 10000000000000000n),
  ).resolves.toEqual({
    creditedWei: 10000000000000000n,
    transactionHashes: [hash],
  })
  await expect(
    helper.creditedPayment(rpc, [hash], recipient, 10000000000000001n),
  ).resolves.toBeUndefined()
  await expect(
    helper.creditedPayment(rpc, [hash], address, 10000000000000000n),
  ).resolves.toBeUndefined()
})

test.each([
  { status: 0 },
  { hash: '0x' + '6'.repeat(64) },
  { blockHash: '0x' + '7'.repeat(64) },
])(
  'reverted or mismatched receipt is not credit evidence: %j',
  async change => {
    const { helper, rpc } = fixture()
    rpc.getTransactionReceipt.mockResolvedValue({
      hash,
      blockHash,
      blockNumber: 1,
      status: 1,
      ...change,
    })
    await expect(
      helper.creditedPayment(rpc, [hash], recipient, 10000000000000000n),
    ).resolves.toBeUndefined()
  },
)

test('wrong native identity is not accepted as a final-artifact receipt', async () => {
  const { helper, rpc } = fixture()
  rpc.getTransaction.mockResolvedValue({
    hash,
    blockHash,
    blockNumber: 1,
    chainId: 20143n,
    to: recipient,
    value: 1n,
  })
  await expect(
    helper.creditedPayment(rpc, [hash], recipient, 1n),
  ).resolves.toBeUndefined()
})

test('wrong checkpoint prevents funding tool execution and UI confirmation', async () => {
  const f = fixture()
  walletHtml()
  f.rpc.getBlock.mockResolvedValue({ hash: 'wrong' })
  const page = domPage()
  const funds = f.helper.testFunds({
    repoRoot: '/repo',
    directory: '/owned/test-profile',
    profile: await ownedProfile(f),
    page,
  })
  await expect(funds.ensure(f.helper.monWei('0.1'))).rejects.toThrow(
    'checkpoint mismatch',
  )
  expect(f.execFile).not.toHaveBeenCalled()
  expect(page.click).not.toHaveBeenCalled()
})

test('funding uses the exact available shortfall and requires matching recipient credit', async () => {
  const f = fixture()
  walletHtml({ gross: '10 MONT', available: '0.02 MONT' })
  f.rpc.getTransaction.mockResolvedValue({
    hash,
    blockHash,
    blockNumber: 1,
    chainId: 10143n,
    to: address,
    value: 80000000000000000n,
  })
  const funds = f.helper.testFunds({
    repoRoot: '/repo',
    directory: '/owned/test-profile',
    profile: await ownedProfile(f),
    page: domPage(),
  })
  await expect(funds.ensure(f.helper.monWei('0.1'))).resolves.toContain(
    'funded 0.08 MON',
  )
  expect(f.execFile.mock.calls[1][1].slice(-2)).toEqual([address, '0.08'])
  await expect(funds.ensure(f.helper.monWei('0.1'))).rejects.toThrow(
    'already attempted',
  )
})

test('unknown available balance never launches funding', async () => {
  const f = fixture()
  walletHtml({ available: '' })
  const funds = f.helper.testFunds({
    repoRoot: '/repo',
    directory: '/owned/test-profile',
    profile: await ownedProfile(f),
    page: domPage(),
  })
  await expect(funds.ensure(f.helper.monWei('0.1'))).rejects.toThrow()
  expect(f.execFile).not.toHaveBeenCalled()
  expect(f.rpc.getNetwork).not.toHaveBeenCalled()
})

test('finish reports actual matching return credit once, excluding fees and gross decreases', async () => {
  const f = fixture()
  walletHtml({ gross: '10 MONT', available: '0.1 MONT' })
  f.rpc.getTransaction.mockResolvedValue({
    hash,
    blockHash,
    blockNumber: 1,
    chainId: 10143n,
    to: recipient,
    value: 80000000000000000n,
  })
  const page = domPage()
  const baseEvaluate = page.evaluate.getMockImplementation()
  let histories = 0
  page.evaluate.mockImplementation(async expression => {
    if (expression.includes('review-recipient'))
      return { recipient, amount: '0.08 MONT' }
    if (expression.includes("querySelectorAll('[data-activity-id]')"))
      return histories++ ? [{ id: 'native:original', hashes: [hash] }] : []
    return baseEvaluate(expression)
  })
  page.until.mockResolvedValue(undefined)
  const funds = f.helper.testFunds({
    repoRoot: '/repo',
    directory: '/owned/test-profile',
    profile: await ownedProfile(f),
    page,
  })
  const result = await funds.finish()
  expect(result.returnedWei).toBe(80000000000000000n)
  expect(result.heldWei).toBe(10000000000000000000n)
  await funds.finish()
  expect(
    page.click.mock.calls.filter(
      ([selector]) => selector === '[data-test="review-confirm-button"]',
    ),
  ).toHaveLength(1)
})

test('ambiguous original UI send is confirmed once; finish preserves it without replacement', async () => {
  const f = fixture()
  walletHtml({ available: '0.1 MONT' })
  const page = domPage()
  const baseEvaluate = page.evaluate.getMockImplementation()
  page.evaluate.mockImplementation(async expression => {
    if (expression.includes('review-recipient'))
      return { recipient, amount: '0.01 MONT' }
    if (expression.includes("querySelectorAll('[data-activity-id]')")) return []
    return baseEvaluate(expression)
  })
  page.until.mockImplementation(async (expression, timeout, label) => {
    if (label === 'original return operation outcome')
      throw new Error('timeout')
  })
  const funds = f.helper.testFunds({
    repoRoot: '/repo',
    directory: '/owned/test-profile',
    profile: await ownedProfile(f),
    page,
  })
  await expect(funds.sendFromPage(recipient, '0.01')).rejects.toThrow('timeout')
  await expect(funds.sendFromPage(recipient, '0.01')).rejects.toThrow(
    'ambiguous financial',
  )
  const result = await funds.finish()
  await funds.finish()
  expect(
    page.click.mock.calls.filter(
      ([selector]) => selector === '[data-test="review-confirm-button"]',
    ),
  ).toHaveLength(1)
  expect(f.execFile).not.toHaveBeenCalled()
  expect(result.returnedWei).toBe(0n)
  expect(result.reason).toContain('ambiguous')
  expect(f.process.exitCode).toBe(1)
})

test('mutually matching orphan transaction and receipt are not canonical credit', async () => {
  const { helper, rpc } = fixture()
  rpc.getBlock.mockResolvedValue({ number: 1, hash: '0x' + '9'.repeat(64) })
  await expect(
    helper.creditedPayment(rpc, [hash], recipient, 10000000000000000n),
  ).resolves.toBeUndefined()
  rpc.getBlock.mockResolvedValue({ number: 1, hash: blockHash })
  rpc.getBlockNumber.mockResolvedValue(0)
  await expect(
    helper.creditedPayment(rpc, [hash], recipient, 10000000000000000n),
  ).resolves.toBeUndefined()
})

test('signal cleanup cannot enter a second return during the original first await', async () => {
  const f = fixture()
  const profile = await ownedProfile(f)
  const page = domPage()
  let rejectNetwork
  f.rpc.getNetwork.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        rejectNetwork = reject
      }),
  )
  const funds = f.helper.testFunds({
    repoRoot: '/repo',
    directory: profile.directory,
    profile,
    page,
  })
  const original = funds.sendFromPage(recipient, '0.01')
  // Let registry I/O reach the deferred network read, without running any browser or timer.
  for (let i = 0; i < 20 && !rejectNetwork; i++) await Promise.resolve()
  expect(rejectNetwork).toBeDefined()
  const cleanup = await funds.finish()
  expect(cleanup.reason).toContain('active or ambiguous')
  expect(page.evaluate).not.toHaveBeenCalled()
  expect(f.execFile).not.toHaveBeenCalled()
  expect(f.rpc.destroy).not.toHaveBeenCalled()
  rejectNetwork(new Error('pre-exposure fixture failure'))
  await expect(original).rejects.toThrow('pre-exposure')
  const release = profile.admitFinancialAction()
  release()
})

test('ensure admission is synchronous and cleanup cannot navigate or fund concurrently', async () => {
  const f = fixture()
  walletHtml()
  const profile = await ownedProfile(f)
  const page = domPage()
  let resumeSnapshot
  page.evaluate.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resumeSnapshot = resolve
      }),
  )
  f.rpc.getNetwork.mockRejectedValue(new Error('pre-exposure fixture failure'))
  const funds = f.helper.testFunds({
    repoRoot: '/repo',
    directory: profile.directory,
    profile,
    page,
  })
  const original = funds.ensure(f.helper.monWei('0.1'))
  await expect(funds.ensure(f.helper.monWei('0.1'))).rejects.toThrow(
    'Active or ambiguous',
  )
  await funds.finish()
  expect(page.evaluate).toHaveBeenCalledTimes(1)
  expect(f.execFile).not.toHaveBeenCalled()
  resumeSnapshot()
  await expect(original).rejects.toThrow('pre-exposure')
})

test('funding ambiguity is durably marked before exposure and blocks fresh actions after reopen', async () => {
  const f = fixture()
  walletHtml()
  const profile = await ownedProfile(f)
  const marker = '/owned/test-profile/frank-account.json'
  f.execFile.mockImplementation((executable, args, options, done) => {
    if (args.includes('--info'))
      return done(
        null,
        JSON.stringify({ address: recipient, floatWei: '20000000000000000' }),
      )
    expect(JSON.parse(f.files.get(marker)).financialAttempt).toEqual({
      kind: 'fund',
      recipient: address,
      amountWei: '80000000000000000',
    })
    done(new Error('broadcast may have occurred; no hash returned'))
  })
  const funds = f.helper.testFunds({
    repoRoot: '/repo',
    directory: profile.directory,
    profile,
    page: domPage(),
  })
  await expect(funds.ensure(f.helper.monWei('0.1'))).rejects.toThrow(
    'funding tool failed',
  )
  const retained = f.files.get(marker)
  await expect(f.helper.persistentProfile('funds')).rejects.toThrow(
    'manual reconciliation required',
  )
  expect(f.files.get(marker)).toBe(retained)
  expect(JSON.parse(retained).account).toEqual(profile.account)
  const page = domPage()
  const retry = f.helper.testFunds({
    repoRoot: '/repo',
    directory: profile.directory,
    profile,
    page,
  })
  await expect(retry.ensure(f.helper.monWei('0.1'))).rejects.toThrow(
    'Active or ambiguous',
  )
  await expect(retry.sendFromPage(recipient, '0.01')).rejects.toThrow(
    'Active or ambiguous',
  )
  await retry.finish()
  expect(page.evaluate).not.toHaveBeenCalled()
  expect(f.execFile).toHaveBeenCalledTimes(2)
  expect(JSON.parse(f.files.get(marker)).financialAttempt.kind).toBe('fund')
})

test('canonical original credit clears the durable guard; failed clear cannot authorize another action', async () => {
  const f = fixture()
  walletHtml()
  const profile = await ownedProfile(f)
  f.rpc.getTransaction.mockResolvedValue({
    hash,
    blockHash,
    blockNumber: 1,
    chainId: 10143n,
    to: address,
    value: 80000000000000000n,
  })
  const funds = f.helper.testFunds({
    repoRoot: '/repo',
    directory: profile.directory,
    profile,
    page: domPage(),
  })
  await funds.ensure(f.helper.monWei('0.1'))
  expect(
    JSON.parse(f.files.get('/owned/test-profile/frank-account.json'))
      .financialAttempt,
  ).toBeNull()
  const reopened = await f.helper.persistentProfile('funds')
  const release = reopened.admitFinancialAction()
  await reopened.recordFinancialAttempt('return', recipient, 1n)
  f.fs.rename.mockRejectedValueOnce(new Error('disk failure'))
  await expect(reopened.completeFinancialAttempt()).rejects.toThrow(
    'disk failure',
  )
  release()
  expect(() => reopened.admitFinancialAction()).toThrow('Active or ambiguous')
})
