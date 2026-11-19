import { sha256 } from '@noble/hashes/sha256.js'
import { hmac } from '@noble/hashes/hmac.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { MonadIdentity } from '../../wallet/evm-identity'
import { htlcLockId } from '../../wallet/swap-escrow'
import { encodeSignedSwapEvent, type SwapResult } from './index'
import {
  REGTEST_PROOF_NEGOTIATION_POLICY,
  TESTNET_NEGOTIATION_POLICY,
  buildNegotiationOffer,
  buildNegotiationResponse,
  deriveOfferSwapId,
  reduceNegotiationStandalone,
  type NegotiationContext,
  type OfferFields,
} from './negotiation'
import {
  fixtureAccept,
  fixtureOfferFields,
  FIXTURE_PREIMAGE,
} from './negotiation-fixtures.testutil'
import {
  HTLC_CALL_MAX_REVERTS,
  htlcLockIdOf,
  htlcSwapCutoffs,
  htlcSwapTermsOf,
  nextAction,
  parseHtlcSwapRecord,
  resolveHtlcSwapRole,
  serializeHtlcSwapRecord,
  type EvmHtlcObservation,
  type EvmHtlcOwnCall,
  type HtlcSwapDecision,
  type HtlcSwapObservations,
  type HtlcSwapRecord,
  type HtlcSwapRole,
  type HtlcSwapTerms,
  type XecHtlcObservation,
  type XecHtlcOutputObservation,
  type XecLockOperationState,
} from './htlc-swap'

