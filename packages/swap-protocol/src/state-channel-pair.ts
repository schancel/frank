/** Experimental B0 policy only. It neither verifies RPC responses nor authorizes wallet effects. */
export interface PairCheckpoint {
  readonly height: bigint
  readonly hash: string
}
export interface StateChannelPairTerms {
  readonly termsHash: string
  readonly channelId: string
  readonly xecChainIdentifier: 'xec-regtest'
  readonly evmChainIdentifier: 'monad-regtest'
  readonly evmNativeChainId: bigint
  readonly xecCheckpoint: PairCheckpoint
  readonly evmCheckpoint: PairCheckpoint
  readonly contractAddress: string
  readonly runtimeHash: string
  readonly jointPublicKey: string
  readonly jointAddress: string
  readonly adaptorPoint: string
  readonly lockOwner: 'B'
  readonly initiator: 'A'
  readonly participants: readonly [string, string]
  readonly balances: readonly [bigint, bigint]
  readonly xecPrincipal: bigint
  readonly xecClaimFee: bigint
  readonly evmFeeBudget: bigint
  readonly aPayout: string
  readonly aRefundPublicKey: string
  readonly bXecDestination: string
  readonly evmOpeningTimestamp: bigint
  readonly challengeDuration: bigint
  readonly xecRefundTimestamp: bigint
  /** Includes CLTV/MTP lag, watcher downtime, refund inclusion and reorg/finality envelope. */
  readonly xecRefundFinalBound: bigint
  readonly evmClaimResponseMargin: bigint
  readonly crossClockMargin: bigint
  readonly bClaimInclusionMargin: bigint
  readonly maxObserverAge: bigint
  readonly maxReorgDepth: bigint
}

export const earliestEvmRefund = (terms: StateChannelPairTerms): bigint =>
  terms.evmOpeningTimestamp + terms.challengeDuration
const hex32 = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value)
const address = (value: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value)
const pubkey = (value: string) => /^0x0[23][0-9a-fA-F]{64}$/.test(value)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Identity validation is supplied by the protocol registry/verified checkpoint boundary. */
export function validateStateChannelPairTerms(
  terms: StateChannelPairTerms,
  identity: (
    chainIdentifier: string,
    checkpoint: PairCheckpoint,
    custody?: {
      readonly address: string
      readonly runtimeHash: string
      readonly nativeChainId: bigint
    }
  ) => boolean
): readonly string[] {
  const errors: string[] = []
  if (
    terms.xecChainIdentifier !== 'xec-regtest' ||
    terms.evmChainIdentifier !== 'monad-regtest' ||
    !identity(terms.xecChainIdentifier, terms.xecCheckpoint) ||
    !identity(terms.evmChainIdentifier, terms.evmCheckpoint, {
      address: terms.contractAddress,
      runtimeHash: terms.runtimeHash,
      nativeChainId: terms.evmNativeChainId,
    })
  )
    errors.push('chain-identity')
  if (
    ![terms.termsHash, terms.channelId, terms.runtimeHash].every(hex32) ||
    ![
      terms.contractAddress,
      terms.jointAddress,
      terms.participants[0],
      terms.participants[1],
      terms.aPayout,
    ].every(address) ||
    ![terms.jointPublicKey, terms.adaptorPoint, terms.aRefundPublicKey].every(
      pubkey
    ) ||
    !terms.bXecDestination
  )
    errors.push('binding-shape')
  if (
    terms.lockOwner !== 'B' ||
    terms.initiator !== 'A' ||
    !same(terms.participants[1], terms.jointAddress) ||
    same(terms.participants[0], terms.jointAddress) ||
    same(terms.aPayout, terms.jointAddress) ||
    terms.balances[0] <= 0n ||
    terms.xecPrincipal <= 0n ||
    terms.xecClaimFee <= 0n ||
    terms.evmFeeBudget <= 0n ||
    terms.balances[1] !== 0n
  )
    errors.push('custody-topology')
  if (
    terms.evmOpeningTimestamp < 0n ||
    terms.challengeDuration <= 0n ||
    terms.xecRefundTimestamp < 500000000n ||
    terms.xecRefundFinalBound < terms.xecRefundTimestamp ||
    terms.evmClaimResponseMargin <= 0n ||
    terms.crossClockMargin < 0n ||
    terms.bClaimInclusionMargin <= 0n ||
    terms.maxObserverAge <= 0n ||
    terms.maxReorgDepth < 0n ||
    earliestEvmRefund(terms) <=
      terms.xecRefundFinalBound +
        terms.evmClaimResponseMargin +
        terms.crossClockMargin
  )
    errors.push('unsafe-horizon')
  return errors
}

