/** Real host and typed wallet/cache; established canonical fixture supplies node/relay effects. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActiveChain } from './chain/active-chain'
import type { EvmChainWalletHandle } from './evm-wallet-handle'
import type { BotContext } from '../bot-framework/src/types'
import { FrankBotHost } from '../bot-framework/src/bot-host'
import { fixture, mockBalances } from './chain/canonical-two-wallets.testutil'

let mockHostChain: ActiveChain
let mockDirectoryFor: (wallet: EvmChainWalletHandle) => Promise<unknown>
jest.mock('./chain/evm-host', () => ({
  createRelayPricedEvmChain: () => mockHostChain,
}))
jest.mock('./evm-provider', () =>
  require('./chain/canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('./evm-http', () =>
  require('./chain/canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./chain/canonical-two-wallets.testutil').offlineMailboxModule(),
)
jest.mock('../bot-framework/src/relay-profile-manager', () => ({
  RelayProfileManager: {
    registerProfile: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock('../bot-framework/src/directory-manager', () => ({
  DirectoryManager: {
    create: ({ handle }: { handle: EvmChainWalletHandle }) => {
      const directory = {
        network: 'monad-testnet',
        rawDirectory: undefined as unknown,
        publishWithRetry: async () => {
          directory.rawDirectory = await mockDirectoryFor(handle)
        },
        startHeartbeat: jest.fn(),
        lookupPeer: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      }
      return directory
    },
  },
}))

it('activates shared wallet observations before a funded ordinary bot accepts paid work', async () => {
  const previousEnv = process.env
  process.env = { ...previousEnv }
  for (const key of [
    'E2E_DEMO_MAIN_WALLET_PRIVATE_KEY',
    'E2E_DEMO_MAIN_WALLET_JSON',
    'FRANK_DEMO_FAUCET_WALLET_JSON',
  ])
    delete process.env[key]
  const location = mkdtempSync(join(tmpdir(), 'frank-bot-activation-'))
  const f = await fixture()
  const createWallet = f.chain.createWallet.bind(f.chain)
  mockHostChain = {
    ...f.chain,
    createWallet: async roots => {
      const wallet = (await createWallet(roots)) as EvmChainWalletHandle
      // The host receives already funded custody, exactly as a restored bot does.
      mockBalances.set(
        wallet.identity.address.raw.toLowerCase(),
        100n * 10n ** 18n,
      )
      return wallet
    },
  }
  mockDirectoryFor = wallet => f.directoryFor('hosted', wallet, f.bob)
  const host = new FrankBotHost({
    stateDir: location,
    relayBaseUrl: 'http://127.0.0.1:8098',
    rpcUrl: 'http://127.0.0.1:1',
    networkTag: 'MONT',
    stampValueWei: 0n,
    watchRegistrations: false,
    unrefTimers: true,
  })
  let context: BotContext | undefined
  try {
    await host.register({
      id: 'activation-probe',
      label: 'Activation probe',
      defaultIdentityPath: join(location, 'unused-identity.json'),
      getProfile: () => ({ name: 'Activation probe' }),
      onStart: async ctx => {
        context = ctx
      },
      onMessage: async () => undefined,
    })
    expect(context).toBeDefined()
    // This is the actual dealer/outbox capability, not a replacement wallet implementation.
    // A zero result means the host masked an uninitialized fee quote as an unavailable floor.
    expect(await context!.minimumStampWei!()).toBeGreaterThan(0n)
    await expect(
      context!.sendDirectMessage(
        f.bob.identity.address.raw,
        [{ type: 'text', text: 'first paid bot reply' }],
        undefined,
        { stampValueWei: 100_000n },
      ),
    ).resolves.toMatchObject({
      stampValueWei: 100_000n,
    })
  } finally {
    await host.stop()
    await f.close()
    process.env = previousEnv
    rmSync(location, { recursive: true, force: true })
  }
}, 120_000)
