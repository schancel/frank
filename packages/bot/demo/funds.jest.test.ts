import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { Wallet } from 'ethers'

import { placementNotice } from './demo'
import { Holding, TRANSFER_GAS, findWallets, isDemoState, parseArgs, planSweep } from './funds'

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

describe('parseArgs', () => {
  it('is a dry run unless --send is given', () => {
    expect(parseArgs(['sweep', '/state'])).toMatchObject({ mode: 'sweep', dirs: ['/state'], send: false, demo: false })
    expect(parseArgs(['sweep', '--demo', '/state', '--send'])).toMatchObject({ send: true, demo: true })
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
    expect(wallets.find(w => w.kind === 'account root')?.problem).toMatch(/cannot be opened by the current code/)
    expect(wallets.find(w => w.kind === 'wallet file')?.accounts[0].address).toBe(signer.address)
    expect(wallets.find(w => w.kind === 'identity file')?.accounts[0].address).toBe(signer.address)
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