export interface PairPreparedPackage {
  readonly termsHash: string
  readonly jointPublicKey: string
  readonly adaptorPoint: string
  readonly lockOwner: 'B'
  readonly evmDigest: string
  readonly xecDigest: string
  readonly evmSessionId: string
  readonly xecSessionId: string
  readonly bSignatureStored: boolean
  readonly evmPresignatureStored: boolean
  readonly xecPresignatureStored: boolean
  readonly sequentialSessions: boolean
  readonly interrupted: boolean
  readonly keyBurned: boolean
  readonly independentRefundKeys: boolean
  readonly feesWithinEnvelope: boolean
}
export type LegEffect = 'none' | 'claim' | 'refund'
export interface PairState {
  readonly termsHash: string
  readonly evmFundingFinal: boolean
  readonly xecFundingFinal: boolean
  readonly evmObservedAt: bigint | null
  readonly xecObservedAt: bigint | null
  readonly observedChallengeExpiry: bigint | null
  readonly completionReleased: boolean
  readonly secretKnown: boolean
  readonly evmEffect: LegEffect
  readonly xecEffect: LegEffect
  readonly evmEffectFinal: boolean
  readonly xecEffectFinal: boolean
  readonly recoveryRequired: boolean
  readonly envelopeViolated: boolean
}
export function initialPairState(termsHash: string): PairState {
  return {
    termsHash,
    evmFundingFinal: false,
    xecFundingFinal: false,
    evmObservedAt: null,
    xecObservedAt: null,
    observedChallengeExpiry: null,
    completionReleased: false,
    secretKnown: false,
    evmEffect: 'none',
    xecEffect: 'none',
    evmEffectFinal: false,
    xecEffectFinal: false,
    recoveryRequired: false,
    envelopeViolated: false,
  }
}

/** These are locally validated observer facts, never authenticated peer assertions. */
export type PairEvent =
  | {
      readonly source: 'local-observer'
      readonly termsHash: string
      readonly kind: 'funding'
      readonly leg: 'xec' | 'evm'
      readonly final: boolean
      readonly observedAt: bigint
    }
  | {
      readonly source: 'local-observer'
      readonly termsHash: string
      readonly kind: 'challenge'
      readonly expiry: bigint
    }
  | {
      readonly source: 'local-observer'
      readonly termsHash: string
      readonly kind: 'secret-observed'
    }
  | {
      readonly source: 'local-observer'
      readonly termsHash: string
      readonly kind: 'settlement'
      readonly leg: 'xec' | 'evm'
      readonly effect: LegEffect
      readonly final: boolean
      readonly revertedDepth: bigint
    }
  | {
      readonly source: 'local-preparation'
      readonly termsHash: string
      readonly kind: 'completion-released'
      readonly prepared: PairPreparedPackage
      readonly now: bigint
    }