const a = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}01`)
const b = MonadIdentity.fromPrivateKeyHex(`0x${'00'.repeat(31)}02`)
const sign = (id: MonadIdentity) => async (digest: Uint8Array) =>
  new Uint8Array(id.signHash(Buffer.from(digest)))
function must<T>(value: SwapResult<T>): T {
  if (!value.ok) throw new Error(JSON.stringify(value.error))
  return value.value
}
const salt = new Uint8Array(32).fill(0x5a)
const keyedHash = (transcript: Uint8Array) => hmac(sha256, salt, transcript)

const E = 2_000_000_000
const T_B = E + 120
const T_A = T_B + 120
const parties = [
  new Uint8Array(a.compressedPubKey),
  new Uint8Array(b.compressedPubKey),
] as const
const conversationId = new Uint8Array(16).fill(0x22)
const fields = (overrides: Partial<OfferFields> = {}) =>
  fixtureOfferFields({
    expiry: BigInt(E),
    evmExpiry: BigInt(T_B),
    xecRefundTime: BigInt(T_A),
    ...overrides,
  })
function contextFor(
  offer: OfferFields,
  policy = REGTEST_PROOF_NEGOTIATION_POLICY,
): NegotiationContext {
  const swapId = must(
    deriveOfferSwapId({ policy, conversationId, parties, ...offer }, keyedHash),
  )
  return { swapId, conversationId, parties, policy }
}

async function negotiate(decision: 'accept' | 'reject' | null = 'accept') {
  const offerFields = fields()
  const context = contextFor(offerFields)
  const offer = must(await buildNegotiationOffer(context, offerFields, sign(a)))
  const events = [must(encodeSignedSwapEvent(offer))]
  if (decision)
    events.push(
      must(
        encodeSignedSwapEvent(
          must(
            await buildNegotiationResponse(
              context,
              events[0]!,
              decision === 'accept' ? fixtureAccept() : { kind: 'reject' },
              sign(b),
            ),
          ),
        ),
      ),
    )
  return {
    context,
    reduction: must(reduceNegotiationStandalone(events, context)),
  }
}

let terms: HtlcSwapTerms
beforeAll(async () => {
  terms = htlcSwapTermsOf(await negotiate())
})

/** fixtureOfferFields' xecPrincipal (12345) + the fixed spend fee. */
const PRINCIPAL = 12345n
const FUNDING_VALUE = PRINCIPAL + 1000n
const FUNDING = { txid: 'ab'.repeat(32), vout: 1 }
const output = (
  overrides: Partial<XecHtlcOutputObservation> = {},
): XecHtlcOutputObservation => ({
  ...FUNDING,
  valueSats: FUNDING_VALUE,
  final: true,
  ...overrides,
})
const xecObs = (
  outputs: XecHtlcOutputObservation[] = [],
  tipMedianTime = E,
): XecHtlcObservation => ({ tipMedianTime, outputs })
const lockView = (
  state: 'open' | 'withdrawn' | 'refunded',
): EvmHtlcObservation['latest'] => ({
  state,
  preimage: state === 'withdrawn' ? new Uint8Array(FIXTURE_PREIMAGE) : null,
})
const evmObs = (
  overrides: Partial<EvmHtlcObservation> = {},
): EvmHtlcObservation => ({
  latest: null,
  final: null,
  blockTimestamp: E,
  owedWei: 0n,
  mainBalanceWei: 10n ** 18n,
  callCostWei: 10n ** 15n,
  ...overrides,
})
const both = (state: 'open' | 'withdrawn' | 'refunded') => ({
  latest: lockView(state),
  final: lockView(state),
})
const call = (
  action: EvmHtlcOwnCall['action'],
  state: EvmHtlcOwnCall['state'],
): EvmHtlcOwnCall => ({ action, state, operationId: `${action}-${state}` })

interface Case {
  readonly now?: number
  readonly xec?: XecHtlcObservation
  readonly evm?: Partial<EvmHtlcObservation>
  readonly op?: XecLockOperationState
  readonly calls?: EvmHtlcOwnCall[]
  readonly record?: Partial<HtlcSwapRecord>
  readonly active?: boolean
}
function run(role: HtlcSwapRole, c: Case): HtlcSwapDecision {
  const observations: HtlcSwapObservations = {
    xec: c.xec ?? xecObs(),
    evm: evmObs(c.evm),
    evmCalls: c.calls ?? [],
    ...(c.op ? { xecLockOperation: c.op } : {}),
  }
  const record = c.record
    ? ({
        version: 1,
        swapId: terms.swapId,
        conversationId: terms.conversationId,
        owner: { accountIncarnation: 'acc', localPublicKey: '02'.repeat(33) },
        role,
        termsHash: terms.termsHash,
        ...c.record,
      } as HtlcSwapRecord)
    : undefined
  return nextAction({
    role,
    now: c.now ?? E,
    activeDevice: c.active ?? true,
    ...(record ? { record } : {}),
    negotiation: 'accepted',
    terms,
    observations,
  })
}
const summary = (d: HtlcSwapDecision) =>
  `${d.phase}/${d.action.kind}${
    d.action.kind === 'sign-xec-spend' ? `:${d.action.branch}` : ''
  }${
    d.action.kind === 'fund-xec' ? `:${d.action.resume ? 'resume' : 'new'}` : ''
  }`

describe('cutoffs (regtest-proof margins, seconds)', () => {
  it('are T_B − (M_xec + S + W), T_B − evmLockMargin and T_B − M_evm', () => {
    expect(htlcSwapCutoffs(terms)).toEqual({
      xecFundBy: T_B - 40,
      evmLockBy: T_B - 20,
      evmWithdrawBy: T_B - 5,
    })
  })
  it('on testnet are T_B − 6 h, T_B − 2 h and T_B − 600 s', async () => {
    const offer = fixtureOfferFields()
    const context = contextFor(offer, TESTNET_NEGOTIATION_POLICY)
    const o = must(await buildNegotiationOffer(context, offer, sign(a)))
    const ob = must(encodeSignedSwapEvent(o))
    const r = must(
      encodeSignedSwapEvent(
        must(
          await buildNegotiationResponse(context, ob, fixtureAccept(), sign(b)),
        ),
      ),
    )
    const t = htlcSwapTermsOf({
      context,
      reduction: must(reduceNegotiationStandalone([ob, r], context)),
    })
    expect(htlcSwapCutoffs(t)).toEqual({
      xecFundBy: t.evmExpiry - 6 * 3600,
      evmLockBy: t.evmExpiry - 2 * 3600,
      evmWithdrawBy: t.evmExpiry - 600,
    })
  })
})

describe('terms from the signed negotiation', () => {
  it('give the GenericHTLC lock id the wallet computes (lockIdOf)', () => {
    expect(terms.evm.lockId).toBe(
      htlcLockId(terms.evm.sender, {
        ...terms.evm.terms,
        token: '0x' + '00'.repeat(20),
        expiresAt: BigInt(terms.evm.terms.expiresAt),
      }).toLowerCase(),
    )
    expect(terms.evm.sender).toBe('0x' + 'bb'.repeat(20))
    expect(terms.evm.terms).toEqual({
      recipient: '0x' + 'aa'.repeat(20),
      refundAddress: '0x' + 'bb'.repeat(20),
      amount: 1000000000000000001n,
      hashLock: '0x' + bytesToHex(sha256(FIXTURE_PREIMAGE)),
      expiresAt: T_B,
    })
    expect(terms.xec.fundingValueSats).toBe(FUNDING_VALUE)
    expect(terms.xec.terms.refundTime).toBe(T_A)
    expect(terms.evm.contract).toBe('0x' + 'cc'.repeat(20))
    // Pinned: keccak256 of the seven ABI words.
    expect(
      htlcLockIdOf('0x' + '11'.repeat(20), {
        recipient: '0x' + '22'.repeat(20),
        refundAddress: '0x' + '11'.repeat(20),
        amount: 5n,
        hashLock: '0x' + '33'.repeat(32),
        expiresAt: 1_800_000_000,
      }),
    ).toBe(
      htlcLockId('0x' + '11'.repeat(20), {
        recipient: '0x' + '22'.repeat(20),
        refundAddress: '0x' + '11'.repeat(20),
        token: '0x' + '00'.repeat(20),
        amount: 5n,
        hashLock: '0x' + '33'.repeat(32),
        expiresAt: 1_800_000_000n,
      }).toLowerCase(),
    )
  })

  it('refuse a negotiation that is not accepted', async () => {
    const rejected = await negotiate('reject')
    const offered = await negotiate(null)
    expect(() => htlcSwapTermsOf(rejected)).toThrow(/not accepted/)
    expect(() => htlcSwapTermsOf(offered)).toThrow(/not accepted/)
  })
})

describe('authorship (resolveHtlcSwapRole)', () => {
  it('party 0 is A only when the swapId re-derives under this account’s keyed hash', async () => {
    const { context, reduction } = await negotiate()
    const offer = reduction.history.offer!.terms
    expect(
      resolveHtlcSwapRole({
        context,
        offer,
        localPublicKey: parties[0],
        offerSwapId: keyedHash,
      }),
    ).toEqual({ role: 'A' })
    expect(
      resolveHtlcSwapRole({
        context,
        offer,
        localPublicKey: parties[1],
        offerSwapId: keyedHash,
      }),
    ).toEqual({ role: 'B' })
    // Another account's salt, or a swapId that is not derived from these facts: not A.
    const otherSalt = (t: Uint8Array) =>
      hmac(sha256, new Uint8Array(32).fill(1), t)
    expect(
      resolveHtlcSwapRole({
        context,
        offer,
        localPublicKey: parties[0],
        offerSwapId: otherSalt,
      }),
    ).toMatchObject({ role: null, reason: expect.stringMatching(/swapId/) })
    expect(
      resolveHtlcSwapRole({
        context: { ...context, swapId: new Uint8Array(32).fill(7) },
        offer,
        localPublicKey: parties[0],
        offerSwapId: keyedHash,
      }),
    ).toMatchObject({ role: null })
    expect(
      resolveHtlcSwapRole({
        context,
        offer,
        localPublicKey: new Uint8Array(33).fill(2),
        offerSwapId: keyedHash,
      }),
    ).toMatchObject({
      role: null,
      reason: expect.stringMatching(/not a party/),
    })
  })
})

describe('swap record v1', () => {
  const base: HtlcSwapRecord = {
    version: 1,
    swapId: '11'.repeat(32),
    conversationId: '22'.repeat(16),
    owner: {
      accountIncarnation: 'acc-1',
      localPublicKey: '02' + '33'.repeat(32),
    },
    role: 'A',
    termsHash: '44'.repeat(32),
  }
  it('round-trips in canonical key order', () => {
    const full: HtlcSwapRecord = {
      ...base,
      fundingAuthorizedAt: 5,
      xecLockOperationId: `swap:${'11'.repeat(32)}:xec-lock`,
      xecSpend: { branch: 'refund', rawTx: '0200', txid: '55'.repeat(32) },
    }
    const raw = serializeHtlcSwapRecord(full)
    expect(raw).toBe(
      `{"version":1,"swapId":"${'11'.repeat(
        32,
      )}","conversationId":"${'22'.repeat(
        16,
      )}","owner":{"accountIncarnation":"acc-1","localPublicKey":"02${'33'.repeat(
        32,
      )}"},"role":"A","termsHash":"${'44'.repeat(
        32,
      )}","fundingAuthorizedAt":5,"xecLockOperationId":"swap:${'11'.repeat(
        32,
      )}:xec-lock","xecSpend":{"branch":"refund","rawTx":"0200","txid":"${'55'.repeat(
        32,
      )}"}}`,
    )
    expect(parseHtlcSwapRecord(raw)).toEqual(full)
    expect(parseHtlcSwapRecord(serializeHtlcSwapRecord(base))).toEqual(base)
  })
  it('fails clearly on anything else (no compatibility reader)', () => {
    const bad = (value: unknown) => () =>
      parseHtlcSwapRecord(JSON.stringify(value))
    expect(bad({ ...base, version: 2 })).toThrow(/version/)
    expect(bad({ ...base, extra: 1 })).toThrow(/unknown field/)
    expect(bad({ ...base, swapId: 'AB'.repeat(32) })).toThrow(/swapId/)
    expect(bad({ ...base, role: 'C' })).toThrow(/role/)
    expect(bad({ ...base, xecLockOperationId: 'swap:x:xec-lock' })).toThrow(
      /xecLockOperationId/,
    )
    expect(
      bad({
        ...base,
        role: 'B',
        xecLockOperationId: `swap:${'11'.repeat(32)}:xec-lock`,
      }),
    ).toThrow(/xecLockOperationId/)
    // A refunds and B claims; never the other branch.
    expect(
      bad({
        ...base,
        xecSpend: { branch: 'claim', rawTx: '00', txid: '55'.repeat(32) },
      }),
    ).toThrow(/xecSpend/)
    expect(
      bad({ ...base, owner: { accountIncarnation: '', localPublicKey: '02' } }),
    ).toThrow(/owner/)
    expect(() => parseHtlcSwapRecord('{')).toThrow(/JSON/)
    // The retired v1 execution record is not a swap record.
    expect(() =>
      parseHtlcSwapRecord(
        JSON.stringify({ version: 1, revision: 0, phase: 'prepared' }),
      ),
    ).toThrow(/Invalid HTLC swap record/)
  })
})

