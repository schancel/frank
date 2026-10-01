/**
 * @jest-environment jsdom
 */
import { createPinia, setActivePinia } from 'pinia'

const mockSaveMessage = jest.fn(async () => undefined)
const mockAdvanceRelayCursor = jest.fn(
  async (_address: string, next: number) => next,
)

jest.mock('../adapters/level-utxo-store', () => ({
  store: Promise.resolve({}),
}))
jest.mock('../adapters/level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: mockSaveMessage,
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    relayCursor: jest.fn(async () => 0),
    advanceRelayCursor: mockAdvanceRelayCursor,
    suppressedRelayReceipts: jest.fn(async () => new Set<string>()),
    getIterator: async function* () {
      /* no persisted messages */
    },
  }),
}))
jest.mock('../utils/notifications', () => ({
  desktopNotify: jest.fn(),
  errorNotify: jest.fn(),
}))

import { activeChain } from '@frank/wallet/chain'
import type { MonadChainConfig } from '@frank/wallet/chain/monad-chain'
import type { WalletHandle } from '@frank/wallet/chain'
import { useChatStore } from '../stores/chats'
import { useContactStore } from '../stores/contacts'
import { useMailboxStatusStore } from '../stores/mailbox-status'
import { useProfileStore } from '../stores/my-profile'
import { useWalletStore } from '../stores/wallet'
import { useMonadWallet } from './clients'
import { requestPersistentStorageWithin } from './persistent-storage'
import {
  configureMonadIdentitySession,
  initializeMonadIdentity,
  resetMonadIdentitySessionForTests,
  type MonadIdentityDeps,
} from './monad-identity-session'

const SEED_A = 'seed-a'
const SEED_B = 'seed-b'
const OWNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OWNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const TAIL_OWNER = '0xdddddddddddddddddddddddddddddddddddddddd'
const SENDER = '0xcccccccccccccccccccccccccccccccccccccccc'
const PUB_KEY = Uint8Array.from(
  Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex',
  ),
)

function walletFor(seed: string): WalletHandle {
  const address = seed === SEED_A ? OWNER_A : OWNER_B
  return {
    identity: { address: { raw: address }, displayAddress: address },
  }
}

function fakes() {
  const stops = { poll: [] as jest.Mock[], reconcile: [] as jest.Mock[] }
  const register = jest.fn(async () => undefined)
  const deps: Partial<MonadIdentityDeps> = {
    createWallet: jest.fn(async ({ mnemonic }) => walletFor(mnemonic)),
    register,
    startPolling: jest.fn(() => {
      const stop = jest.fn()
      stops.poll.push(stop)
      return { stop }
    }),
    startReconcile: jest.fn(() => {
      const stop = jest.fn()
      stops.reconcile.push(stop)
      return { stop }
    }),
    loadConfig: () =>
      ({ relayBaseUrl: 'http://relay.test' } as MonadChainConfig),
    ensurePersistentStorage: jest.fn(async () => undefined),
  }
  return { deps, stops, register }
}

async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}

jest.setTimeout(30_000)

