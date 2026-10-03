import type { SwapResult } from './index'

export type Stage0CustodyMode =
  | 'adaptor'
  | 'hashlock-or-program'
  | 'native-atomic'

export type Stage0Phase =
  | 'negotiation'
  | 'preparation'
  | 'ready-to-fund'
  | 'funding'
  | 'ready-to-settle'
  | 'settling'
  | 'recovery'
  | 'outcome'

export type Stage0Outcome =
  | 'complete'
  | 'refunded'
  | 'failed-before-funding'
  | 'cooperative-recovery-required'
  | 'permanently-locked-by-design'
  | 'manual-recovery-required'
  | 'loss-or-protocol-violation'

export type Stage0ReadinessStep =
  | { readonly kind: 'funding-active-final'; readonly legId: string }
  | { readonly kind: 'artifact-reveal-validated'; readonly revealId: string }

export interface Stage0RecoveryPlan {
  readonly role: number
  readonly action: 'claim' | 'refund' | 'salvage'
}

export interface Stage0Plan {
  readonly roles: readonly [number, number]
  readonly initiatorRole: number
  readonly fundingConsentRoles: readonly number[]
  /** Exact pair-specific readiness order; later facts are rejected rather than buffered here. */
  readonly readinessOrder: readonly Stage0ReadinessStep[]
  readonly custodyMode: Stage0CustodyMode
  /** Stage 0 models the promised recovery shape; chain plugins must prove it in later stages. */
  readonly recoveryMode: 'recoverable' | 'griefable'
  readonly recoveryPlans: readonly Stage0RecoveryPlan[]
}

export interface Stage0State {
  readonly phase: Stage0Phase
  readonly outcome: Stage0Outcome | null
  readonly offerRole: number | null
  readonly acceptRole: number | null
  readonly keyExchangeRoles: readonly number[]
  readonly transactionCommitmentRoles: readonly number[]
  readonly encryptedSignatureRoles: readonly number[]
  readonly authorizationAttestationRoles: readonly number[]
  readonly fundingConsentRoles: readonly number[]
  readonly readyToFundRoles: readonly number[]
  readonly fundingAuthorizationRoles: readonly number[]
  readonly activeFinalFundingLegIds: readonly string[]
  readonly validatedRevealIds: readonly string[]
  readonly settlementFacts: readonly string[]
}

export type Stage0Action =
  | { readonly kind: 'offer'; readonly role: number }
  | { readonly kind: 'accept'; readonly role: number }
  | { readonly kind: 'key-exchange'; readonly role: number }
  | { readonly kind: 'transaction-commitments'; readonly role: number }
  | { readonly kind: 'encrypted-signatures'; readonly role: number }
  | {
      readonly kind: 'prefunding-authorization-attestation'
      readonly role: number
    }
  | { readonly kind: 'pair-specific-funding-consent'; readonly role: number }
  | { readonly kind: 'ready-to-fund'; readonly role: number }
  | { readonly kind: 'funding-authorization-released'; readonly role: number }
  | { readonly kind: 'funding-active-final'; readonly legId: string }
  | { readonly kind: 'artifact-reveal-validated'; readonly revealId: string }
  | { readonly kind: 'first-leg-settlement-evidence' }
  | { readonly kind: 'extracted-adaptor-secret' }
  | { readonly kind: 'revealed-preimage-evidence' }
  | { readonly kind: 'counter-leg-settlement-evidence' }
  | { readonly kind: 'atomic-settlement-evidence' }
  | { readonly kind: 'cancel'; readonly role: number }
  | { readonly kind: 'enter-recovery'; readonly role: number }
  | {
      readonly kind: 'recovery-outcome'
      readonly outcome: Exclude<
        Stage0Outcome,
        'complete' | 'failed-before-funding'
      >
    }

const EMPTY_STATE: Stage0State = Object.freeze({
  phase: 'negotiation',
  outcome: null,
  offerRole: null,
  acceptRole: null,
  keyExchangeRoles: Object.freeze([]),
  transactionCommitmentRoles: Object.freeze([]),
  encryptedSignatureRoles: Object.freeze([]),
  authorizationAttestationRoles: Object.freeze([]),
  fundingConsentRoles: Object.freeze([]),
  readyToFundRoles: Object.freeze([]),
  fundingAuthorizationRoles: Object.freeze([]),
  activeFinalFundingLegIds: Object.freeze([]),
  validatedRevealIds: Object.freeze([]),
  settlementFacts: Object.freeze([]),
})

