/**
 * One naming function for wallet state: the canonical network appears exactly once, the same
 * account on two networks never shares a store, and state an earlier build wrote under another
 * name is found (by name only) and reported at open, never read, migrated or deleted. The wallets
 * here are real (`createEvmChain` with Level stores on disk); no node is contacted.
 */
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DomainRoot } from '../../domain-roots/src'
import { createEvmChain, earlierEvmWalletState } from '../chain/evm-chain'
import type { EvmChainConfig } from '../chain/evm-chain-config'
import { InMemoryNativeTransactionAttemptStore } from '../chain/chain-wallet'
import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import {
  DEFAULT_WALLET_STATE_BASE,
  EARLIER_BROWSER_WALLET_STATE_BASE,
  earlierWalletStateLocations,
  evmWalletStateOwner,
  findEarlierWalletState,
  walletStateLocation,
} from './wallet-state-location'

jest.setTimeout(30_000)

const ADDRESS = '0x4669eff913a3c595cea5fa92a600201e8e9e75d8'

describe('walletStateLocation', () => {
  it('names the canonical network exactly once, for every family of EVM network', () => {
    for (const chainIdentifier of [
      'monad-testnet',
      'monad-regtest',
      'monad-mainnet',
      'ethereum-sepolia',
      'tempo-testnet',
    ]) {
      const location = walletStateLocation({
        base: DEFAULT_WALLET_STATE_BASE,
        chainIdentifier,
        owner: evmWalletStateOwner(ADDRESS),
      })
      expect(location).toBe(
        `frank-wallet-state-${chainIdentifier}-evm-${ADDRESS}`,
      )
      expect(location.split(chainIdentifier)).toHaveLength(2)
      expect(location).not.toContain('monad-wallet-state')
    }
  })

  it('gives the same address on two networks distinct locations', () => {
    const at = (chainIdentifier: string) =>
      walletStateLocation({
        base: DEFAULT_WALLET_STATE_BASE,
        chainIdentifier,
        owner: evmWalletStateOwner(ADDRESS.toUpperCase().replace('0X', '0x')),
      })
    expect(at('monad-testnet')).not.toBe(at('monad-regtest'))
    expect(at('monad-testnet')).not.toBe(at('ethereum-sepolia'))
  })

  it('refuses a name that is not a canonical network', () => {
    for (const chainIdentifier of ['monad', 'evm', 'MONT', '10143', ''])
      expect(() =>
        walletStateLocation({
          base: DEFAULT_WALLET_STATE_BASE,
          chainIdentifier,
          owner: evmWalletStateOwner(ADDRESS),
        }),
      ).toThrow(/canonical network/)
    expect(() => evmWalletStateOwner('evm')).toThrow()
  })

  it('lists what earlier builds named the same state, never the current name', () => {
    const params = {
      base: DEFAULT_WALLET_STATE_BASE,
      chainIdentifier: 'ethereum-sepolia',
      owner: evmWalletStateOwner(ADDRESS),
    }
    const earlier = earlierWalletStateLocations(params)
    expect(earlier).not.toContain(walletStateLocation(params))
    expect(earlier).toEqual(
      expect.arrayContaining([
        `${EARLIER_BROWSER_WALLET_STATE_BASE}-evm-${ADDRESS}`,
        `${EARLIER_BROWSER_WALLET_STATE_BASE}-ethereum-sepolia-ethereum-sepolia-evm-${ADDRESS}`,
        `${EARLIER_BROWSER_WALLET_STATE_BASE}-ethereum-sepolia-evm-${ADDRESS}`,
      ]),
    )
  })

  it('finds earlier browser state by IndexedDB database name without opening it', async () => {
    const globals = globalThis as Record<string, unknown>
    const opened = jest.fn()
    const location = `${EARLIER_BROWSER_WALLET_STATE_BASE}-evm-${ADDRESS}`
    globals.window = {}
    globals.indexedDB = {
      open: opened,
      databases: async () => [
        { name: `level-js-${location}/evm-coin-list-v1` },
        { name: `level-js-${location}-other/evm-coin-list-v1` },
        { name: 'frank-account-custody-local-account-v1' },
      ],
    }
    try {
      await expect(
        findEarlierWalletState([location, `${location}-x`]),
      ).resolves.toEqual([location])
      expect(opened).not.toHaveBeenCalled()
    } finally {
      delete globals.window
      delete globals.indexedDB
    }
  })
})

