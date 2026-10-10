import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { Wallet } from 'ethers'

import { placementNotice } from './demo'
import { Holding, TRANSFER_GAS, USAGE, findWallets, isDemoState, main, parseArgs, planSweep, usersOf } from './funds'
import { TEST_ACCOUNT_FLOAT_WEI, fundsLine } from './real-stack'

const GAS_PRICE = 102_000_000_000n
const COST = GAS_PRICE * TRANSFER_GAS // 0.002142 MON
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const holding = (n: number, balanceWei: bigint, extra: Partial<Holding> = {}): Holding => ({
  wallet: '/state/wallets/alice',
  role: 'main',
  address: A(n),
  balanceWei,
  hasKey: true,
  ...extra,
})

describe('planSweep', () => {
  it('moves the balance less one transfer fee from each account worth moving', () => {
    const plan = planSweep([holding(1, 10n ** 17n), holding(2, COST * 2n)], GAS_PRICE)
    expect(plan.transferCostWei).toBe(COST)
    expect(plan.moves.map(m => [m.address, m.valueWei])).toEqual([
      [A(1), 10n ** 17n - COST],
      [A(2), COST],
    ])
    expect(plan.recoverableWei).toBe(10n ** 17n - COST + COST)
    expect(plan.feesWei).toBe(COST * 2n)
    expect(plan.skipped).toEqual([])
  })

  it('leaves an account under twice the fee as dust, with the reason', () => {
    const plan = planSweep([holding(1, COST * 2n - 1n), holding(2, 0n)], GAS_PRICE)
    expect(plan.moves).toEqual([])
    expect(plan.dustWei).toBe(COST * 2n - 1n)
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0].reason).toMatch(/^dust: under twice the transfer fee of 0\.002142 MON/)
  })

  it('counts an address once, preferring the copy that has its key', () => {
    const plan = planSweep(
      [
        holding(1, 10n ** 17n, { hasKey: false, role: 'main' }),
        holding(1, 10n ** 17n, { address: A(1).toUpperCase().replace('0X', '0x'), role: 'identity' }),
      ],
      GAS_PRICE,
    )
    expect(plan.moves).toHaveLength(1)
    expect(plan.moves[0].role).toBe('identity')
    expect(plan.noKeyWei).toBe(0n)
  })

  it('reports money whose key is gone and never treats it as recoverable', () => {
    const plan = planSweep([holding(1, 10n ** 18n, { hasKey: false })], GAS_PRICE)
    expect(plan.moves).toEqual([])
    expect(plan.recoverableWei).toBe(0n)
    expect(plan.noKeyWei).toBe(10n ** 18n)
    expect(plan.skipped[0].reason).toBe('its key was not found')
  })

  it('never takes from the funding or test wallets', () => {
    const plan = planSweep([holding(1, 10n ** 18n), holding(2, 10n ** 17n)], GAS_PRICE, [A(1).toUpperCase().replace('0X', '0x')])
    expect(plan.moves.map(m => m.address)).toEqual([A(2)])
    expect(plan.skipped[0].reason).toMatch(/never a source/)
  })

  it('lists the largest sources first', () => {
    const plan = planSweep([holding(1, 10n ** 16n), holding(2, 10n ** 18n), holding(3, 10n ** 17n)], GAS_PRICE)
    expect(plan.moves.map(m => m.address)).toEqual([A(2), A(3), A(1)])
  })
})

describe('a state that will be used again', () => {
  const ready = holding(1, 10n ** 16n, { role: 'sender 4 (available)', heldByRecords: true })
  const spent = holding(2, 10n ** 16n, { role: 'sender 3 (spent)' })

  it('keeps sender accounts the records hold ready, so the records stay true', () => {
    const plan = planSweep([ready, spent, holding(3, 10n ** 17n)], GAS_PRICE)
    expect(plan.moves.map(m => m.address)).toEqual([A(3), A(2)])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0].reason).toMatch(/^kept: the wallet's records hold it ready/)
    expect(plan.dustWei).toBe(0n)
  })

  it('takes them too when the state is abandoned', () => {
    const plan = planSweep([ready, spent], GAS_PRICE, [], { abandoned: true })
    expect(plan.moves.map(m => m.address).sort()).toEqual([A(1), A(2)])
  })
})

