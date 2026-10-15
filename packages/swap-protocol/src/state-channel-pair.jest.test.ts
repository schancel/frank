import {
  canReleaseXecClaim,
  classifyObservedSettlement,
  earliestEvmRefund,
  initialPairState,
  reduceStateChannelPair,
  validateStateChannelPairTerms,
  type PairEvent,
  type PairPreparedPackage,
  type StateChannelPairTerms,
} from './state-channel-pair'
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const p = (n: number) => `0x02${n.toString(16).padStart(64, '0')}`
const terms: StateChannelPairTerms = {
  termsHash: h(1),
  channelId: h(2),
  xecChainIdentifier: 'xec-regtest',
  evmChainIdentifier: 'monad-regtest',
  evmNativeChainId: 20143n,
  xecCheckpoint: { height: 1n, hash: h(3) },
  evmCheckpoint: { height: 1n, hash: h(4) },
  contractAddress: a(5),
  runtimeHash: h(6),
  jointPublicKey: p(7),
  jointAddress: a(7),
  adaptorPoint: p(8),
  lockOwner: 'B',
  initiator: 'A',
  participants: [a(9), a(7)],
  balances: [100n, 0n],
  xecPrincipal: 99000n,
  xecClaimFee: 1000n,
  evmFeeBudget: 10000n,
  aPayout: a(10),
  aRefundPublicKey: p(11),
  bXecDestination: '76a914-test-owned-b',
  evmOpeningTimestamp: 500000000n,
  challengeDuration: 1000n,
  xecRefundTimestamp: 500000500n,
  xecRefundFinalBound: 500000700n,
  evmClaimResponseMargin: 100n,
  crossClockMargin: 50n,
  bClaimInclusionMargin: 30n,
  maxObserverAge: 10n,
  maxReorgDepth: 2n,
}
const identity: Parameters<typeof validateStateChannelPairTerms>[1] = (
  chain,
  checkpoint,
  custody,
) =>
  (chain === 'xec-regtest' &&
    checkpoint.hash === h(3) &&
    checkpoint.height === 1n) ||
  (chain === 'monad-regtest' &&
    checkpoint.hash === h(4) &&
    checkpoint.height === 1n &&
    custody?.address === a(5) &&
    custody.runtimeHash === h(6) &&
    custody.nativeChainId === 20143n)
const prepared: PairPreparedPackage = {
  termsHash: h(1),
  jointPublicKey: p(7),
  adaptorPoint: p(8),
  lockOwner: 'B',
  evmDigest: h(12),
  xecDigest: h(13),
  evmSessionId: h(14),
  xecSessionId: h(15),
  bSignatureStored: true,
  evmPresignatureStored: true,
  xecPresignatureStored: true,
  sequentialSessions: true,
  interrupted: false,
  keyBurned: false,
  independentRefundKeys: true,
  feesWithinEnvelope: true,
}
const now = 500000100n
type WithoutHash<T> = T extends unknown ? Omit<T, 'termsHash'> : never
const event = (e: WithoutHash<PairEvent>): PairEvent =>
  ({ ...e, termsHash: terms.termsHash } as PairEvent)
const apply = (
  s: ReturnType<typeof initialPairState>,
  e: PairEvent,
  t = terms,
) => reduceStateChannelPair(t, s, e, identity)
const funded = () => ({
  ...initialPairState(terms.termsHash),
  evmFundingFinal: true,
  xecFundingFinal: true,
  evmObservedAt: now,
  xecObservedAt: now,
})