describe('nextAction before an accept', () => {
  it('offered / offerReceived until E, then expired; rejected stays rejected', () => {
    for (const [role, phase] of [
      ['A', 'offered'],
      ['B', 'offerReceived'],
    ] as const) {
      expect(
        nextAction({
          role,
          now: E - 1,
          activeDevice: true,
          negotiation: 'offered',
          acceptBy: E,
        }).phase,
      ).toBe(phase)
      const expired = nextAction({
        role,
        now: E,
        activeDevice: true,
        negotiation: 'offered',
        acceptBy: E,
      })
      expect(`${expired.phase}/${expired.action.kind}`).toBe('expired/none')
      expect(
        nextAction({
          role,
          now: E,
          activeDevice: true,
          negotiation: 'rejected',
        }).phase,
      ).toBe('rejected')
    }
  })
})

describe('nextAction, A (offerer, XEC depositor, secret holder)', () => {
  const fundBy = T_B - 40
  const withdrawBy = T_B - 5
  const cases: [string, Case, string][] = [
    // Funding: automatic once the accept is there, only before the cutoff.
    ['accept arrives: funds automatically', {}, 'accepted/fund-xec:new'],
    ['funds at the cutoff exactly', { now: fundBy }, 'accepted/fund-xec:new'],
    [
      'past the funding cutoff: never funds',
      { now: fundBy + 1 },
      'abandoned/none',
    ],
    [
      'the EVM clock past the cutoff counts too',
      { evm: { blockTimestamp: fundBy + 1 } },
      'abandoned/none',
    ],
    [
      'authorized but nothing prepared yet (crash): funds',
      { record: { fundingAuthorizedAt: E } },
      'xecLockPending/fund-xec:new',
    ],
    [
      'prepared, before the cutoff: resumes',
      { op: 'prepared' },
      'xecLockPending/fund-xec:new',
    ],
    [
      'prepared, never exposed, past the cutoff: releases',
      { op: 'prepared', now: fundBy + 1 },
      'abandoned/release-xec-lock',
    ],
    [
      'exposed: re-submits the same bytes, even past the cutoff',
      { op: 'exposed', now: fundBy + 1 },
      'xecLockPending/fund-xec:resume',
    ],
    [
      'submitted: re-submits',
      { op: 'submitted' },
      'xecLockPending/fund-xec:resume',
    ],
    ['released: never funds again', { op: 'released' }, 'abandoned/none'],
    [
      'a foreign output at the script: does not fund',
      { xec: xecObs([output({ valueSats: 999n })]) },
      'accepted/none',
    ],
    // Locked, waiting for B.
    [
      'funding not final yet',
      { xec: xecObs([output({ final: false })]) },
      'xecLockPending/none',
    ],
    [
      'funding final, no MON lock',
      { xec: xecObs([output()]) },
      'xecLocked/none',
    ],
    [
      'MON lock seen but not final',
      { xec: xecObs([output()]), evm: { latest: lockView('open') } },
      'xecLocked/none',
    ],
    // Withdraw.
    [
      'MON lock final: withdraws',
      { xec: xecObs([output()]), evm: both('open') },
      'claiming/withdraw-evm',
    ],
    [
      'withdraws at T_B − M_evm exactly',
      { now: withdrawBy, xec: xecObs([output()]), evm: both('open') },
      'claiming/withdraw-evm',
    ],
    [
      'one second later: never withdraws',
      { now: withdrawBy + 1, xec: xecObs([output()]), evm: both('open') },
      'awaitRefund/none',
    ],
    [
      'withdraw pending: waits',
      {
        xec: xecObs([output()]),
        evm: both('open'),
        calls: [call('withdraw', 'pending')],
      },
      'claiming/none',
    ],
    [
      'withdraw reverted once: tries again',
      {
        xec: xecObs([output()]),
        evm: both('open'),
        calls: [call('withdraw', 'reverted')],
      },
      'claiming/withdraw-evm',
    ],
    [
      `withdraw reverted ${HTLC_CALL_MAX_REVERTS} times: stops`,
      {
        xec: xecObs([output()]),
        evm: both('open'),
        calls: [call('withdraw', 'reverted'), call('withdraw', 'reverted')],
      },
      'xecLocked/none',
    ],
    [
      'withdraw landed: claimed',
      { xec: xecObs([output()]), evm: both('withdrawn') },
      'claimed/none',
    ],
    [
      'withdraw landed: never refunds, even after T_A',
      {
        xec: xecObs([output()], T_A + 1000),
        evm: { ...both('withdrawn'), blockTimestamp: T_A + 1000 },
      },
      'claimed/none',
    ],
    [
      'B already claimed with the preimage: claimed',
      {
        xec: xecObs([
          output({
            spentBy: { txid: 'cd'.repeat(32), branch: 'claim', final: true },
          }),
        ]),
        evm: both('withdrawn'),
      },
      'claimed/none',
    ],
    [
      'B claimed but A’s withdraw has not landed: withdraws',
      {
        xec: xecObs([
          output({
            spentBy: { txid: 'cd'.repeat(32), branch: 'claim', final: false },
          }),
        ]),
        evm: both('open'),
      },
      'claimedByPeer/withdraw-evm',
    ],
    // Refund.
    [
      'B refunded, MTP ≤ T_A: waits',
      { xec: xecObs([output()], T_A), evm: both('refunded') },
      'awaitRefund/none',
    ],
    [
      'MTP = T_A: still waits',
      {
        now: T_A + 50,
        xec: xecObs([output()], T_A),
        evm: { ...both('refunded'), blockTimestamp: T_A + 50 },
      },
      'awaitRefund/none',
    ],
    [
      'MTP > T_A, unspent: signs the refund',
      { xec: xecObs([output()], T_A + 1), evm: both('refunded') },
      'refunding/sign-xec-spend:refund',
    ],
    [
      'B never locked, MTP > T_A: refunds',
      {
        xec: xecObs([output()], T_A + 1),
        now: T_A + 1,
        evm: { blockTimestamp: T_A + 1 },
      },
      'refunding/sign-xec-spend:refund',
    ],
    [
      'refund already signed: re-broadcasts the same bytes',
      {
        xec: xecObs([output()], T_A + 1),
        evm: both('refunded'),
        record: {
          xecSpend: { branch: 'refund', rawTx: '00', txid: 'ee'.repeat(32) },
        },
      },
      'refunding/broadcast-xec-spend',
    ],
    [
      'withdraw in flight before T_B: never refunds',
      {
        xec: xecObs([output()], T_A + 1),
        evm: { ...both('open'), blockTimestamp: T_B - 1 },
        now: T_B - 1,
        calls: [call('withdraw', 'pending')],
      },
      'claiming/none',
    ],
    [
      'withdraw in flight past T_B cannot land: refunds',
      {
        xec: xecObs([output()], T_A + 1),
        evm: { ...both('open'), blockTimestamp: T_B },
        now: T_A + 1,
        calls: [call('withdraw', 'pending')],
      },
      'refunding/sign-xec-spend:refund',
    ],
    [
      'refund spent, not final',
      {
        xec: xecObs(
          [
            output({
              spentBy: {
                txid: 'ee'.repeat(32),
                branch: 'refund',
                final: false,
              },
            }),
          ],
          T_A + 1,
        ),
      },
      'refunding/none',
    ],
    [
      'refund final',
      {
        xec: xecObs(
          [
            output({
              spentBy: { txid: 'ee'.repeat(32), branch: 'refund', final: true },
            }),
          ],
          T_A + 1,
        ),
      },
      'refunded/none',
    ],
    // Owed.
    [
      'owed after the withdraw: claims it',
      { xec: xecObs([output()]), evm: { ...both('withdrawn'), owedWei: 7n } },
      'claimed/claim-owed',
    ],
    // Another device of the account observes only.
    ['inactive device: never funds', { active: false }, 'accepted/none'],
    [
      'inactive device: never withdraws',
      { active: false, xec: xecObs([output()]), evm: both('open') },
      'claiming/none',
    ],
  ]
  it.each(cases)('%s', (_, c, expected) => {
    expect(summary(run('A', c))).toBe(expected)
  })

  it('warns when the main account cannot pay the withdraw gas, and on a double funding', () => {
    expect(run('A', { evm: { mainBalanceWei: 1n } }).warnings).toEqual([
      'claim-gas-low',
    ])
    expect(
      run('A', { xec: xecObs([output(), output({ txid: 'ac'.repeat(32) })]) })
        .warnings,
    ).toEqual(['xec-double-funded'])
    expect(
      run('A', { xec: xecObs([output({ valueSats: 1n })]) }).warnings,
    ).toEqual(['xec-foreign-output'])
  })

  it('names the funding output; the unspent exact one first', () => {
    const d = run('A', {
      xec: xecObs(
        [
          output({
            txid: '01'.repeat(32),
            spentBy: { txid: 'ff'.repeat(32), branch: 'refund', final: true },
          }),
          output({ txid: '02'.repeat(32) }),
        ],
        T_A + 1,
      ),
    })
    expect(d.funding).toEqual({ txid: '02'.repeat(32), vout: 1 })
    expect(d.action).toMatchObject({
      kind: 'sign-xec-spend',
      funding: { txid: '02'.repeat(32), vout: 1 },
    })
  })
})