describe('usersOf', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'funds-users-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('names the processes that have a file under the directory open', () => {
    const listing = () => `p41\nn/somewhere/else\np42\nn${realpathSync(dir)}/wallets/alice/LOCK\n`
    expect(usersOf(dir, listing).map(u => u.replace(/^pid /, ''))).toEqual(expect.arrayContaining(['42']))
    expect(usersOf(dir, () => 'p41\nn/somewhere/else\n')).toEqual([])
  })

  it('counts the directory as in use when lsof is missing or fails without output', () => {
    const users = usersOf(dir, () => {
      throw new Error('spawn lsof ENOENT')
    })
    expect(users).toHaveLength(1)
    expect(users[0]).toMatch(/^unknown \(lsof could not be run/)
  })

  it('uses what a failing lsof still listed', () => {
    const failing = () => {
      throw Object.assign(new Error('exit 1'), { stdout: 'p7\nn/elsewhere\n' })
    }
    expect(usersOf(dir, failing)).toEqual([])
  })
})

describe('fundsLine', () => {
  it('is one line: funded, returned, left where and why', () => {
    const line = fundsLine({
      fundedWei: 72_000_000_000_000_000n,
      outcome: {
        returnedWei: 40_000_000_000_000_000n,
        floatWei: TEST_ACCOUNT_FLOAT_WEI,
        left: [
          { wallet: 'alice', account: 'spent sender 3', address: A(3), balanceWei: 3_000_000_000_000_000n, reason: 'dust: under twice the transfer fee of 0.002142 MON' },
          { wallet: 'alice', account: 'spent sender 4', address: A(4), balanceWei: 3_000_000_000_000_000n, reason: 'dust: under twice the transfer fee of 0.002142 MON' },
        ],
      },
      to: A(9),
      where: '/state',
    })
    expect(line).toBe(
      `funded 0.072 MON, returned 0.04 MON to ${A(9)}, left 0.026 MON in /state (0.02 is the float the persistent accounts keep for the next run; 2 accounts: dust)`,
    )
    expect(line).not.toContain('\n')
  })
})

describe('parseArgs', () => {
  it('prints its usage for --help without touching the chain', async () => {
    const lines: string[] = []
    expect(await main(['sweep', '--help'], l => lines.push(l))).toBe(0)
    expect(lines).toEqual([USAGE])
    expect(USAGE).toContain('--abandoned')
  })

  it('is a dry run unless --send is given', () => {
    expect(parseArgs(['sweep', '/state'])).toMatchObject({ mode: 'sweep', dirs: ['/state'], send: false, demo: false })
    expect(parseArgs(['sweep', '--demo', '/state', '--send'])).toMatchObject({ send: true, demo: true })
    expect(parseArgs(['sweep', '/state'])).toMatchObject({ abandoned: false })
    expect(parseArgs(['sweep', '/state', '--abandoned'])).toMatchObject({ abandoned: true })
  })

  it('refuses a sweep that names no directory, and --send on a report', () => {
    expect(() => parseArgs(['sweep', '--send'])).toThrow(/needs the state directories/)
    expect(() => parseArgs(['report', '--send'])).toThrow(/belongs to funds:sweep/)
    expect(() => parseArgs(['sweep', '/state', '--everything'])).toThrow(/unknown option/)
  })
})