it('admits safe independent-refund topology and anchors horizon to opening, not challenge observation', () => {
  expect(validateStateChannelPairTerms(terms, identity)).toEqual([])
  expect(earliestEvmRefund(terms)).toBe(500001000n)
  expect(canReleaseXecClaim(terms, funded(), prepared, now, identity)).toBe(
    true,
  )
  const challenged = apply(
    funded(),
    event({
      source: 'local-observer',
      kind: 'challenge',
      expiry: earliestEvmRefund(terms) + 500n,
    }),
  )
  expect(
    canReleaseXecClaim(terms, challenged, prepared, 500000900n, identity),
  ).toBe(false)
  expect(
    validateStateChannelPairTerms(
      { ...terms, challengeDuration: 850n },
      identity,
    ),
  ).toContain('unsafe-horizon')
  expect(
    validateStateChannelPairTerms(
      { ...terms, challengeDuration: 851n },
      identity,
    ),
  ).toEqual([])
  for (const patch of [
    { participants: [a(7), a(9)] as const },
    { balances: [0n, 100n] as const },
    { balances: [100n, 1n] as const },
    { aPayout: a(7) },
    { lockOwner: 'A' as 'B' },
  ])
    expect(
      validateStateChannelPairTerms({ ...terms, ...patch }, identity),
    ).toContain('custody-topology')
  expect(
    validateStateChannelPairTerms(
      { ...terms, evmNativeChainId: 143n },
      identity,
    ),
  ).toContain('chain-identity')
  expect(
    validateStateChannelPairTerms({ ...terms, runtimeHash: h(99) }, identity),
  ).toContain('chain-identity')
  expect(
    validateStateChannelPairTerms(
      { ...terms, xecCheckpoint: { height: 1n, hash: h(99) } },
      identity,
    ),
  ).toContain('chain-identity')
})
it('rejects incomplete, mismatched, interrupted or unsafe release before effects', () => {
  for (const patch of [
    { bSignatureStored: false },
    { evmPresignatureStored: false },
    { xecPresignatureStored: false },
    { sequentialSessions: false },
    { interrupted: true },
    { keyBurned: true },
    { independentRefundKeys: false },
    { feesWithinEnvelope: false },
    { jointPublicKey: p(99) },
    { adaptorPoint: p(99) },
    { termsHash: h(99) },
    { xecDigest: prepared.evmDigest },
    { xecSessionId: prepared.evmSessionId },
  ])
    expect(
      canReleaseXecClaim(
        terms,
        funded(),
        { ...prepared, ...patch },
        now,
        identity,
      ),
    ).toBe(false)
  expect(
    canReleaseXecClaim(
      terms,
      { ...funded(), evmFundingFinal: false },
      prepared,
      now,
      identity,
    ),
  ).toBe(false)
  expect(
    canReleaseXecClaim(terms, funded(), prepared, now + 11n, identity),
  ).toBe(false)
  expect(() =>
    apply(
      funded(),
      event({
        source: 'local-preparation',
        kind: 'completion-released',
        prepared: { ...prepared, xecPresignatureStored: false },
        now,
      }),
    ),
  ).toThrow('disclosure')
  const released = apply(
    funded(),
    event({
      source: 'local-preparation',
      kind: 'completion-released',
      prepared,
      now,
    }),
  )
  expect(released.completionReleased).toBe(true)
  expect(canReleaseXecClaim(terms, released, prepared, now, identity)).toBe(
    false,
  )
  expect(() =>
    apply(funded(), {
      source: 'peer',
      termsHash: terms.termsHash,
      kind: 'secret-observed',
    } as unknown as PairEvent),
  ).toThrow('peer assertion')
})
it('keeps secret knowledge through replaced/mempool/reorged claims and rolls back finality', () => {
  let state = apply(
    funded(),
    event({ source: 'local-observer', kind: 'secret-observed' }),
  )
  expect(state.secretKnown).toBe(true)
  expect(classifyObservedSettlement(state)).toBe('pending')
  for (const leg of ['xec', 'evm'] as const)
    state = apply(
      state,
      event({
        source: 'local-observer',
        kind: 'settlement',
        leg,
        effect: 'claim',
        final: true,
        revertedDepth: 0n,
      }),
    )
  expect(classifyObservedSettlement(state)).toBe('complete')
  state = apply(
    state,
    event({
      source: 'local-observer',
      kind: 'settlement',
      leg: 'xec',
      effect: 'none',
      final: false,
      revertedDepth: 2n,
    }),
  )
  expect(state.secretKnown).toBe(true)
  expect(classifyObservedSettlement(state)).toBe('partial')
  state = apply(
    state,
    event({
      source: 'local-observer',
      kind: 'settlement',
      leg: 'evm',
      effect: 'none',
      final: false,
      revertedDepth: 3n,
    }),
  )
  expect(state.secretKnown).toBe(true)
  expect(classifyObservedSettlement(state)).toBe('loss-or-envelope-violation')
})
it('retains the known theft counterexample when unsafe horizon admission is bypassed', () => {
  const unsafe = { ...terms, challengeDuration: 100n }
  expect(validateStateChannelPairTerms(unsafe, identity)).toContain(
    'unsafe-horizon',
  )
  expect(canReleaseXecClaim(unsafe, funded(), prepared, now, identity)).toBe(
    false,
  )
  // Negative control: success signature never expires. B refunds MON at open+D,
  // then discloses XEC success before an offline A has finalized its refund.
  let exploited = apply(
    funded(),
    event({
      source: 'local-observer',
      kind: 'settlement',
      leg: 'evm',
      effect: 'refund',
      final: true,
      revertedDepth: 0n,
    }),
    unsafe,
  )
  exploited = apply(
    exploited,
    event({ source: 'local-observer', kind: 'secret-observed' }),
    unsafe,
  )
  exploited = apply(
    exploited,
    event({
      source: 'local-observer',
      kind: 'settlement',
      leg: 'xec',
      effect: 'claim',
      final: true,
      revertedDepth: 0n,
    }),
    unsafe,
  )
  expect(classifyObservedSettlement(exploited)).toBe(
    'loss-or-envelope-violation',
  )
  expect(exploited.secretKnown).toBe(true)
})

it('rejects the joint key as XEC refund authority even when the preparation flag claims independence', () => {
  const joint = `0x02${'ab'.repeat(32)}`
  const forbidden = {
    ...terms,
    jointPublicKey: joint,
    aRefundPublicKey: `0x${joint.slice(2).toUpperCase()}`,
  }
  expect(validateStateChannelPairTerms(forbidden, identity)).toContain(
    'custody-topology',
  )
  expect(
    canReleaseXecClaim(
      forbidden,
      funded(),
      { ...prepared, jointPublicKey: joint, independentRefundKeys: true },
      now,
      identity,
    ),
  ).toBe(false)
})
it.each(['digest', 'session'] as const)(
  'compares %s identity by hex bytes, independent of letter case',
  kind => {
    const lower = h(0xabcdef)
    const upper = `0x${lower.slice(2).toUpperCase()}`
    const patch =
      kind === 'digest'
        ? { evmDigest: lower, xecDigest: upper }
        : { evmSessionId: lower, xecSessionId: upper }
    expect(
      canReleaseXecClaim(
        terms,
        funded(),
        { ...prepared, ...patch },
        now,
        identity,
      ),
    ).toBe(false)
  },
)