export function canReleaseXecClaim(
  terms: StateChannelPairTerms,
  state: PairState,
  prepared: PairPreparedPackage,
  now: bigint,
  identity: Parameters<typeof validateStateChannelPairTerms>[1]
): boolean {
  if (
    validateStateChannelPairTerms(terms, identity).length ||
    state.termsHash !== terms.termsHash ||
    prepared.termsHash !== terms.termsHash ||
    !same(prepared.jointPublicKey, terms.jointPublicKey) ||
    !same(prepared.adaptorPoint, terms.adaptorPoint) ||
    prepared.lockOwner !== 'B'
  )
    return false
  if (
    ![
      prepared.evmDigest,
      prepared.xecDigest,
      prepared.evmSessionId,
      prepared.xecSessionId,
    ].every(hex32) ||
    prepared.evmDigest === prepared.xecDigest ||
    prepared.evmSessionId === prepared.xecSessionId ||
    !prepared.bSignatureStored ||
    !prepared.evmPresignatureStored ||
    !prepared.xecPresignatureStored ||
    !prepared.sequentialSessions ||
    prepared.interrupted ||
    prepared.keyBurned ||
    !prepared.independentRefundKeys ||
    !prepared.feesWithinEnvelope
  )
    return false
  if (
    !state.evmFundingFinal ||
    !state.xecFundingFinal ||
    state.evmObservedAt === null ||
    state.xecObservedAt === null ||
    now < state.evmObservedAt ||
    now < state.xecObservedAt ||
    now - state.evmObservedAt > terms.maxObserverAge ||
    now - state.xecObservedAt > terms.maxObserverAge ||
    state.envelopeViolated ||
    state.recoveryRequired ||
    state.completionReleased ||
    state.evmEffect !== 'none' ||
    state.xecEffect !== 'none'
  )
    return false
  const expiry =
    state.observedChallengeExpiry === null
      ? earliestEvmRefund(terms)
      : state.observedChallengeExpiry < earliestEvmRefund(terms)
      ? state.observedChallengeExpiry
      : earliestEvmRefund(terms)
  return (
    now + terms.bClaimInclusionMargin < terms.xecRefundTimestamp &&
    now + terms.evmClaimResponseMargin + terms.crossClockMargin < expiry
  )
}

export function reduceStateChannelPair(
  terms: StateChannelPairTerms,
  state: PairState,
  event: PairEvent,
  identity: Parameters<typeof validateStateChannelPairTerms>[1]
): PairState {
  if (
    event.termsHash !== terms.termsHash ||
    state.termsHash !== terms.termsHash
  )
    throw new Error('terms mismatch')
  if (event.kind === 'completion-released') {
    if (
      event.source !== 'local-preparation' ||
      !canReleaseXecClaim(terms, state, event.prepared, event.now, identity)
    )
      throw new Error('disclosure not authorized')
    return { ...state, completionReleased: true }
  }
  if (event.source !== 'local-observer')
    throw new Error('peer assertion is not chain evidence')
  switch (event.kind) {
    case 'secret-observed':
      return { ...state, secretKnown: true, recoveryRequired: true }
    case 'funding':
      return event.leg === 'evm'
        ? {
            ...state,
            evmFundingFinal: event.final,
            evmObservedAt: event.observedAt,
            recoveryRequired:
              state.recoveryRequired ||
              (!event.final && state.completionReleased),
          }
        : {
            ...state,
            xecFundingFinal: event.final,
            xecObservedAt: event.observedAt,
            recoveryRequired:
              state.recoveryRequired ||
              (!event.final && state.completionReleased),
          }
    case 'challenge':
      return { ...state, observedChallengeExpiry: event.expiry }
    case 'settlement': {
      if (event.revertedDepth < 0n) throw new Error('invalid reorg depth')
      const violated =
        state.envelopeViolated || event.revertedDepth > terms.maxReorgDepth
      const recoveryRequired =
        state.recoveryRequired || !event.final || violated
      return event.leg === 'evm'
        ? {
            ...state,
            evmEffect: event.effect,
            evmEffectFinal: event.final,
            recoveryRequired,
            envelopeViolated: violated,
          }
        : {
            ...state,
            xecEffect: event.effect,
            xecEffectFinal: event.final,
            recoveryRequired,
            envelopeViolated: violated,
          }
    }
    default:
      throw new Error('unsupported pair event')
  }
}
export function classifyObservedSettlement(
  state: PairState
):
  | 'pending'
  | 'complete'
  | 'refunded'
  | 'partial'
  | 'loss-or-envelope-violation' {
  if (
    state.envelopeViolated ||
    (state.evmEffect === 'refund' && state.xecEffect === 'claim') ||
    (state.evmEffect === 'claim' && state.xecEffect === 'refund')
  )
    return 'loss-or-envelope-violation'
  if (state.evmEffectFinal && state.xecEffectFinal) {
    if (state.evmEffect === 'claim' && state.xecEffect === 'claim')
      return 'complete'
    if (state.evmEffect === 'refund' && state.xecEffect === 'refund')
      return 'refunded'
  }
  return state.evmEffectFinal || state.xecEffectFinal ? 'partial' : 'pending'
}
