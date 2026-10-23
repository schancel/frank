/** @jest-environment node */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeChain,
  setActiveChain,
  type ActiveChain,
  type NativeWalletHandle,
} from '@frank/wallet/chain'
import { MonadIdentity } from '@frank/wallet/evm-identity'
import { createNativeNegotiationJournalStore } from '@frank/swap-protocol/src/storage/negotiation-native'
import {
  buildNegotiationOffer,
  TESTNET_NEGOTIATION_POLICY,
} from '@frank/swap-protocol/src/negotiation'
import {
  encodeSignedSwapEvent,
  type SwapResult,
} from '@frank/swap-protocol/src'
import { createPinia, setActivePinia } from 'pinia'
import { startDirectMessagePolling } from '../adapters/pinia-chain-adapter'
import { useMailboxStatusStore } from '../stores/mailbox-status'
import type { WalletHandle } from '@frank/wallet/chain'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  startAppNegotiationRecovery,
  negotiationRecoveryStatus,
} from './negotiation-recovery'
import type { NegotiationStorageBinding } from '@frank/swap-protocol/src/storage/negotiation-common'
let mockRoot: string
let mockFailAdmission = false
const mockPresentation: unknown[] = []
const mockChats = {
  relayCursor: async () => 0,
  noteConversationStates: async () => undefined,
  syncAllJoinedGroups: async () => undefined,
  quarantineRelayReceipts: async () => undefined,
  receiveMessages: jest.fn(async (wrappers: unknown[]) => {
    mockPresentation.push(...wrappers)
    return { cancelled: false }
  }),
}
jest.mock('../stores/chats', () => ({
  useChatStore: () => mockChats,
  walletOwnsMessage: () => true,
}))
jest.mock('./notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('./own-profile', () => ({
  syncOwnProfileWithRelay: jest.fn().mockResolvedValue('unchanged'),
}))
jest.mock('@frank/swap-protocol/src/storage/negotiation-browser', () => ({
  createBrowserNegotiationJournalStore: async (
    binding: NegotiationStorageBinding,
  ) => {
    const store = await createNativeNegotiationJournalStore({
      ...binding,
      rootLocation: mockRoot,
    })
    return {
      ...store,
      compareAndSwap: async (
        key: string,
        expected: string | undefined,
        next: string,
      ) => {
        if (mockFailAdmission) {
          mockFailAdmission = false
          throw new Error('Earlier admission failed')
        }
        return store.compareAndSwap(key, expected, next)
      },
    }
  },
}))
const a = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}01`),
  b = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}02`)
