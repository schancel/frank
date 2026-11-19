/**
 * Runner mechanics at the capability seam: what it asks custody for, the order of its durable
 * writes and hand-offs, and what it refuses. The chains are stubbed here only to drive those
 * orders; the swap itself runs on real nodes in
 * packages/bot/demo/regtest/htlc-swap.livecheck.ts.
 */
import { sha256 } from '@noble/hashes/sha256.js'
import { hmac } from '@noble/hashes/hmac.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { MonadIdentity } from '../../wallet/evm-identity'
import { encodeSignedSwapEvent, type SwapResult } from './index'
import {
  REGTEST_PROOF_NEGOTIATION_POLICY,
  buildNegotiationOffer,
  buildNegotiationResponse,
  deriveOfferSwapId,
  reduceNegotiationStandalone,
  type NegotiationContext,
} from './negotiation'
import { fixtureOfferFields } from './negotiation-fixtures.testutil'
import {
  htlcSwapTermsOf,
  parseHtlcSwapRecord,
  type EvmHtlcCapability,
  type EvmHtlcObservation,
  type XecHtlcCapability,
  type XecHtlcObservation,
} from './htlc-swap'
import {
  HtlcSwapRunner,
  MemoryHtlcSwapRecordStore,
  type HtlcSwapNegotiation,
} from './htlc-swap-runner'

const a = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}01`)
const b = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}02`)
const sign = (id: MonadIdentity) => async (digest: Uint8Array) =>
  new Uint8Array(id.signHash(Buffer.from(digest)))
function must<T>(value: SwapResult<T>): T {
  if (!value.ok) throw new Error(JSON.stringify(value.error))
  return value.value
}
const salt = new Uint8Array(32).fill(0x5a)
const keyedHash = (t: Uint8Array) => hmac(sha256, salt, t)
const E = 2_000_000_000
const T_B = E + 120
const preimageOf = (swapId: Uint8Array) =>
  sha256(Uint8Array.from([...swapId, 1]))
const refundKey =
  '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const claimKey =
  '02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13'
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'))

async function negotiation(): Promise<HtlcSwapNegotiation> {
  const parties = [
    new Uint8Array(a.compressedPubKey),
    new Uint8Array(b.compressedPubKey),
  ] as const
  const conversationId = new Uint8Array(16).fill(0x22)
  const policy = REGTEST_PROOF_NEGOTIATION_POLICY
  const facts = fixtureOfferFields({
    expiry: BigInt(E),
    evmExpiry: BigInt(T_B),
    xecRefundTime: BigInt(T_B + 120),
  })
  const swapId = must(
    deriveOfferSwapId({ policy, conversationId, parties, ...facts }, keyedHash),
  )
  const fields = {
    ...facts,
    hashLock: sha256(preimageOf(swapId)),
    xecRefundPublicKey: fromHex(refundKey),
  }
  const context: NegotiationContext = {
    swapId,
    conversationId,
    parties,
    policy,
  }
  const offer = must(
    encodeSignedSwapEvent(
      must(await buildNegotiationOffer(context, fields, sign(a))),
    ),
  )
  const accept = must(
    encodeSignedSwapEvent(
      must(
        await buildNegotiationResponse(
          context,
          offer,
          {
            kind: 'accept',
            fields: {
              xecClaimPublicKey: fromHex(claimKey),
              evmSender: new Uint8Array(20).fill(0xbb),
            },
          },
          sign(b),
        ),
      ),
    ),
  )
  return {
    context,
    reduction: must(reduceNegotiationStandalone([offer, accept], context)),
  }
}