const root = <
  P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption',
>(
  purpose: P,
  fill: number,
): DomainRoot<P> => ({
  registry: 'frank-domain-roots-v1',
  purpose,
  bytes: new Uint8Array(32).fill(fill),
})
const roots = () => ({
  evm: root('evm-wallet', 7),
  authentication: root('identity-authentication', 8),
  messaging: root('messaging-encryption', 9),
})

function config(
  base: string,
  network: 'monad-testnet' | 'monad-regtest' | 'ethereum-sepolia',
): EvmChainConfig {
  const facts = {
    'monad-testnet': { chainId: 10143, networkTag: 'MONT' },
    'monad-regtest': { chainId: 20143, networkTag: 'MONR' },
    'ethereum-sepolia': { chainId: 11155111, networkTag: 'SEPO' },
  }[network]
  return {
    networkId: network,
    rpcChain: network,
    chainId: facts.chainId,
    networkTag: facts.networkTag,
    relayBaseUrl: 'http://127.0.0.1:1',
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    resolveDefaultStamp: fixedStampDefault(1n),
    defaultTopicVoteValueWei: 1n,
    subAccountPoolSize: 1,
    walletStorageLocation: base,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
}

describe('wallet state on disk', () => {
  let dir: string
  const wallets: EvmChainWalletHandle[] = []
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frank-wallet-state-names-'))
  })
  afterEach(async () => {
    await Promise.all(wallets.splice(0).map(wallet => wallet.close()))
    await rm(dir, { recursive: true, force: true })
  })
  const open = async (
    network: 'monad-testnet' | 'monad-regtest' | 'ethereum-sepolia',
  ) => {
    const wallet = (await createEvmChain(
      config(join(dir, 'wallet'), network),
    ).createWallet(roots())) as EvmChainWalletHandle
    wallets.push(wallet)
    return wallet
  }

  it('keeps one account on two Monad networks, and on Sepolia, in separate stores named once', async () => {
    const testnet = await open('monad-testnet')
    const regtest = await open('monad-regtest')
    const sepolia = await open('ethereum-sepolia')
    const main = testnet.mainAccount.address.toLowerCase()
    expect(regtest.mainAccount.address.toLowerCase()).toBe(main)
    expect(sepolia.mainAccount.address.toLowerCase()).toBe(main)

    expect(readdirSync(dir).sort()).toEqual(
      [
        `wallet-ethereum-sepolia-evm-${main}`,
        `wallet-monad-regtest-evm-${main}`,
        `wallet-monad-testnet-evm-${main}`,
      ].sort(),
    )
    // Every store of the wallet is a namespace under its one location.
    const stores = readdirSync(join(dir, `wallet-monad-testnet-evm-${main}`))
    expect(stores.length).toBeGreaterThan(3)
    expect(stores).toEqual(
      expect.arrayContaining(['sub-account-pool', 'change-pool']),
    )
    for (const wallet of [testnet, regtest, sepolia])
      expect(earlierEvmWalletState(wallet)).toMatchObject({
        chainIdentifier: wallet.chainIdentifier,
        earlierLocations: [],
      })
  })

  it('reports state an earlier build wrote for this account, and neither reads nor deletes it', async () => {
    // What an earlier build left: a Monad wallet named with no network at all.
    const probe = await open('monad-testnet')
    const main = probe.mainAccount.address.toLowerCase()
    await probe.close()
    wallets.splice(0)
    await rm(join(dir, `wallet-monad-testnet-evm-${main}`), {
      recursive: true,
      force: true,
    })
    const earlier = join(dir, `wallet-evm-${main}`)
    mkdirSync(join(earlier, 'evm-coin-list-v1'), { recursive: true })

    const wallet = await open('monad-testnet')
    expect(earlierEvmWalletState(wallet)).toEqual({
      chainIdentifier: 'monad-testnet',
      location: join(dir, `wallet-monad-testnet-evm-${main}`),
      earlierLocations: [earlier],
    })
    // Not read and not removed: the new location starts empty beside it.
    expect(existsSync(join(earlier, 'evm-coin-list-v1'))).toBe(true)
    expect(readdirSync(earlier)).toEqual(['evm-coin-list-v1'])
    expect(wallet.getReceivedPayments!()).toEqual([])
  })
})