const receipt = {
  schema: 1,
  policy: 'browser-preview-aes-gcm-v1',
  context: {
    accountId: 'account-a',
    creationId: 'creation-a',
    recoveryFormat: 'frank-codex32-v1',
    registry: 'frank-domain-roots-v1',
    purposes: ['evm-wallet'],
    custodyEpoch: 0,
    recoveryFingerprint: 'fingerprint-a',
    retirementContext: '',
  },
  previousRevision: 0,
  revision: 1,
  operationId: 'operation-a',
}
const wallet = {
  chainIdentifier: 'monad-testnet',
  identity: a,
} as unknown as NativeWalletHandle
const previous = { ...activeChain }
const handles: { stop(): Promise<void> }[] = []
const must = <T>(value: SwapResult<T>): T => {
  if (!value.ok) throw new Error(value.error.code)
  return value.value
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('App recovery timeout')
}
beforeEach(async () => {
  setActivePinia(createPinia())
  mockFailAdmission = false
  mockPresentation.length = 0
  mockRoot = await mkdtemp(join(tmpdir(), 'app-negotiation-'))
})
afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.stop()))
  setActiveChain(previous)
  await rm(mockRoot, { recursive: true, force: true })
})
function start() {
  const handle = startAppNegotiationRecovery({
    wallet,
    revision: 1,
    account: { receipt },
  })
  handles.push(handle)
  return handle
}
test('actual app construction recovers earlier signed history after ordinary progress and restart', async () => {
  const context = {
    swapId: new Uint8Array(32).fill(1),
    conversationId: new Uint8Array(16).fill(2),
    parties: [a.compressedPubKey, b.compressedPubKey] as const,
    policy: TESTNET_NEGOTIATION_POLICY,
  }
  const event = must(
    encodeSignedSwapEvent(
      must(
        await buildNegotiationOffer(
          context,
          { xecPrincipal: 100n, evmPrincipal: 200n, expiry: 2000000000n },
          async digest => new Uint8Array(a.signHash(Buffer.from(digest))),
        ),
      ),
    ),
  )
  mockFailAdmission = true
  const scan = jest.fn().mockResolvedValue({
    records: [
      {
        chainIdentifier: 'monad-testnet',
        senderPublicKey: a.compressedPubKey,
        recipientPublicKey: b.compressedPubKey,
        direction: 'outbound',
        payloadDigest: 'ab'.repeat(32),
        messageId: '03030303-0303-0303-0303-030303030303',
        conversationId: '02020202-0202-0202-0202-020202020202',
        items: [
          {
            type: 'application',
            itemType: 'swap-negotiation-v1',
            value: { eventHex: bytesToHex(event) },
          },
        ],
      },
    ],
    resumeFromInclusive: 20,
    truncated: false,
  })
  setActiveChain({
    ...previous,
    chainIdentifier: 'monad-testnet',
    directMessages: {
      ...previous.directMessages!,
      scanAuthenticatedMailbox: scan,
    },
  } as ActiveChain)
  const first = start()
  await until(
    () => negotiationRecoveryStatus.snapshot?.state === 'storage-error',
  )
  const ordinary = jest
    .fn()
    .mockResolvedValueOnce([
      {
        senderAddress: b.address,
        recipientAddress: a.address,
        senderPublicKey: b.compressedPubKey,
        recipientPublicKey: a.compressedPubKey,
        messageId: '04040404-0404-0404-0404-040404040404',
        conversationId: '02020202-0202-0202-0202-020202020202',
        payloadDigest: 'cd'.repeat(32),
        receivedTime: 100,
        stampValueWei: 0n,
        items: [{ type: 'text', text: 'Later ordinary mail' }],
      },
    ])
    .mockResolvedValue([])
  activeChain.directMessages.fetchSince = ordinary
  activeChain.directMessages.subscribeMailboxStream = undefined
  const polling = startDirectMessagePolling({
    wallet: wallet as unknown as WalletHandle,
    intervalMs: 10,
  })
  try {
    await until(() => ordinary.mock.calls.length >= 2)
    expect(ordinary.mock.calls[1][0].sinceMs).toBe(101)
    expect(mockPresentation).toHaveLength(1)
    expect(useMailboxStatusStore().state).toBe('ok')
    expect(negotiationRecoveryStatus.snapshot?.state).toBe('storage-error')
  } finally {
    polling.stop()
  }
  mockPresentation.length = 0 // Deleting chat presentation cannot delete feature evidence.
  await first.stop()
  start()
  await until(() => negotiationRecoveryStatus.snapshot?.state === 'ready')
  expect(scan.mock.calls.map(call => call[0].sinceMs)).toEqual([0, 0])
  expect(negotiationRecoveryStatus.snapshot?.journals[0].entries).toHaveLength(
    1,
  )
})
test('replacement detaches old status, closes storage and ignores late scan results', async () => {
  let finish!: (result: {
    records: []
    resumeFromInclusive: number
    truncated: boolean
  }) => void
  const scan = jest.fn(
    () =>
      new Promise(resolve => {
        finish = resolve
      }),
  )
  setActiveChain({
    ...previous,
    chainIdentifier: 'monad-testnet',
    directMessages: {
      ...previous.directMessages!,
      scanAuthenticatedMailbox: scan,
    },
  } as unknown as ActiveChain)
  const first = start()
  await until(() => scan.mock.calls.length === 1)
  await first.stop()
  setActiveChain({
    ...previous,
    chainIdentifier: 'monad-mainnet',
  } as ActiveChain)
  start()
  expect(negotiationRecoveryStatus.snapshot?.state).toBe('unsupported')
  finish({ records: [], resumeFromInclusive: 999, truncated: false })
  await new Promise(resolve => setImmediate(resolve))
  expect(negotiationRecoveryStatus.snapshot?.state).toBe('unsupported')
})
