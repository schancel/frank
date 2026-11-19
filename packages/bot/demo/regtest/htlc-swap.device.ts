/**
 * One device of an account, in a process of its own, for htlc-swap.livecheck.ts: a process opens
 * an account's EVM wallet once (the wallet refuses a second handle of the same account), and an
 * account's devices each hold their own negotiation journal, swap record store and wallet state.
 * Driven over IPC.
 *
 *   argv: JSON DeviceConfig
 *   messages in:  { id, op, ...args } (see `handlers`)
 *   messages out: { ready: DeviceInfo } | { id, ok: true, result } | { id, ok: false, error }
 *
 * The device is real: an `EcashWallet` on the xec-regtest node's Chronik, an EVM wallet handle
 * on anvil as monad-regtest (only its RPC URL is redirected, see anvil-rpc-redirect.ts), the
 * wallet's swap capabilities and a fresh `HtlcSwapRunner` for every tick (a restarted process).
 */
import { redirectEvmRpcTo } from './anvil-rpc-redirect'

import { join } from 'path'

import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { ChronikClient } from 'chronik-client'
import { JsonRpcProvider, getBytes } from 'ethers'
import domainVectors from '@frank/domain-roots/vectors/domain-roots-v1.json'
import { InMemoryNativeTransactionAttemptStore } from '@frank/wallet/chain/chain-wallet'
import {
  conversationIdSaltOf,
  createEvmChain,
  htlcMainAccountOf,
  swapSecretCapabilityOf,
  type EvmChainConfig,
} from '@frank/wallet/chain/evm-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import type { MonadRootBundle } from '@frank/wallet/evm-wallet-material'
import { InMemoryEcashOperationStore } from '@frank/wallet/ecash-operation-store'
import { EcashWallet } from '@frank/wallet/ecash-wallet'
import type { XecHtlcTerms } from '@frank/wallet/ecash-htlc'
import { fixedStampDefault } from '@frank/wallet/oracle/stamp-policy.testutil'
import { createEvmHtlcSwapCapability, createXecHtlcSwapCapability } from '@frank/wallet/swap/htlc-swap-capabilities'
import type { NegotiationContext } from '@frank/swap-protocol/src/negotiation'
import { NegotiationJournal, type NegotiationJournalStore } from '@frank/swap-protocol/src/negotiation-journal'
import type { EvmHtlcCapability, XecHtlcCapability } from '@frank/swap-protocol/src/htlc-swap'
import { HtlcSwapRunner, MemoryHtlcSwapRecordStore, type HtlcSwapView } from '@frank/swap-protocol/src/htlc-swap-runner'

export interface DeviceConfig {
  name: string
  /** Account label, also its incarnation for the runner and journals. */
  account: string
  /** Index into the public domain-root test vectors (published test data, not real keys). */
  vector: number
  storageDir: string
  htlc: string
  anvilUrl: string
  chronikUrl: string
  checkpoint: { height: number; hash: string }
}
export interface DeviceInfo {
  publicKey: Uint8Array
  mainAccount: string
  xecAddress: string
  xecPrimary: string
}

const EVM_CHAIN_ID = 20143

class MemoryJournalStore implements NegotiationJournalStore {
  private rows = new Map<string, string>()
  async read(key: string) {
    return this.rows.get(key)
  }
  async compareAndSwap(key: string, expected: string | undefined, next: string) {
    if (this.rows.get(key) !== expected) return false
    this.rows.set(key, next)
    return true
  }
}

function rootsOf(index: number) {
  const outputs = domainVectors.vectors[index]!.outputs as Record<string, string>
  const root = <P extends string>(purpose: P) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: getBytes(`0x${outputs[purpose]}`),
  })
  return {
    evm: {
      evm: root('evm-wallet'),
      authentication: root('identity-authentication'),
      messaging: root('messaging-encryption'),
    } as MonadRootBundle,
    xec: root('ecash-bch-wallet' as const),
  }
}

