/** Installed shared app/headless pipeline. The Rust parent test supplies two real blob
 * routers; the default suite supplies bounded HTTP stand-ins. Custody, sealing and Level
 * journals are real. Chain RPC/payment finality and mailbox delivery use the offline fixture. */
import {
  fixture,
  mailboxes,
  mockBalances,
  mockFunded,
  offlineChain,
  type Fixture,
  type InboxRecord,
} from './canonical-two-wallets.testutil'
import { getBytes } from 'ethers'
import { sha256 } from '@noble/hashes/sha256'
import {
  toHex,
  decodeCanonical,
  encodeCanonical,
  encodePluginMessageItem,
  isPluginMessageItemFrame,
  parseFrame,
} from '@frank/codec'
import * as canonicalDm from '@frank/cashweb/relay/canonical-dm'
import type { MessageItem } from '@frank/cashweb/types/messages'
import type { CanonicalFetch } from '@frank/cashweb/relay/canonical-dm-transport'
import { EvmStampPayer } from '../evm-stamp-payer'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { MonadRootBundle } from '../monad-wallet-material'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { installCanonicalDirectory } from './monad-chain'
import {
  CanonicalPayloadUnavailableError,
  LevelOutgoingMessageStore,
  type CanonicalDirectory,
} from './monad-canonical-dm'
import {
  DirectMessageAlreadyAttemptedError,
  isDirectMessageNotAttempted,
} from './active-chain'

jest.mock('../monad-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../monad-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
let mockStreamHandler: ((record: InboxRecord) => Promise<void>) | undefined
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () => ({
  ...require('./canonical-two-wallets.testutil').offlineMailboxModule(),
  connectCanonicalMailboxStream: async (params: {
    onRecord: typeof mockStreamHandler
  }) => {
    mockStreamHandler = params.onRecord
    return { close: jest.fn() }
  },
}))