function harness(
  n: HtlcSwapNegotiation,
  local: 'A' | 'B',
  overrides: {
    offerSwapId?: (t: Uint8Array) => Uint8Array
    active?: boolean
  } = {},
) {
  const log: string[] = []
  const store = new MemoryHtlcSwapRecordStore()
  const swapIdHex = bytesToHex(n.context.swapId)
  const state = {
    xec: { tipMedianTime: E, outputs: [] } as XecHtlcObservation,
    evm: {
      latest: null,
      final: null,
      blockTimestamp: E,
      owedWei: 0n,
      mainBalanceWei: 10n ** 18n,
      callCostWei: 1n,
    } as EvmHtlcObservation,
  }
  const recordAt = async () => {
    const row = await store.getRecord(swapIdHex)
    return row ? parseHtlcSwapRecord(row.raw) : undefined
  }
  const xec: XecHtlcCapability = {
    chainIdentifier: 'xec-regtest',
    htlcPublicKey: (_s, role) =>
      fromHex(role === 'refund' ? refundKey : claimKey),
    observe: async () => state.xec,
    lockOperation: async () => undefined,
    fund: async () => {
      const r = await recordAt()
      log.push(
        `fund (record authorized: ${r?.fundingAuthorizedAt !== undefined}, op ${
          r?.xecLockOperationId
        })`,
      )
      return { txid: 'ab'.repeat(32) }
    },
    releaseLock: async () => void log.push('release'),
    signSpend: async input => {
      log.push(`sign ${input.branch}`)
      return { rawTx: '0200', txid: 'cd'.repeat(32) }
    },
    broadcast: async raw => {
      const r = await recordAt()
      log.push(
        `broadcast ${raw} (record has it: ${r?.xecSpend?.rawTx === raw})`,
      )
    },
  }
  const evm: EvmHtlcCapability = {
    chainIdentifier: 'monad-regtest',
    mainAccount: () => '0x' + (local === 'A' ? 'aa' : 'bb').repeat(20),
    htlcContract: () => '0x' + 'cc'.repeat(20),
    observe: async () => state.evm,
    ownCalls: async () => [],
    lock: async () => {
      log.push('lock')
      return { operationId: 'op-lock' }
    },
    withdraw: async input => {
      log.push(
        `withdraw ${
          bytesToHex(input.preimage) ===
          bytesToHex(preimageOf(n.context.swapId))
        }`,
      )
      return { operationId: 'op-withdraw' }
    },
    refund: async () => {
      log.push('refund')
      return { operationId: 'op-refund' }
    },
    claimOwed: async () => void log.push('claimOwed'),
  }
  const asked: string[] = []
  const runner = new HtlcSwapRunner({
    owner: {
      accountIncarnation: 'acc-1',
      localPublicKey: new Uint8Array((local === 'A' ? a : b).compressedPubKey),
    },
    negotiations: { list: async () => [n] },
    store,
    xec,
    evm,
    secrets: {
      swapPreimage: ({ swapId }) => {
        asked.push(bytesToHex(swapId))
        return preimageOf(swapId)
      },
    },
    offerSwapId: overrides.offerSwapId ?? keyedHash,
    clock: { now: () => E },
    isActiveDevice: () => overrides.active ?? true,
  })
  return { runner, log, asked, state, store, recordAt }
}