function fail(detail: string): SwapResult<Stage0State> {
  return { ok: false, error: { code: 'transition-rejected', detail } }
}

function uniqueSorted<T extends number | string>(
  values: readonly T[],
  value: T,
): readonly T[] {
  if (values.includes(value)) return values
  return [...values, value].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
}

function containsAll<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return expected.every(value => actual.includes(value))
}

function validRole(plan: Stage0Plan, role: number): boolean {
  return plan.roles.includes(role)
}

function peerRole(plan: Stage0Plan): number {
  return plan.roles[0] === plan.initiatorRole ? plan.roles[1] : plan.roles[0]
}

function preparedThrough(
  state: Stage0State,
  plan: Stage0Plan,
  step:
    | 'accepted'
    | 'keys'
    | 'transactions'
    | 'signatures'
    | 'attestations'
    | 'consents',
): boolean {
  if (
    state.offerRole !== plan.initiatorRole ||
    state.acceptRole !== peerRole(plan)
  ) {
    return false
  }
  if (step === 'accepted') return true
  if (!containsAll(state.keyExchangeRoles, plan.roles)) return false
  if (step === 'keys') return true
  if (!containsAll(state.transactionCommitmentRoles, plan.roles)) return false
  if (step === 'transactions') return true
  if (!containsAll(state.encryptedSignatureRoles, plan.roles)) return false
  if (step === 'signatures') return true
  if (!containsAll(state.authorizationAttestationRoles, plan.roles))
    return false
  if (step === 'attestations') return true
  return containsAll(state.fundingConsentRoles, plan.fundingConsentRoles)
}

function sameReadinessStep(
  left: Stage0ReadinessStep,
  right: Stage0ReadinessStep,
): boolean {
  if (left.kind !== right.kind) return false
  return left.kind === 'funding-active-final'
    ? left.legId === (right as { readonly legId: string }).legId
    : left.revealId === (right as { readonly revealId: string }).revealId
}

function readinessStepDone(
  state: Stage0State,
  step: Stage0ReadinessStep,
): boolean {
  return step.kind === 'funding-active-final'
    ? state.activeFinalFundingLegIds.includes(step.legId)
    : state.validatedRevealIds.includes(step.revealId)
}

function nextReadinessStep(
  state: Stage0State,
  plan: Stage0Plan,
): Stage0ReadinessStep | null {
  return (
    plan.readinessOrder.find(step => !readinessStepDone(state, step)) ?? null
  )
}

function withPhase(state: Stage0State, plan: Stage0Plan): Stage0State {
  if (state.outcome !== null) return { ...state, phase: 'outcome' }
  if (state.phase === 'recovery' || state.phase === 'settling') return state
  if (nextReadinessStep(state, plan) === null) {
    return { ...state, phase: 'ready-to-settle' }
  }
  if (state.fundingAuthorizationRoles.length > 0) {
    return { ...state, phase: 'funding' }
  }
  if (containsAll(state.readyToFundRoles, plan.roles)) {
    return { ...state, phase: 'ready-to-fund' }
  }
  if (state.offerRole !== null) return { ...state, phase: 'preparation' }
  return state
}

export function validateStage0Plan(plan: Stage0Plan): SwapResult<true> {
  const [left, right] = plan.roles
  const rolesValid =
    Number.isInteger(left) &&
    Number.isInteger(right) &&
    left >= 0 &&
    right >= 0 &&
    left <= 0xff &&
    right <= 0xff &&
    left !== right &&
    plan.roles.includes(plan.initiatorRole) &&
    plan.fundingConsentRoles.every(role => plan.roles.includes(role))
  if (!rolesValid) {
    return { ok: false, error: { code: 'bad-format', detail: 'stage-0 roles' } }
  }
  if (
    new Set(plan.fundingConsentRoles).size !== plan.fundingConsentRoles.length
  ) {
    return { ok: false, error: { code: 'bad-format', detail: 'consent roles' } }
  }
  if (
    plan.recoveryPlans.length > plan.roles.length ||
    new Set(plan.recoveryPlans.map(recovery => recovery.role)).size !==
      plan.recoveryPlans.length ||
    plan.recoveryPlans.some(recovery => !plan.roles.includes(recovery.role)) ||
    (plan.recoveryMode === 'recoverable' &&
      !plan.roles.every(role =>
        plan.recoveryPlans.some(recovery => recovery.role === role),
      ))
  ) {
    return {
      ok: false,
      error: { code: 'bad-format', detail: 'recovery plans' },
    }
  }
  if (
    plan.readinessOrder.length === 0 ||
    plan.readinessOrder.length > 16 ||
    plan.readinessOrder.some(step => {
      const value =
        step.kind === 'funding-active-final' ? step.legId : step.revealId
      return value.length === 0 || value.length > 128
    }) ||
    plan.readinessOrder.some((step, index, steps) =>
      steps.slice(0, index).some(previous => sameReadinessStep(previous, step)),
    )
  ) {
    return {
      ok: false,
      error: { code: 'bad-format', detail: 'readiness order' },
    }
  }
  return { ok: true, value: true }
}