const ID = '0a0b0c0d-1a1b-4c1d-8a2b-3a3b3c3d3e3f'
function roots(index = 0): MonadRootBundle {
  const outputs = domainVectors.vectors[index].outputs
  const root = <
    P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption',
  >(
    purpose: P,
  ) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: getBytes(`0x${outputs[purpose]}`),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

// > 1 MiB decoded attachment, four complete chunks and one final chunk.
const attachment = Uint8Array.from(
  { length: 1024 * 1024 + 777 },
  (_, i) => (i * 73 + (i >>> 8)) & 255,
)
const original: MessageItem[] = [
  {
    type: 'email',
    messageId: '<payload@example.org>',
    from: { address: 'alice@example.org' },
    to: [{ address: 'bob@example.org' }],
    subject: 'large payload',
    textBody: 'attachment',
    attachments: [
      {
        filename: 'payload.bin',
        contentType: 'application/octet-stream',
        content: attachment,
      },
    ],
  },
]

function response(url: string, bytes: Uint8Array, status = 200) {
  return {
    status,
    url,
    headers: { get: () => null },
    body: new Response(bytes).body,
  }
}

describe('installed transparent payload runtime', () => {
  jest.setTimeout(90_000)
  let f: Fixture, alice: EvmChainWalletHandle
  let aliceDirectory: CanonicalDirectory
  let inbox: InboxRecord[]
  let sign: jest.SpyInstance, stores: jest.SpyInstance
  let writes: string[], reads: string[]
  let missing: boolean, corrupt: boolean, uploadFail: boolean
  let chunks: Map<string, Uint8Array>
  let holdChunk: Promise<void> | undefined
  const senderOrigin = process.env.FRANK_PAYLOAD_SENDER_RELAY
  const receiverOrigin = process.env.FRANK_PAYLOAD_RECEIVER_RELAY

  beforeEach(async () => {
    offlineChain.reset()
    mockBalances.clear()
    mockFunded.length = 0
    mailboxes.clear()
    writes = []
    reads = []
    chunks = new Map()
    missing = false
    corrupt = false
    uploadFail = false
    holdChunk = undefined
    mockStreamHandler = undefined
    stores = jest.spyOn(LevelOutgoingMessageStore, 'open')
    f = await fixture(senderOrigin ? { relayBaseUrl: senderOrigin } : {})
    alice = f.alice
    const senderBase = await f.directoryFor('payload-alice', alice, f.bob)
    const receiverBase = await f.directoryFor('payload-bob', f.bob, alice)
    const installedSender = senderOrigin ?? f.config.relayBaseUrl
    const installedReceiver = receiverOrigin ?? f.config.relayBaseUrl
    const transport =
      (home: string, base: CanonicalDirectory): CanonicalFetch =>
      async (url, init) => {
        if (new URL(url).pathname.startsWith('/blobs/')) {
          expect(new URL(url).origin).toBe(home)
          expect(init.redirect).toBe('error')
          expect(init.credentials).toBe('omit')
          const hash = new URL(url).pathname.split('/').pop()!
          if (init.method === 'PUT') {
            writes.push(url)
            if (uploadFail) throw new Error('interrupted upload')
            expect(init.body!.byteLength).toBeLessThanOrEqual(262144 + 16)
            expect(toHex(sha256(init.body!))).toBe(hash)
            chunks.set(hash, new Uint8Array(init.body!))
          } else {
            reads.push(url)
            await holdChunk
            if (missing) return response(url, new Uint8Array(), 404)
            if (corrupt) {
              const bytes = new Uint8Array(chunks.get(hash)!)
              bytes[0] ^= 1
              return response(url, bytes)
            }
          }
          if (senderOrigin && receiverOrigin) return globalThis.fetch(url, init)
          return response(
            url,
            init.method === 'PUT' ? new Uint8Array() : chunks.get(hash)!,
          )
        }
        // Only blobs use Rust HTTP; the shared fixture verifies/replays the sealed
        // canonical envelope and payment set through its simulated mailbox relay.
        return base.fetch!(
          new URL(base.homeEndpoint).origin + new URL(url).pathname,
          init,
        )
      }
    aliceDirectory = {
      ...senderBase,
      forwarding: async () => true,
      fetch: transport(installedSender, senderBase),
    }
    installCanonicalDirectory(alice, aliceDirectory)
    // The fixture creates both wallets with one chain config. Bind Bob's runtime to
    // its separate Home Relay by opening his wallet under the matching composition.
    if (receiverOrigin) {
      // CanonicalMessagingOwner takes its stable relay origin from its chain config.
      // The second composition shares only the existing test storage and roots.
      await f.bob.close()
      const { createEvmChain } = await import('./monad-chain')
      const { withDefaultMessageItems } = await import(
        './message-items.testutil'
      )
      f.bob = (await withDefaultMessageItems(
        createEvmChain({ ...f.config, relayBaseUrl: receiverOrigin }),
      ).createWallet(roots(1))) as EvmChainWalletHandle
    }
    installCanonicalDirectory(f.bob, {
      ...receiverBase,
      fetch: transport(installedReceiver, receiverBase),
    })
    inbox = []
    mailboxes.set(toHex(f.bob.identity.compressedPubKey), inbox)
    f.setMailbox(inbox)
    sign = jest.spyOn(EvmStampPayer.prototype, 'sign')
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await alice.close().catch(() => undefined)
    await f.bob.close().catch(() => undefined)
    await f.close().catch(() => undefined)
  })
  const send = () =>
    f.chain.directMessages.send({
      wallet: alice,
      recipient: f.bob.identity.address,
      messageId: ID,
      items: original,
      stampValue: 1000n,
    })
  const receive = () =>
    f.chain.directMessages.fetchSince({ wallet: f.bob, sinceMs: 0 })
  async function reopen() {
    await alice.close()
    alice = (await f.chain.createWallet(roots())) as EvmChainWalletHandle
    installCanonicalDirectory(alice, aliceDirectory)
  }
  async function row() {
    for (let i = stores.mock.calls.length - 1; i >= 0; i--) {
      const store: LevelOutgoingMessageStore = await stores.mock.results[i]
        .value
      const found = store
        .all()
        .find((item) => item.consumerId.endsWith(ID.replace(/-/g, '')))
      if (found) return found
    }
    throw new Error('no durable payload envelope')
  }

  it('restores a >1MiB attachment through installed send/receive and preserves exact durable payload/payment on crash retry', async () => {
    // Crash after complete envelope/payment durability, before external exposure.
    await expect(
      f.chain.directMessages.send({
        wallet: alice,
        recipient: f.bob.identity.address,
        messageId: ID,
        items: original,
        stampValue: 1000n,
        onEnvelopeDurable: async () => {
          throw new Error('crash before relay exposure')
        },
      }),
    ).rejects.toThrow()
    expect(sign).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(5)
    expect(f.requests).toHaveLength(0)
    const before = await row()
    // Attachment bytes, metadata, chunk addresses and decryption material are
    // carried only inside the sealed manifest, not in the relay envelope fields.
    expect(before.request.body.length / 2).toBeLessThan(32768)
    expect(before.request.body).not.toContain(
      toHex(new TextEncoder().encode('payload.bin')),
    )
    for (const url of writes) {
      expect(before.request.body).not.toContain(
        new URL(url).pathname.split('/').pop()!,
      )
    }
    const account = (await alice.getReceiveAddress()).raw.toLowerCase()
    const holder = alice.pool.accountClaimedBy(account)
    expect(holder).toBeDefined()
    expect(before.payments.length).toBeGreaterThan(0)
    const signed = before.payments.map((payment) => payment.rawTx)
    await reopen()
    const after = await row()
    expect(alice.pool.accountClaimedBy(account)).toBe(holder)
    expect(after.request).toEqual(before.request)
    expect(after.payments.map((payment) => payment.rawTx)).toEqual(signed)
    const status = await f.chain.directMessages.reconcileAttempts({
      wallet: alice,
      payloadDigests: [before.digest],
      onEnvelopeDurable: async () => undefined,
    })
    expect(status[before.digest]).toBeDefined()
    expect(sign).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(5)
    expect(
      f.requests.every(
        (request) => toHex(request.body) === before.request.body,
      ),
    ).toBe(true)
    await expect(send()).rejects.toBeInstanceOf(
      DirectMessageAlreadyAttemptedError,
    )
    expect(sign).toHaveBeenCalledTimes(1)
    expect(writes).toHaveLength(5)
    const messages = await receive()
    expect(messages).toHaveLength(1)
    const email = messages[0].items.find((item) => item.type === 'email')
    expect(email?.type).toBe('email')
    if (email?.type !== 'email') throw new Error('email was not restored')
    expect(toHex(sha256(email.attachments![0].content!))).toBe(
      toHex(sha256(attachment)),
    )
    expect(
      messages[0].items.some((item) => item.type === 'blob-manifest'),
    ).toBe(false)
    expect(reads).toHaveLength(5)
  })

  it('repeats a named unpaid payload after restart without uploading or sealing replacement chunks', async () => {
    const params = {
      wallet: alice,
      recipient: f.bob.identity.address,
      messageId: ID,
      items: original,
      stampValue: 0n,
    }
    await expect(
      f.chain.directMessages.send({
        ...params,
        onEnvelopeDurable: async () => {
          throw new Error('host interrupted')
        },
      }),
    ).rejects.toThrow()
    expect(writes).toHaveLength(5)
    expect(sign).not.toHaveBeenCalled()
    let envelope
    for (const result of stores.mock.results) {
      const store: LevelOutgoingMessageStore = await result.value
      envelope = store.unpaid(ID.replace(/-/g, '')) ?? envelope
    }
    expect(envelope?.boundary).toBeDefined()
    await reopen()
    const result = await f.chain.directMessages.send({
      ...params,
      wallet: alice,
      items: [{ type: 'text', text: 'replacement must not be sealed' }],
      onEnvelopeDurable: async () => undefined,
    })
    expect(result.payloadDigest).toBe(envelope!.digest)
    expect(writes).toHaveLength(5)
    expect(sign).not.toHaveBeenCalled()
    const messages = await receive()
    expect(messages).toHaveLength(1)
    expect(messages[0].items.some((item) => item.type === 'email')).toBe(true)
  })

  it('an interrupted pre-seal upload reserves and pays nothing and can retry after reopen', async () => {
    uploadFail = true
    try {
      await send()
      throw new Error('send unexpectedly succeeded')
    } catch (error) {
      expect(isDirectMessageNotAttempted(error)).toBe(true)
    }
    expect(sign).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
    expect(
      alice.pool.accountClaimedBy(
        (await alice.getReceiveAddress()).raw.toLowerCase(),
      ),
    ).toBeUndefined()
    await reopen()
    uploadFail = false
    await send()
    expect(sign).toHaveBeenCalledTimes(1)
    expect(await receive()).toHaveLength(1)
  })

  it('preserves an authenticated unsupported manifest version without fetching or executing it', async () => {
    // Simulate a newer sender at the seal boundary. The installed local writer
    // correctly refuses to author version 2; only external input can contain it.
    const prepare = canonicalDm.prepareDirectMessage
    jest
      .spyOn(canonicalDm, 'prepareDirectMessage')
      .mockImplementation((input) =>
        prepare({
          ...input,
          items: input.items.map((bytes) => {
            const frame = parseFrame(bytes)
            if (
              !isPluginMessageItemFrame(frame) ||
              frame.typed.itemType !== 'blob-manifest'
            )
              return bytes
            const manifest = decodeCanonical(frame.typed.data)
            if (!(manifest instanceof Map))
              throw new Error('expected manifest map')
            manifest.set(0n, 2n)
            return encodePluginMessageItem({
              itemType: 'blob-manifest',
              data: encodeCanonical(manifest),
            })
          }),
        }),
      )
    await send()
    const messages = await receive()
    expect(messages).toHaveLength(1)
    expect(messages[0].items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'unsupported',
          itemType: 'blob-manifest',
          reason: 'malformed',
          frame: expect.any(String),
        }),
      ]),
    )
    expect(reads).toHaveLength(0)
    expect(sign).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'overlapping stream records yield to polling and close=%s suppresses pending delivery',
    async (closeEarly) => {
      await send()
      for (const messageId of [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ]) {
        await f.chain.directMessages.send({
          wallet: alice,
          recipient: f.bob.identity.address,
          messageId,
          items: [{ type: 'text', text: messageId }],
          stampValue: 0n,
        })
      }
      let release!: () => void
      holdChunk = new Promise<void>((resolve) => {
        release = resolve
      })
      const delivered: unknown[] = [],
        errors: Error[] = []
      const close = f.chain.directMessages.subscribeMailboxStream!({
        wallet: f.bob,
        onRecord: (record) => delivered.push(record),
        onError: (error) => errors.push(error),
      })
      for (let i = 0; i < 100 && !mockStreamHandler; i++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      expect(mockStreamHandler).toBeDefined()
      const pending = mockStreamHandler!(inbox[0])
      for (let i = 0; i < 100 && reads.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      expect(reads.length).toBeGreaterThan(0)
      await mockStreamHandler!(inbox[1])
      if (closeEarly) close()
      release()
      await pending
      await mockStreamHandler!(inbox[2])
      expect(delivered).toHaveLength(closeEarly ? 0 : 1)
      expect(
        errors.some((error) => error.message.includes('overlapping')),
      ).toBe(true)
      close()
      // No later stream delivery can acknowledge the skipped second record. The
      // atomic poll still restores all three sealed records, including the blob.
      holdChunk = undefined
      expect(await receive()).toHaveLength(3)
    },
  )

  it.each(['missing', 'tampered'])(
    'reports %s chunks without consuming the sealed message; later restoration retries original bytes',
    async (mode) => {
      await send()
      missing = mode === 'missing'
      corrupt = mode === 'tampered'
      await expect(receive()).rejects.toBeInstanceOf(
        CanonicalPayloadUnavailableError,
      )
      expect(inbox).toHaveLength(1)
      expect(sign).toHaveBeenCalledTimes(1)
      missing = false
      corrupt = false
      expect(await receive()).toHaveLength(1)
      expect(sign).toHaveBeenCalledTimes(1)
      expect(writes).toHaveLength(5)
    },
  )
})