describe('initializeMonadIdentity (#389)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetMonadIdentitySessionForTests()
    localStorage.clear()
    jest.restoreAllMocks()
    mockSaveMessage.mockReset().mockResolvedValue(undefined)
    mockAdvanceRelayCursor
      .mockReset()
      .mockImplementation(async (_address: string, next: number) => next)
  })

  afterEach(() => {
    resetMonadIdentitySessionForTests()
  })

  it('does nothing when setup has not stored a seed', async () => {
    const { deps } = fakes()
    await expect(initializeMonadIdentity(deps)).resolves.toBe('skipped')
    expect(deps.createWallet).not.toHaveBeenCalled()
    expect(deps.register).not.toHaveBeenCalled()
    expect(deps.startPolling).not.toHaveBeenCalled()
  })

  it('registers once with the profile name and starts one poll loop', async () => {
    const { deps, register } = fakes()
    useWalletStore().seedPhrase = SEED_A
    useProfileStore().setRelayData({
      profile: { name: 'Alice', bio: '', avatar: '' },
      inbox: {},
    })

    await expect(initializeMonadIdentity(deps)).resolves.toBe('started')
    await expect(initializeMonadIdentity(deps)).resolves.toBe('noop')

    expect(deps.createWallet).toHaveBeenCalledTimes(1)
    expect(deps.startPolling).toHaveBeenCalledTimes(1)
    expect(deps.startReconcile).toHaveBeenCalledTimes(1)
    expect(deps.ensurePersistentStorage).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        relayBaseUrl: 'http://relay.test',
        profile: expect.objectContaining({ name: 'Alice' }),
        identity: expect.objectContaining({ displayAddress: OWNER_A }),
      }),
    )
    expect(useMonadWallet().identity.displayAddress).toBe(OWNER_A)
  })

  it('treats a second call that overlaps the first as a no-op', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { deps } = fakes()
    deps.createWallet = jest.fn(async ({ mnemonic }) => {
      await gate
      return walletFor(mnemonic)
    })
    useWalletStore().seedPhrase = SEED_A

    const first = initializeMonadIdentity(deps)
    const second = initializeMonadIdentity(deps)
    release()

    await expect(first).resolves.toBe('started')
    await expect(second).resolves.toBe('noop')
    expect(deps.startPolling).toHaveBeenCalledTimes(1)
  })

  it('still polls when the relay registration fails', async () => {
    const { deps } = fakes()
    deps.register = jest.fn(async () => {
      throw new Error('relay down')
    })
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    useWalletStore().seedPhrase = SEED_A

    await expect(initializeMonadIdentity(deps)).resolves.toBe('started')
    expect(deps.startPolling).toHaveBeenCalledTimes(1)
  })

  it('stops the previous loops and clears a stale mailbox banner on replace', async () => {
    const { deps, stops, register } = fakes()
    useWalletStore().seedPhrase = SEED_A
    useProfileStore().setRelayData({
      profile: { name: 'Alice' },
      inbox: {},
    })
    await initializeMonadIdentity(deps)
    useMailboxStatusStore().setProblem('unavailable', 5000)

    useWalletStore().seedPhrase = SEED_B
    useProfileStore().setRelayData({
      profile: { name: 'Bob' },
      inbox: {},
    })
    await expect(initializeMonadIdentity(deps)).resolves.toBe('started')

    expect(stops.poll[0]).toHaveBeenCalledTimes(1)
    expect(stops.reconcile[0]).toHaveBeenCalledTimes(1)
    expect(deps.startPolling).toHaveBeenCalledTimes(2)
    expect(useMailboxStatusStore().state).toBe('ok')
    expect(register).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ name: 'Bob' }),
        identity: expect.objectContaining({ displayAddress: OWNER_B }),
      }),
    )
    expect(useMonadWallet().identity.displayAddress).toBe(OWNER_B)
  })

  it('does not ask for persistent storage again after sign-up just asked', async () => {
    const persist = jest.fn(async () => true)
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persisted: async () => false, persist },
    })
    const { deps } = fakes()
    delete deps.ensurePersistentStorage
    useWalletStore().seedPhrase = SEED_A

    await requestPersistentStorageWithin(3000)
    await initializeMonadIdentity(deps)

    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('delivers one direct message after init and does not poll twice', async () => {
    const chats = useChatStore()
    useContactStore().addContact({
      address: SENDER,
      contact: {
        profile: { name: 'Sender', bio: '', avatar: '', pubKey: null },
      },
    })
    jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
      address: { raw: SENDER },
      pubKey: PUB_KEY,
    })
    const fetchSince = jest
      .spyOn(activeChain.directMessages, 'fetchSince')
      .mockResolvedValue([
        {
          senderAddress: { raw: SENDER },
          recipientAddress: { raw: OWNER_A },
          items: [{ type: 'text', text: 'hello from the bot' }],
          payloadDigest: 'digest-1',
          stampValueWei: 1_000_000_000_000n,
          receivedTime: 1_700_000_000_000,
        },
      ])
    useWalletStore().seedPhrase = SEED_A
    configureMonadIdentitySession({ pollIntervalMs: 60 * 60 * 1000 })
    const { deps } = fakes()
    delete deps.startPolling

    await initializeMonadIdentity(deps)
    await settle()
    await initializeMonadIdentity(deps)
    await settle()

    expect(fetchSince).toHaveBeenCalledTimes(1)
    expect(chats.messages['digest-1']?.items).toEqual([
      { type: 'text', text: 'hello from the bot' },
    ])
  })

  it('does not let a replaced identity persist a receipt queued behind delivery', async () => {
    const chats = useChatStore()
    useContactStore().addContact({
      address: SENDER,
      contact: {
        profile: { name: 'Sender', bio: '', avatar: '', pubKey: null },
      },
    })
    jest.spyOn(activeChain, 'fetchProfile').mockResolvedValue({
      address: { raw: SENDER },
      pubKey: PUB_KEY,
    })
    jest
      .spyOn(activeChain.directMessages, 'fetchSince')
      .mockImplementation(async ({ wallet }) => {
        const recipient = wallet.identity.address.raw
        return [
          {
            senderAddress: { raw: SENDER },
            recipientAddress: { raw: recipient },
            items: [{ type: 'text', text: `for ${recipient}` }],
            payloadDigest:
              recipient === OWNER_A ? 'old-session' : 'current-session',
            stampValueWei: 1_000_000_000_000n,
            receivedTime: recipient === OWNER_A ? 100 : 101,
          },
        ]
      })

    let firstSaveStarted: (() => void) | undefined
    const saveStarted = new Promise<void>(resolve => {
      firstSaveStarted = resolve
    })
    let releaseFirstSave: (() => void) | undefined
    const saveGate = new Promise<void>(resolve => {
      releaseFirstSave = resolve
    })
    mockSaveMessage.mockImplementationOnce(async () => {
      firstSaveStarted?.()
      await saveGate
    })
    const deliverySpy = jest.spyOn(chats, 'receiveMessages')
    const tailOwner = chats.receiveMessages(
      [
        {
          outbound: false,
          senderAddress: SENDER,
          copartyAddress: SENDER,
          // The store only forwards this opaque key to an already-known contact.
          copartyPubKey: {} as never,
          index: 'delivery-tail-owner',
          stampValue: 1,
          message: {
            outbound: false,
            status: 'confirmed',
            items: [{ type: 'text', text: 'tail owner' }],
            serverTime: 99,
            receivedTime: 99,
            outpoints: [],
            stampValueWei: 1n,
            senderAddress: SENDER,
            destinationAddress: TAIL_OWNER,
          },
        },
      ],
      TAIL_OWNER,
    )
    await saveStarted

    useWalletStore().seedPhrase = SEED_A
    configureMonadIdentitySession({ pollIntervalMs: 60 * 60 * 1000 })
    const { deps } = fakes()
    delete deps.startPolling
    await initializeMonadIdentity(deps)
    for (
      let attempt = 0;
      attempt < 20 && deliverySpy.mock.calls.length < 2;
      attempt += 1
    ) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    expect(deliverySpy.mock.calls).toHaveLength(2)

    useWalletStore().seedPhrase = SEED_B
    await expect(initializeMonadIdentity(deps)).resolves.toBe('started')
    releaseFirstSave?.()
    await tailOwner
    await settle()

    expect(chats.messages['old-session']).toBeUndefined()
    expect(chats.messages['current-session']?.items).toEqual([
      { type: 'text', text: `for ${OWNER_B}` },
    ])
    expect(mockSaveMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ index: 'old-session' }),
      expect.anything(),
    )
    expect(mockAdvanceRelayCursor).not.toHaveBeenCalledWith(
      OWNER_A,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
    expect(mockAdvanceRelayCursor).toHaveBeenCalledWith(
      OWNER_B,
      102,
      [],
      [expect.objectContaining({ index: 'current-session' })],
    )
  })
})