describe('nextAction, B (MON depositor)', () => {
  const lockBy = T_B - 20
  const withdrawn = both('withdrawn')
  const cases: [string, Case, string][] = [
    ['no XEC lock yet', {}, 'awaitXecLock/none'],
    [
      'XEC lock not final',
      { xec: xecObs([output({ final: false })]) },
      'awaitXecLock/none',
    ],
    [
      'XEC lock of the wrong value',
      { xec: xecObs([output({ valueSats: PRINCIPAL })]) },
      'awaitXecLock/none',
    ],
    [
      'XEC lock already spent',
      {
        xec: xecObs([
          output({
            spentBy: { txid: 'ee'.repeat(32), branch: 'refund', final: false },
          }),
        ]),
      },
      'awaitXecLock/none',
    ],
    [
      'XEC lock final: locks MON',
      { xec: xecObs([output()]) },
      'locking/lock-evm',
    ],
    [
      'locks at T_B − 2W exactly',
      { now: lockBy, xec: xecObs([output()]) },
      'locking/lock-evm',
    ],
    [
      'one second later: abandons',
      { now: lockBy + 1, xec: xecObs([output()]) },
      'abandoned/none',
    ],
    [
      'the EVM clock past the cutoff counts too',
      { evm: { blockTimestamp: lockBy + 1 }, xec: xecObs([output()]) },
      'abandoned/none',
    ],
    [
      'lock pending: waits, even past the cutoff',
      {
        now: lockBy + 1,
        xec: xecObs([output()]),
        calls: [call('lock', 'pending')],
      },
      'locking/none',
    ],
    [
      'lock landed, node lagging',
      { xec: xecObs([output()]), calls: [call('lock', 'landed')] },
      'locking/none',
    ],
    [
      'lock reverted once: tries again',
      { xec: xecObs([output()]), calls: [call('lock', 'reverted')] },
      'locking/lock-evm',
    ],
    [
      `lock reverted ${HTLC_CALL_MAX_REVERTS} times: stops`,
      {
        xec: xecObs([output()]),
        calls: [call('lock', 'reverted'), call('lock', 'reverted')],
      },
      'awaitXecLock/none',
    ],
    [
      'locked, before T_B',
      { xec: xecObs([output()]), evm: both('open') },
      'evmLocked/none',
    ],
    [
      'locked, local clock past T_B but block.timestamp not: waits',
      {
        now: T_B + 10,
        xec: xecObs([output()]),
        evm: { ...both('open'), blockTimestamp: T_B - 1 },
      },
      'evmLocked/none',
    ],
    [
      'block.timestamp = T_B, lock open: refunds',
      {
        xec: xecObs([output()]),
        evm: { ...both('open'), blockTimestamp: T_B },
      },
      'refunding/refund-evm',
    ],
    [
      'refund pending: waits',
      {
        xec: xecObs([output()]),
        evm: { ...both('open'), blockTimestamp: T_B },
        calls: [call('refund', 'pending')],
      },
      'refunding/none',
    ],
    ['refunded', { evm: both('refunded') }, 'refunded/none'],
    [
      'refunded with a deferred payout: claims it',
      { evm: { ...both('refunded'), owedWei: 1n } },
      'refunded/claim-owed',
    ],
    [
      'A withdrew: claims the XEC with the revealed preimage',
      { xec: xecObs([output()]), evm: withdrawn },
      'claimingXec/sign-xec-spend:claim',
    ],
    [
      'A withdrew, even after T_A while unspent',
      {
        xec: xecObs([output()], T_A + 100),
        evm: { ...withdrawn, blockTimestamp: T_A + 100 },
        now: T_A + 100,
      },
      'claimingXec/sign-xec-spend:claim',
    ],
    [
      'claim signed: re-broadcasts',
      {
        xec: xecObs([output()]),
        evm: withdrawn,
        record: {
          xecSpend: { branch: 'claim', rawTx: '00', txid: 'dd'.repeat(32) },
        },
      },
      'claimingXec/broadcast-xec-spend',
    ],
    [
      'claim spent, not final',
      {
        xec: xecObs([
          output({
            spentBy: { txid: 'dd'.repeat(32), branch: 'claim', final: false },
          }),
        ]),
        evm: withdrawn,
      },
      'claimingXec/none',
    ],
    [
      'claim final: complete',
      {
        xec: xecObs([
          output({
            spentBy: { txid: 'dd'.repeat(32), branch: 'claim', final: true },
          }),
        ]),
        evm: withdrawn,
      },
      'complete/none',
    ],
    [
      'A refunded first: lost to refund',
      {
        xec: xecObs(
          [
            output({
              spentBy: { txid: 'ee'.repeat(32), branch: 'refund', final: true },
            }),
          ],
          T_A + 1,
        ),
        evm: withdrawn,
      },
      'lostToRefund/none',
    ],
    [
      'inactive device: never locks',
      { active: false, xec: xecObs([output()]) },
      'locking/none',
    ],
    [
      'inactive device: never claims',
      { active: false, xec: xecObs([output()]), evm: withdrawn },
      'claimingXec/none',
    ],
  ]
  it.each(cases)('%s', (_, c, expected) => {
    expect(summary(run('B', c))).toBe(expected)
  })

  it('the claim carries the preimage read from the EVM lock', () => {
    const d = run('B', { xec: xecObs([output()]), evm: withdrawn })
    expect(d.action).toMatchObject({
      kind: 'sign-xec-spend',
      branch: 'claim',
      funding: FUNDING,
      preimage: new Uint8Array(FIXTURE_PREIMAGE),
    })
  })
})
