/** Corpus-backed reader for host polling tests. Real admission and decryption; page I/O is
 * supplied by the test. No chain calls, spending, or custody initialization are available. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeAddress } from 'ethers'
import { fromHex, toHex, verifyPreviewDirectoryEvidence } from '@frank/codec'
import { open } from '@frank/crypto-box'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import corpus from '../../../docs/protocol/cbor/vectors/dm-runtime.json'
import { createDefaultMessageItemRegistry } from '../message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '../message-item-plugins/registry'
import {
  canonicalDirectMessages,
  MemoryOutgoingMessageStore,
  type CanonicalMessagingOwner,
} from './evm-canonical-dm'

export async function canonicalPollingFixture() {
  const v = corpus.runtime_case
  const location = await mkdtemp(join(tmpdir(), 'canonical-polling-'))
  const evidence = verifyPreviewDirectoryEvidence(
    fromHex(v.attestation),
    corpus.network,
  )
  const store = await openNodeDirectoryStore({
    location: join(location, 'directory'),
    anchor: {
      network: corpus.network,
      subject: evidence.statement.subject,
      revisionZero: fromHex(v.t1),
    },
    mode: { kind: 'new' },
  })
  const current = await store.enroll(
    [{ statement: fromHex(v.statement), attestation: fromHex(v.attestation) }],
    {
      now: { seconds: 200n, nanoseconds: 0 },
      relay: evidence.statement.relays[0],
    },
  )
  const subject = toHex(evidence.statement.subject.keyBytes)
  const unavailable = (): never => {
    throw new Error('Polling fixture has no custody or network effects')
  }
  const registry = createDefaultMessageItemRegistry(
    pluginCapabilitiesNotYetAvailable,
  )
  const owner: CanonicalMessagingOwner = {
    installedNetworkTag: 'MONT',
    chainId: 10143n,
    relayBaseUrl: 'http://127.0.0.1:8098',
    identityAddress: computeAddress('0x' + subject),
    subject,
    messages: new MemoryOutgoingMessageStore(),
    payer: unavailable,
    signDigest: unavailable,
    lifetime: operation => operation(),
    messageItems: () => registry,
    directory: () => ({
      network: corpus.network,
      homeEndpoint: 'http://127.0.0.1:8098',
      selfCurrent: async () => current,
      peerCurrent: async () => ({
        subject,
        endpoint: 'http://127.0.0.1:8098',
        current,
      }),
    }),
    roles: {
      derivationRegistry: 'frank-domain-roots-v1',
      create: () => ({
        auth: {
          registry: 'frank-domain-roots-v1',
          path: 'fixture/auth',
          generation: 0,
          role: 'auth',
          purpose: 'identity-authentication',
          compressedPoint: evidence.statement.subject.keyBytes,
        },
        message: {
          registry: 'frank-domain-roots-v1',
          path: 'fixture/message',
          role: 'message',
          purpose: 'messaging-encryption',
          compressedPoint: current.messageKey.keyBytes,
          generation: 0,
        },
        stamp: {
          registry: 'frank-domain-roots-v1',
          path: 'fixture/stamp',
          role: 'stamp',
          purpose: 'evm-wallet',
          compressedPoint: current.stampKey.keyBytes,
          generation: 0,
        },
        sealMessage: unavailable,
        openMessage: input =>
          open({
            ...input,
            recipientPrivateKey: fromHex(v.message_secret_test_only),
          }),
        openOwnMessage: unavailable,
        openOwnDirectMessage: unavailable,
        dispose: () => undefined,
      }),
      verifyRetainedRecoveryCustody: unavailable,
      stampChildPrivateKey: unavailable,
      prepareRevisionZero: unavailable,
      prepareNextRevision: unavailable,
      publicGenerationZeroPoints: unavailable,
      conversationIdSalt: unavailable,
      dispose: () => undefined,
    },
  }
  return {
    client: canonicalDirectMessages(owner, unavailable),
    record: (timestampMs: number) => ({
      delivery: fromHex(v.delivery),
      context: fromHex(v.context),
      submissionIdentity: toHex(fromHex(v.t3)),
      timestampMs,
    }),
    close: async () => {
      await store.close()
      await rm(location, { recursive: true, force: true })
    },
  }
}