async function main() {
  const config = JSON.parse(process.argv[2]!) as DeviceConfig
  redirectEvmRpcTo(config.anvilUrl)
  const roots = rootsOf(config.vector)
  const chronik = new ChronikClient([config.chronikUrl])
  const chain = new JsonRpcProvider(config.anvilUrl, EVM_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 })
  const evmConfig: EvmChainConfig = {
    networkId: 'monad-regtest',
    rpcChain: 'monad-regtest',
    localNodeWithoutSpendRule: true,
    chainId: EVM_CHAIN_ID,
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    // Never contacted: no relay is involved; the host hook below takes the notes to self.
    relayBaseUrl: 'http://127.0.0.1:1',
    networkTag: 'MONR',
    contracts: { htlc: config.htlc },
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    resolveDefaultStamp: fixedStampDefault(10n ** 15n),
    defaultTopicVoteValueWei: 1_000n,
    subAccountPoolSize: 0,
    walletStorageLocation: join(config.storageDir, 'wallet'),
    emitWalletSync: async () => undefined,
  }
  const evmChain = createEvmChain(evmConfig)
  const openEvm = async () => (await evmChain.createWallet(roots.evm)) as EvmChainWalletHandle
  // The eCash wallet's durable stores; a reopened wallet reads them again.
  const xecStores = {
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    operationStore: new InMemoryEcashOperationStore(),
  }
  const openXec = () =>
    EcashWallet.fromDomainRoot({
      domainRoot: { registry: 'frank-domain-roots-v1', purpose: 'ecash-bch-wallet', bytes: Uint8Array.from(roots.xec.bytes) },
      networkId: 'xec-regtest',
      checkpoint: config.checkpoint,
      chronik,
      ...xecStores,
      rebroadcast: async raws => {
        for (const raw of raws) await chronik.broadcastTx(raw)
      },
    })
  let evm = await openEvm()
  let xec = await openXec()
  const records = new MemoryHtlcSwapRecordStore()
  const journalStore = new MemoryJournalStore()
  const journals = new Map<string, { journal: NegotiationJournal; context: NegotiationContext }>()
  const publicKey = new Uint8Array(evm.identity.compressedPubKey)
  const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
  const salt = () => {
    const value = conversationIdSaltOf(evm)
    if (!value) throw new Error('account salt unavailable')
    return value
  }
  let failNext: 'xec-fund' | 'xec-broadcast' | undefined
  let now = 0
  let active = false

  const runner = () => {
    const xecCapability = createXecHtlcSwapCapability({ wallet: xec, chronik, finality: { kind: 'confirmations', depth: 1 } })
    const faulty: XecHtlcCapability = {
      ...xecCapability,
      async fund(input) {
        if (failNext === 'xec-fund') {
          failNext = undefined
          throw new Error('the process stopped before funding')
        }
        return xecCapability.fund(input)
      },
      async broadcast(raw) {
        if (failNext === 'xec-broadcast') {
          failNext = undefined
          throw new Error('the process stopped before broadcasting')
        }
        return xecCapability.broadcast(raw)
      },
    }
    const evmCapability: EvmHtlcCapability = createEvmHtlcSwapCapability({
      wallet: evm,
      reader: chain,
      contract: config.htlc,
      finalityDepth: 1,
    })
    return new HtlcSwapRunner({
      owner: { accountIncarnation: config.account, localPublicKey: publicKey },
      negotiations: {
        list: () =>
          Promise.all(
            [...journals.values()].map(async ({ journal, context }) => ({
              context,
              reduction: (await journal.read()).reduction,
            })),
          ),
      },
      store: records,
      xec: faulty,
      evm: evmCapability,
      secrets: swapSecretCapabilityOf(evm)!,
      offerSwapId: transcript => hmac(sha256, salt(), transcript),
      clock: { now: () => now },
      isActiveDevice: () => active,
    })
  }

  const handlers: Record<string, (args: any) => Promise<unknown>> = {
    async offerSwapId({ transcript }: { transcript: Uint8Array }) {
      return hmac(sha256, salt(), transcript)
    },
    /** The hash lock of A's own swap; the preimage stays in custody. */
    async hashLock({ policyName, swapId }: { policyName: string; swapId: Uint8Array }) {
      const preimage = swapSecretCapabilityOf(evm)!.swapPreimage({ policyName, swapId })
      const lock = sha256(preimage)
      preimage.fill(0)
      return lock
    },
    async htlcKey({ swapId, role }: { swapId: string; role: 'claim' | 'refund' }) {
      return xec.htlcPublicKey(swapId, role)
    },
    async sign({ digest }: { digest: Uint8Array }) {
      return new Uint8Array(evm.identity.signHash(Buffer.from(digest)))
    },
    async admit(input: {
      context: NegotiationContext
      bytes: Uint8Array
      sender: Uint8Array
      recipient: Uint8Array
      messageId: Uint8Array
      digest: Uint8Array
    }) {
      const key = hex(input.context.swapId)
      let entry = journals.get(key)
      if (!entry) {
        entry = {
          context: input.context,
          journal: new NegotiationJournal({
            owner: { accountIncarnation: config.account, localPublicKey: publicKey, messagingChainIdentifier: 'monad-regtest' },
            context: input.context,
            store: journalStore,
          }),
        }
        journals.set(key, entry)
      }
      const snapshot = await entry.journal.admit({
        eventBytes: input.bytes,
        authenticated: {
          direction: hex(input.sender) === hex(publicKey) ? 'outbound-replay' : 'incoming',
          localPublicKey: publicKey,
          senderPublicKey: input.sender,
          recipientPublicKey: input.recipient,
          conversationId: input.context.conversationId,
          messagingChainIdentifier: 'monad-regtest',
        },
        messageId: input.messageId,
        stampedPayloadDigest: input.digest,
      })
      if (snapshot.reduction.violation) throw new Error(JSON.stringify(snapshot.reduction.violation))
      return snapshot.admission
    },
    async tick(input: {
      swapId: string
      now: number
      active: boolean
      reopen?: boolean
      failNext?: 'xec-fund' | 'xec-broadcast'
    }): Promise<HtlcSwapView> {
      if (input.reopen) {
        await evm.close()
        evm = await openEvm()
        xec = await openXec()
      }
      now = input.now
      active = input.active
      failNext = input.failNext
      const views = await runner().tick()
      failNext = undefined
      const view = views.find(v => v.swapId === input.swapId)
      if (!view) throw new Error(`${config.name} does not see swap ${input.swapId}`)
      return view
    },
    async record({ swapId }: { swapId: string }) {
      return (await records.getRecord(swapId))?.raw
    },
    /** A refund by A's own keys outside the runner: a dishonest (or broken) A. */
    async refundOutsideRunner(input: {
      swapId: string
      terms: XecHtlcTerms
      funding: { txid: string; vout: number }
      principalSats: bigint
    }) {
      const spend = xec.signHtlcSpend({ ...input, branch: 'refund' })
      await chronik.broadcastTx(spend.rawTx)
      return spend.txid
    },
    async close() {
      await evm.close().catch(() => undefined)
      chain.destroy()
      setImmediate(() => process.exit(0))
      return true
    },
  }

  process.on('message', async (request: { id: number; op: string }) => {
    try {
      const handler = handlers[request.op]
      if (!handler) throw new Error(`unknown op ${request.op}`)
      process.send!({ id: request.id, ok: true, result: await handler(request) })
    } catch (error) {
      process.send!({ id: request.id, ok: false, error: (error as Error).stack ?? String(error) })
    }
  })
  const info: DeviceInfo = {
    publicKey,
    mainAccount: htlcMainAccountOf(evm)!,
    xecAddress: (await xec.getReceiveAddress()).raw,
    xecPrimary: xec.identity.address.raw,
  }
  process.send!({ ready: info })
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