export function initialStage0State(): Stage0State {
  return {
    ...EMPTY_STATE,
    keyExchangeRoles: [],
    transactionCommitmentRoles: [],
    encryptedSignatureRoles: [],
    authorizationAttestationRoles: [],
    fundingConsentRoles: [],
    readyToFundRoles: [],
    fundingAuthorizationRoles: [],
    activeFinalFundingLegIds: [],
    validatedRevealIds: [],
    settlementFacts: [],
  }
}

/**
 * Deterministic Stage-0 model for fake adapters and restart tests. It consumes already validated
 * semantic facts; it is intentionally not a payload codec or a source of chain authority.
 */
export function advanceStage0(
  state: Stage0State,
  action: Stage0Action,
  plan: Stage0Plan,
): SwapResult<Stage0State> {
  const valid = validateStage0Plan(plan)
  if (!valid.ok) return valid
  if (state.outcome !== null)
    return fail('outcome is terminal for coordination')

  if ('role' in action && !validRole(plan, action.role)) {
    return fail('unknown role')
  }

  let next: Stage0State
  switch (action.kind) {
    case 'offer':
      if (action.role !== plan.initiatorRole) return fail('offer producer')
      if (state.offerRole !== null && state.offerRole !== action.role) {
        return fail('conflicting offer')
      }
      next = { ...state, offerRole: action.role }
      break
    case 'accept':
      if (state.offerRole === null || action.role !== peerRole(plan)) {
        return fail('accept before offer or from wrong role')
      }
      next = { ...state, acceptRole: action.role }
      break
    case 'key-exchange':
      if (!preparedThrough(state, plan, 'accepted'))
        return fail('keys before accept')
      next = {
        ...state,
        keyExchangeRoles: uniqueSorted(state.keyExchangeRoles, action.role),
      }
      break
    case 'transaction-commitments':
      if (!preparedThrough(state, plan, 'keys'))
        return fail('transactions before keys')
      next = {
        ...state,
        transactionCommitmentRoles: uniqueSorted(
          state.transactionCommitmentRoles,
          action.role,
        ),
      }
      break
    case 'encrypted-signatures':
      if (!preparedThrough(state, plan, 'transactions')) {
        return fail('signatures before transaction commitments')
      }
      next = {
        ...state,
        encryptedSignatureRoles: uniqueSorted(
          state.encryptedSignatureRoles,
          action.role,
        ),
      }
      break
    case 'prefunding-authorization-attestation':
      if (!preparedThrough(state, plan, 'signatures')) {
        return fail('attestation before signatures')
      }
      next = {
        ...state,
        authorizationAttestationRoles: uniqueSorted(
          state.authorizationAttestationRoles,
          action.role,
        ),
      }
      break
    case 'pair-specific-funding-consent':
      if (!plan.fundingConsentRoles.includes(action.role)) {
        return fail('consent not required from role')
      }
      if (!preparedThrough(state, plan, 'attestations')) {
        return fail('consent before attestations')
      }
      next = {
        ...state,
        fundingConsentRoles: uniqueSorted(
          state.fundingConsentRoles,
          action.role,
        ),
      }
      break
    case 'ready-to-fund':
      if (!preparedThrough(state, plan, 'consents')) {
        return fail('ready-to-fund before preparation')
      }
      next = {
        ...state,
        readyToFundRoles: uniqueSorted(state.readyToFundRoles, action.role),
      }
      break
    case 'funding-authorization-released':
      if (!state.readyToFundRoles.includes(action.role)) {
        return fail('funding authorization before local ready-to-fund')
      }
      next = {
        ...state,
        fundingAuthorizationRoles: uniqueSorted(
          state.fundingAuthorizationRoles,
          action.role,
        ),
      }
      break
    case 'funding-active-final':
      if (state.fundingAuthorizationRoles.length === 0) {
        return fail('funding final before authorization')
      }
      if (state.activeFinalFundingLegIds.includes(action.legId)) {
        return { ok: true, value: state }
      }
      if (
        nextReadinessStep(state, plan) === null ||
        !sameReadinessStep(nextReadinessStep(state, plan)!, action)
      ) {
        return fail('funding final outside pair readiness order')
      }
      next = {
        ...state,
        activeFinalFundingLegIds: uniqueSorted(
          state.activeFinalFundingLegIds,
          action.legId,
        ),
      }
      break
    case 'artifact-reveal-validated':
      if (state.fundingAuthorizationRoles.length === 0) {
        return fail('reveal before funding authorization')
      }
      if (state.validatedRevealIds.includes(action.revealId)) {
        return { ok: true, value: state }
      }
      if (
        nextReadinessStep(state, plan) === null ||
        !sameReadinessStep(nextReadinessStep(state, plan)!, action)
      ) {
        return fail('reveal outside pair readiness order')
      }
      next = {
        ...state,
        validatedRevealIds: uniqueSorted(
          state.validatedRevealIds,
          action.revealId,
        ),
      }
      break
    case 'first-leg-settlement-evidence':
      if (state.phase !== 'ready-to-settle' && state.phase !== 'settling') {
        return fail('settlement before readiness')
      }
      if (plan.custodyMode === 'native-atomic')
        return fail('wrong custody branch')
      next = {
        ...state,
        phase: 'settling',
        settlementFacts: uniqueSorted(
          state.settlementFacts,
          'first-leg-settlement-evidence',
        ),
      }
      break
    case 'extracted-adaptor-secret':
      if (
        plan.custodyMode !== 'adaptor' ||
        !state.settlementFacts.includes('first-leg-settlement-evidence')
      ) {
        return fail('adaptor extraction before matching evidence')
      }
      next = {
        ...state,
        phase: 'settling',
        settlementFacts: uniqueSorted(
          state.settlementFacts,
          'extracted-adaptor-secret',
        ),
      }
      break
    case 'revealed-preimage-evidence':
      if (
        plan.custodyMode !== 'hashlock-or-program' ||
        !state.settlementFacts.includes('first-leg-settlement-evidence')
      ) {
        return fail('preimage before matching evidence')
      }
      next = {
        ...state,
        phase: 'settling',
        settlementFacts: uniqueSorted(
          state.settlementFacts,
          'revealed-preimage-evidence',
        ),
      }
      break
    case 'counter-leg-settlement-evidence': {
      const hasSecret =
        (plan.custodyMode === 'adaptor' &&
          state.settlementFacts.includes('extracted-adaptor-secret')) ||
        (plan.custodyMode === 'hashlock-or-program' &&
          state.settlementFacts.includes('revealed-preimage-evidence'))
      if (!hasSecret) return fail('counter settlement before extracted secret')
      next = {
        ...state,
        outcome: 'complete',
        settlementFacts: uniqueSorted(
          state.settlementFacts,
          'counter-leg-settlement-evidence',
        ),
      }
      break
    }
    case 'atomic-settlement-evidence':
      if (
        plan.custodyMode !== 'native-atomic' ||
        state.phase !== 'ready-to-settle'
      ) {
        return fail('wrong custody branch or premature atomic evidence')
      }
      next = {
        ...state,
        outcome: 'complete',
        settlementFacts: uniqueSorted(
          state.settlementFacts,
          'atomic-settlement-evidence',
        ),
      }
      break
    case 'cancel': {
      const afterCutoff =
        state.readyToFundRoles.length > 0 ||
        state.fundingAuthorizationRoles.length > 0
      if (afterCutoff)
        return fail('terminal cancel after local authorization cutoff')
      next = { ...state, outcome: 'failed-before-funding' }
      break
    }
    case 'enter-recovery': {
      const afterCutoff =
        state.readyToFundRoles.includes(action.role) ||
        state.fundingAuthorizationRoles.includes(action.role)
      if (!afterCutoff) return fail('recovery requested before cutoff')
      if (
        plan.recoveryMode === 'recoverable' &&
        !plan.recoveryPlans.some(recovery => recovery.role === action.role)
      ) {
        return fail('recoverable mode lacks a local unilateral plan')
      }
      next = { ...state, phase: 'recovery' }
      break
    }
    case 'recovery-outcome':
      if (state.phase !== 'recovery')
        return fail('recovery outcome outside recovery')
      if (
        plan.recoveryMode === 'recoverable' &&
        action.outcome === 'permanently-locked-by-design'
      ) {
        return fail('recoverable plan cannot claim permanent lock')
      }
      next = { ...state, outcome: action.outcome }
      break
  }
  return { ok: true, value: withPhase(next, plan) }
}