describe('findWallets', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'funds-test-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('derives a harness wallet from its account root, as the wallet does, and reads nothing else', async () => {
    const walletDir = join(dir, 'wallets', 'alice')
    mkdirSync(walletDir, { recursive: true })
    writeFileSync(join(walletDir, 'account-root.hex'), '11'.repeat(32))
    const [wallet, ...rest] = await findWallets(dir)
    expect(rest).toEqual([])
    expect(wallet.kind).toBe('account root')
    expect(wallet.accounts.slice(0, 2).map(a => a.role)).toEqual(['main', 'identity'])
    // No pool records: the first few sender and change accounts are still looked at.
    expect(wallet.accounts.filter(a => a.role.startsWith('sender'))).toHaveLength(3)
    expect(wallet.accounts.filter(a => a.role.startsWith('change'))).toHaveLength(3)
    expect(new Set(wallet.accounts.map(a => a.address)).size).toBe(wallet.accounts.length)
    for (const account of wallet.accounts) expect(new Wallet(account.privateKey as string).address).toBe(account.address)
  })

  it('reports a key file it cannot open instead of failing, and finds plain wallet and identity files', async () => {
    mkdirSync(join(dir, 'broken'))
    writeFileSync(join(dir, 'broken', 'account-root.hex'), 'not hex')
    const signer = Wallet.createRandom()
    writeFileSync(join(dir, 'old-wallet.json'), JSON.stringify({ address: signer.address, privateKey: signer.privateKey }))
    mkdirSync(join(dir, 'bots', 'qwen'), { recursive: true })
    writeFileSync(join(dir, 'bots', 'qwen', 'identity.json'), JSON.stringify({ privateKeyHex: signer.privateKey.slice(2) }))
    const wallets = await findWallets(dir)
    expect(wallets.find(w => w.kind === 'account root')?.problem).toMatch(/cannot open; skipped/)
    expect(wallets.find(w => w.kind === 'wallet file')?.accounts[0].address).toBe(signer.address)
    expect(wallets.find(w => w.kind === 'identity file')?.accounts[0].address).toBe(signer.address)
  })

  it('says so when there are no pool records instead of silently looking at three indexes', async () => {
    mkdirSync(join(dir, 'w'))
    writeFileSync(join(dir, 'w', 'account-root.hex'), '22'.repeat(32))
    const [wallet] = await findWallets(dir)
    expect(wallet.note).toMatch(/no wallet records were found beside the key: only sender and change accounts 0-2 were looked at/)
  })

  it('reports a malformed roots.json or pool seed by path and never repeats its contents', async () => {
    mkdirSync(join(dir, 'a'))
    mkdirSync(join(dir, 'b'))
    writeFileSync(join(dir, 'a', 'roots.json'), '{"evm-wallet": "SECRETSECRET')
    writeFileSync(join(dir, 'b', 'stamp-pool-seed.json'), JSON.stringify({ version: 1, mnemonic: 'SECRETSECRET not a phrase' }))
    const wallets = await findWallets(dir)
    expect(wallets.map(w => w.path).sort()).toEqual([join(dir, 'a', 'roots.json'), join(dir, 'b', 'stamp-pool-seed.json')])
    for (const wallet of wallets) {
      expect(wallet.accounts).toEqual([])
      expect(wallet.problem).toMatch(/malformed or in a format the current code cannot open/)
    }
    expect(JSON.stringify(wallets)).not.toContain('SECRETSECRET')
  })

  it('does not follow a symbolic link out of the state directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'funds-outside-'))
    try {
      writeFileSync(join(outside, 'account-root.hex'), '33'.repeat(32))
      symlinkSync(outside, join(dir, 'link'))
      expect(await findWallets(dir)).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('lists wallet records whose key file is gone by address, without a key', async () => {
    const main = Wallet.createRandom().address
    mkdirSync(join(dir, `chain-storage-evm-${main.toLowerCase()}`))
    const [orphan] = await findWallets(dir)
    expect(orphan.kind).toBe('records without a key')
    expect(orphan.accounts).toEqual([{ role: 'main', address: main }])
  })

  it('knows a demo state directory by its bot host', () => {
    expect(isDemoState(dir)).toBe(false)
    mkdirSync(join(dir, 'bot-host', 'bots'), { recursive: true })
    expect(isDemoState(dir)).toBe(true)
  })
})

describe('placementNotice', () => {
  it('says how much a start places in a new state directory and how to get it back', () => {
    const lines = placementNotice('/home/u/.frank-demo', 9_600_000_000_000_000_000n, true)
    expect(lines[0]).toBe("NEW state directory /home/u/.frank-demo: this start places 9.6 testnet MON in its bots' accounts.")
    expect(lines.join('\n')).toContain('yarn demo:sweep /home/u/.frank-demo --send')
    expect(placementNotice('/s', 1n, false)[0]).toMatch(/^state directory \/s:/)
  })
})
