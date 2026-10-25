/**
 * INTEGRATION: a wallet restored from backup shares finds every account its seed controls.
 *
 * Real: a local dev node of a real EVM client (`anvil`, chain ID 10143), the wallet's real
 * provider, signing, Codex32 backup shares, typed custody roots and Level stores. Device A is
 * created from a signup ceremony, funded, and spends: its sends split change across fresh
 * change accounts, spend from those again (a second generation of change), and skip indices a
 * failed build kept. An older wallet's account on the deterministic branch is funded too.
 * Device B is opened from two of the three shares in empty storage.
 *
 * Nothing passes from A to B but the shares: no relay, no wallet-sync message, no shared store
 * (the mailbox module is replaced with an empty offline one so neither device reaches a
 * network). B must report A's balance and be able to spend it.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { JsonRpcProvider, Wallet } from 'ethers'
import {
  beginCodex32Signup,
  recoverAccountBackupShares,
  type AccountDomainRoots,
} from '../../account-recovery/src/index'
import { createEvmChain, type EvmChainConfig } from './evm-chain'
import { InMemoryNativeTransactionAttemptStore } from './chain-wallet'
import { LegacyTransactionSetPendingError } from './evm-legacy-transaction-set'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
  type MonadWalletMaterial,
} from '../evm-wallet-material'
import { fixedStampDefault } from '../oracle/stamp-policy.testutil'

const mockNode = { url: '' }
jest.mock('../evm-provider', () => {
  const actual = jest.requireActual('../evm-provider')
  return {
    ...actual,
    createMonadJsonRpcProvider: (options: { chainId?: number | bigint }) =>
      actual.createMonadJsonRpcProvider({
        rpcUrl: mockNode.url,
        chainId: options.chainId,
      }),
  }
})
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)

function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN))
    return process.env.ANVIL_BIN
  try {
    const root = dirname(
      dirname(require.resolve('@foundry-rs/anvil/package.json')),
    )
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    const packaged = join(
      root,
      `anvil-${process.platform}-${arch}`,
      'bin',
      'anvil',
    )
    if (existsSync(packaged)) return packaged
  } catch {
    // Not installed as a package.
  }
  return spawnSync('anvil', ['--version']).status === 0 ? 'anvil' : undefined
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

const DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ETHER = 10n ** 18n

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn(
    'NOT RUN: evm-seed-restore.anvil needs an anvil binary (set ANVIL_BIN). Nothing here was exercised.',
  )
const suite = anvilBin ? describe : describe.skip

function bundle(roots: AccountDomainRoots): MonadRootBundle {
  return {
    evm: roots['evm-wallet'],
    authentication: roots['identity-authentication'],
    messaging: roots['messaging-encryption'],
  } as MonadRootBundle
}

suite('restore from backup shares on a real EVM node (anvil)', () => {
  jest.setTimeout(300_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  const directories: string[] = []
  const wallets: EvmChainWalletHandle[] = []

  const open = async (roots: MonadRootBundle) => {
    const directory = mkdtempSync(join(tmpdir(), 'frank-seed-restore-'))
    directories.push(directory)
    const config: EvmChainConfig = {
      networkId: 'monad-testnet',
      rpcChain: 'monad-testnet',
      chainId: 10143,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
      relayBaseUrl: 'https://relay-a.example',
      networkTag: 'MONT',
      stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
      resolveDefaultStamp: fixedStampDefault(10n ** 15n),
      defaultTopicVoteValueWei: 1_000n,
      subAccountPoolSize: 0,
      walletStorageLocation: join(directory, 'wallet'),
    }
    const wallet = (await createEvmChain(config).createWallet(
      roots,
    )) as EvmChainWalletHandle
    wallets.push(wallet)
    return wallet
  }

  beforeEach(async () => {
    const port = await freePort()
    mockNode.url = `http://127.0.0.1:${port}`
    node = spawn(
      anvilBin!,
      [
        '--port',
        String(port),
        '--chain-id',
        '10143',
        '--base-fee',
        '0',
        '--gas-price',
        '1000000000',
        '--silent',
      ],
      { stdio: 'ignore' },
    )
    chain = new JsonRpcProvider(mockNode.url, 10143, {
      staticNetwork: true,
      cacheTimeout: -1,
    })
    for (let attempt = 0; ; attempt++) {
      try {
        await chain.getBlockNumber()
        break
      } catch (error) {
        if (attempt > 100) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    dev = new Wallet(DEV_KEY, chain)
  })
  afterEach(async () => {
    for (const wallet of wallets.splice(0))
      await wallet.close().catch(() => undefined)
    chain?.destroy()
    node?.kill()
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  async function settleLegacy(
    wallet: EvmChainWalletHandle,
    start: () => Promise<unknown>,
  ) {
    let pending: string | undefined
    try {
      await start()
      return
    } catch (error) {
      if (!(error instanceof LegacyTransactionSetPendingError)) throw error
      pending = error.operation.operationId
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await wallet.resumeLegacySend!(pending)
        return
      } catch (error) {
        if (!(error instanceof LegacyTransactionSetPendingError)) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    throw new Error('the legacy send did not land')
  }

  /** Every account of the wallet's change branch the chain shows funded, by index. */
  async function fundedChange(material: MonadWalletMaterial, upTo: number) {
    const funded = new Map<number, bigint>()
    for (let index = 0; index < upTo; index++) {
      const { address } = material.changeKeyring.deriveChangeAccount(index)
      const balance = await chain.getBalance(address)
      if (balance > 0n) funded.set(index, balance)
    }
    return funded
  }

  it('device B, opened from two of three shares in empty storage, holds and spends what device A spread across its accounts', async () => {
    const signup = beginCodex32Signup({
      threshold: 2,
      identifier: 'frnk',
      indices: ['q', 'p', 'z'],
      randomBytes: length => new Uint8Array(randomBytes(length)),
    })
    const shares = [...signup.shares]
    const roots = bundle(signup.confirm(shares))
    const material = createMonadWalletMaterial(roots)
    // An account an older wallet of this seed used on the deterministic branch.
    const legacy = material.keyring.deriveSubAccount(3).address
    await (await dev.sendTransaction({ to: legacy, value: ETHER / 5n })).wait()
    const a = await open(roots)
    const main = (await a.getReceiveAddress()).raw
    await (await dev.sendTransaction({ to: main, value: 10n * ETHER })).wait()

    // A pays out from its main account: the remainder is split over fresh change accounts.
    const outside = Wallet.createRandom().address
    await a.sendLegacy!({ recipient: { raw: outside }, value: ETHER / 10n })
    // A build that failed after allocating keeps its change indices: a gap on the branch.
    for (let i = 0; i < 25; i++) await a.changePool!.reserveFreshChange()
    // A pays again; this time from change, whose remainder is split once more past the gap.
    await a.sendLegacy!({ recipient: { raw: outside }, value: ETHER / 7n })
    await a.sendLegacy!({ recipient: { raw: outside }, value: ETHER / 3n })

    const used = await fundedChange(material, a.changePool!.nextUnusedIndex() + 1)
    const beyondGap = [...used.keys()].filter(index => index > 25)
    expect(used.size).toBeGreaterThan(1)
    expect(beyondGap.length).toBeGreaterThan(0)
    const chainTotal =
      [...used.values()].reduce((sum, value) => sum + value, 0n) +
      (await chain.getBalance(main)) +
      (await chain.getBalance(material.identity.address.raw)) +
      (await chain.getBalance(legacy))
    expect(await a.getBalance()).toBe(chainTotal)
    const partsOfA = await a.getBalanceParts!()
    // One process opens an account once: device A goes away before device B opens.
    await a.close()

    // Device B: two of the three shares, nothing else.
    const recovered = recoverAccountBackupShares([shares[2]!, shares[0]!])
    expect(recovered.candidates).toHaveLength(1)
    const account = recovered.candidates[0]!.account
    if (!('roots' in account)) throw new Error('expected a Codex32 account')
    const b = await open(bundle(account.roots))
    expect((await b.getReceiveAddress()).raw).toBe(main)
    expect(await b.getBalance()).toBe(chainTotal)
    const parts = await b.getBalanceParts!()
    expect(parts).toEqual(partsOfA)
    // B will never hand out a change index A already used.
    expect(b.changePool!.nextUnusedIndex()).toBeGreaterThan(
      Math.max(...used.keys()),
    )

    // B spends more than its main account and any single account holds.
    const largest = [...used.values(), await chain.getBalance(main)].reduce(
      (max, value) => (value > max ? value : max),
      0n,
    )
    const before = await chain.getBalance(outside)
    const spend = largest + ETHER / 100n
    // More than one account holds: the wallet gathers several of the found accounts, which
    // takes more than one block, so the original operation is resumed until it lands.
    await settleLegacy(b, () =>
      b.sendLegacy!({ recipient: { raw: outside }, value: spend }),
    )
    expect(await chain.getBalance(outside)).toBe(before + spend)
  })
})