describe('HtlcSwapRunner', () => {
  it('A writes the funding authorization before funding, automatically on the accept', async () => {
    const n = await negotiation()
    const h = harness(n, 'A')
    const [view] = await h.runner.tick()
    expect(view).toMatchObject({
      role: 'A',
      phase: 'accepted',
      lastAction: 'fund-xec',
    })
    expect(h.log).toEqual([
      `fund (record authorized: true, op swap:${bytesToHex(
        n.context.swapId,
      )}:xec-lock)`,
    ])
    expect(await h.recordAt()).toMatchObject({
      role: 'A',
      fundingAuthorizedAt: E,
    })
  })

  it('never asks for the secret of a swapId this account did not derive', async () => {
    const n = await negotiation()
    const h = harness(n, 'A', {
      offerSwapId: t => hmac(sha256, new Uint8Array(32), t),
    })
    const [view] = await h.runner.tick()
    expect(view).toMatchObject({
      role: null,
      phase: 'invalid',
      detail: expect.stringMatching(/swapId/),
    })
    expect(h.asked).toEqual([])
    expect(h.log).toEqual([])
    expect(await h.recordAt()).toBeUndefined()
  })

  it('A withdraws with its own preimage once B’s lock is final', async () => {
    const n = await negotiation()
    const h = harness(n, 'A')
    const terms = htlcSwapTermsOf(n)
    h.state.xec = {
      tipMedianTime: E,
      outputs: [
        {
          txid: 'ab'.repeat(32),
          vout: 0,
          valueSats: terms.xec.fundingValueSats,
          final: true,
        },
      ],
    }
    h.state.evm = {
      ...h.state.evm,
      latest: { state: 'open', preimage: null },
      final: { state: 'open', preimage: null },
    }
    const [view] = await h.runner.tick()
    expect(view).toMatchObject({
      phase: 'claiming',
      lastAction: 'withdraw-evm',
      lockId: terms.evm.lockId,
    })
    expect(h.log).toEqual(['withdraw true'])
    expect(h.asked.every(id => id === bytesToHex(n.context.swapId))).toBe(true)
  })

  it('B persists its signed claim before broadcasting it, and re-broadcasts the same bytes', async () => {
    const n = await negotiation()
    const h = harness(n, 'B')
    const terms = htlcSwapTermsOf(n)
    h.state.xec = {
      tipMedianTime: E,
      outputs: [
        {
          txid: 'ab'.repeat(32),
          vout: 0,
          valueSats: terms.xec.fundingValueSats,
          final: true,
        },
      ],
    }
    const preimage = preimageOf(n.context.swapId)
    h.state.evm = {
      ...h.state.evm,
      latest: { state: 'withdrawn', preimage },
      final: { state: 'withdrawn', preimage },
    }
    await h.runner.tick()
    await h.runner.tick()
    expect(h.log).toEqual([
      'sign claim',
      'broadcast 0200 (record has it: true)',
      'broadcast 0200 (record has it: true)',
    ])
    expect(h.asked).toEqual([])
  })

  it('refuses terms naming another contract or another main account, acting on nothing', async () => {
    const n = await negotiation()
    const options = (h: ReturnType<typeof harness>) =>
      (
        h.runner as unknown as {
          options: {
            evm: { htlcContract: () => string; mainAccount: () => string }
          }
        }
      ).options.evm
    const badContract = harness(n, 'B')
    options(badContract).htlcContract = () => '0x' + 'dd'.repeat(20)
    expect((await badContract.runner.tick())[0]).toMatchObject({
      phase: 'invalid',
      detail: expect.stringMatching(/contract/),
    })
    const badSender = harness(n, 'B')
    options(badSender).mainAccount = () => '0x' + 'ee'.repeat(20)
    expect((await badSender.runner.tick())[0]).toMatchObject({
      phase: 'invalid',
      detail: expect.stringMatching(/sender/),
    })
    expect([...badContract.log, ...badSender.log]).toEqual([])
  })

  it('an inactive device observes only', async () => {
    const n = await negotiation()
    const h = harness(n, 'A', { active: false })
    const [view] = await h.runner.tick()
    expect(view).toMatchObject({ phase: 'accepted' })
    expect(view!.lastAction).toBeUndefined()
    expect(h.log).toEqual([])
    expect(await h.recordAt()).toBeUndefined()
  })

  it('a record of other terms stops the swap', async () => {
    const n = await negotiation()
    const h = harness(n, 'A')
    await h.store.compareAndSwap(
      bytesToHex(n.context.swapId),
      0,
      JSON.stringify({
        version: 1,
        swapId: bytesToHex(n.context.swapId),
        conversationId: '22'.repeat(16),
        owner: {
          accountIncarnation: 'acc-1',
          localPublicKey: bytesToHex(a.compressedPubKey),
        },
        role: 'A',
        termsHash: '00'.repeat(32),
      }),
    )
    const [view] = await h.runner.tick()
    expect(view).toMatchObject({
      phase: 'invalid',
      detail: expect.stringMatching(/record/),
    })
    expect(h.log).toEqual([])
  })
})
