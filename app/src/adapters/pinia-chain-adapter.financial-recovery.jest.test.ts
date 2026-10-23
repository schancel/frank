/**
 * The background reconciliation finishes stealth (UTXO) payments whose carrying message was
 * delivered (finding B1): after a restart that left an operation `exposed`, the reopened wallet's
 * stored signed bytes are submitted, and only once the messaging owner reports delivery.
 *
 * The UTXO wallet is real (in-memory store); the indexer is the narrow seam where an Electrum
 * server would answer. Plain `node` env, see `../stores/chats.jest.test.ts`.
 */
import { createPinia, setActivePinia } from 'pinia'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  privateKeyFromBytes,
  publicFromPrivate,
  signEcdsa,
} from '@frank/nakamoto'
import { stealthParentSecret } from '@frank/cashweb/relay/stealth-parent'
import {
  memoryUtxoWalletStore,
  parseUtxoAddress,
  UTXO_NETWORKS,
  UtxoWallet,
  type IndexedOutput,
  type UtxoIndexer,
  type UtxoWalletStore,
} from '@frank/wallet/utxo-wallet'
import type { UtxoStealthCustody } from '@frank/wallet/utxo-stealth'
import { activeChain } from '@frank/wallet/chain'
import type {
  DirectMessageAttemptStatus,
  NativeWalletHandle,
  WalletHandle,
} from '@frank/wallet/chain'
import { setConversationIdSalt } from '../stores/chats'
import { conversationIdSalt } from '@frank/cashweb/relay/conversation-id'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

const opened: { wallet: NativeWalletHandle }[] = []
jest.mock('../accounts/utxo-wallets', () => ({
  peekOpenedUtxoWallets: () => opened,
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('./level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))

import { startOutgoingReconciliation } from './pinia-chain-adapter'

const BTC = UTXO_NETWORKS['btc-testnet']
const ROOT = new Uint8Array(32).fill(7)
const DIGEST = 'f'.repeat(64)
const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const messagingWallet = {
  identity: { address: { raw: ME }, displayAddress: ME },
} as unknown as WalletHandle
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

function makeIndexer() {
  const unspent = new Map<string, IndexedOutput[]>()
  const broadcasts: string[] = []
  const indexer: UtxoIndexer = {
    listUnspent: async script => unspent.get(hex(script)) ?? [],
    hasHistory: async script => unspent.has(hex(script)),
    // Nothing is mined here: every rebroadcast is visible, and must be the same bytes.
    hasTransaction: async () => false,
    transactionConfirmation: async () => undefined,
    feeRate: async () => 2n,
    broadcast: async raw => {
      broadcasts.push(raw)
    },
  }
  return { indexer, unspent, broadcasts }
}

/** Identity custody unrelated to the wallet's HD root, as the session supplies it. */
function stealthCustody(identitySecret: Uint8Array): UtxoStealthCustody {
  const derive = (ephemeral: Uint8Array) =>
    stealthParentSecret(identitySecret, ephemeral).secret
  return {
    identityPublicKey: secp256k1.getPublicKey(identitySecret, true),
    assertActive: () => undefined,
    async deriveStealthSigner(derivation) {
      const key = privateKeyFromBytes(derive(derivation.ephemeralPubKey), true)
      if (!key.ok) throw new Error('bad key')
      const point = publicFromPrivate(key.value)
      if (!point.ok) throw new Error('bad point')
      return {
        publicKey: point.value.compressed,
        sign(digest) {
          const signer = privateKeyFromBytes(
            derive(derivation.ephemeralPubKey),
            true,
          )
          if (!signer.ok) throw new Error('bad signer')
          const signature = signEcdsa(signer.value, digest)
          if (!signature.ok) throw new Error('bad signature')
          return signature.value
        },
      }
    },
  }
}

async function openWallet(
  backend: ReturnType<typeof makeIndexer>,
  store: UtxoWalletStore,
) {
  return UtxoWallet.create({
    network: BTC,
    seed: ROOT,
    indexer: backend.indexer,
    storeFor: () => store,
    stealthCustody: stealthCustody(new Uint8Array(32).fill(23)),
  })
}

describe('stealth payment recovery in outgoing reconciliation (B1)', () => {
  const previousPromise = global.Promise
  beforeAll(() => {
    global.Promise = (async () => undefined)().constructor as PromiseConstructor
  })
  afterAll(() => {
    global.Promise = previousPromise
  })
  beforeEach(() => {
    setConversationIdSalt(conversationIdSalt(new Uint8Array(32).fill(0x7e)))
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    opened.length = 0
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const directMessages = activeChain.directMessages as Required<
      typeof activeChain.directMessages
    >
    jest.spyOn(directMessages, 'reconcileAttempts').mockResolvedValue({})
    jest.spyOn(directMessages, 'unattributedAttempts').mockResolvedValue([])
  })

  async function exposedThenRestarted() {
    const backend = makeIndexer()
    const store = memoryUtxoWalletStore()
    const sender = await openWallet(backend, store)
    const destination = parseUtxoAddress(BTC, sender.identity.address.raw)
    const script = `0014${hex((destination as { hash: Uint8Array }).hash)}`
    backend.unspent.set(script, [
      { txid: 'a'.repeat(64), vout: 0, amount: 70_000n, height: 100 },
    ])
    await sender.getBalance()
    const payments = sender.stealthPayments!
    const prepared = await payments.prepare({
      operationId: 'financial',
      chainIdentifier: BTC.chainIdentifier,
      asset: { kind: 'native' },
      recipientSpendPublicKey: secp256k1.getPublicKey(
        new Uint8Array(32).fill(29),
        true,
      ),
      amountAtomic: 10_000n,
      maxNativeFeeAtomic: 5_000n,
    })
    // Exposed to the relay with the message; the app stops before the payment is submitted.
    await payments.expose({ operationId: 'financial', payloadDigest: DIGEST })
    const reopened = await openWallet(backend, store)
    // Opening alone never pays an exposed operation: delivery is not known to the wallet.
    expect(backend.broadcasts).toEqual([])
    opened.push({ wallet: reopened as unknown as NativeWalletHandle })
    return { backend, prepared }
  }

  async function oneTick() {
    const reconciliation = startOutgoingReconciliation({
      wallet: messagingWallet,
    })
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    reconciliation.stop()
  }

  it('submits the stored signed bytes of an exposed operation once its message is delivered', async () => {
    const { backend, prepared } = await exposedThenRestarted()
    const deliveryOf = jest
      .spyOn(
        activeChain.directMessages as Required<
          typeof activeChain.directMessages
        >,
        'deliveryOf',
      )
      .mockResolvedValue('delivered')
    await oneTick()
    expect(deliveryOf).toHaveBeenCalledWith({
      wallet: messagingWallet,
      payloadDigest: DIGEST,
    })
    expect(backend.broadcasts.length).toBeGreaterThan(0)
    expect(new Set(backend.broadcasts)).toEqual(
      new Set([prepared.members[0].rawTransaction]),
    )
  })

  it.each(['live', undefined] as (DirectMessageAttemptStatus | undefined)[])(
    'never submits while delivery is not established (%s)',
    async status => {
      const { backend } = await exposedThenRestarted()
      jest
        .spyOn(
          activeChain.directMessages as Required<
            typeof activeChain.directMessages
          >,
          'deliveryOf',
        )
        .mockResolvedValue(status)
      await oneTick()
      expect(backend.broadcasts).toEqual([])
    },
  )
})
