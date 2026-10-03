import {
  advanceStage0,
  initialStage0State,
  Stage0Action,
  Stage0Plan,
  Stage0State,
  validateStage0Plan,
} from './index'

const plan: Stage0Plan = {
  roles: [0, 1],
  initiatorRole: 0,
  fundingConsentRoles: [0, 1],
  readinessOrder: [
    { kind: 'funding-active-final', legId: 'monad' },
    { kind: 'artifact-reveal-validated', revealId: 'withheld-parent' },
    { kind: 'funding-active-final', legId: 'ecash' },
    { kind: 'artifact-reveal-validated', revealId: 'adaptor-presignature' },
  ],
  custodyMode: 'adaptor',
  recoveryMode: 'griefable',
  recoveryPlans: [],
}

const preparation: readonly Stage0Action[] = [
  { kind: 'offer', role: 0 },
  { kind: 'accept', role: 1 },
  { kind: 'key-exchange', role: 0 },
  { kind: 'key-exchange', role: 1 },
  { kind: 'transaction-commitments', role: 0 },
  { kind: 'transaction-commitments', role: 1 },
  { kind: 'encrypted-signatures', role: 0 },
  { kind: 'encrypted-signatures', role: 1 },
  { kind: 'prefunding-authorization-attestation', role: 0 },
  { kind: 'prefunding-authorization-attestation', role: 1 },
  { kind: 'pair-specific-funding-consent', role: 0 },
  { kind: 'pair-specific-funding-consent', role: 1 },
]

function apply(
  state: Stage0State,
  action: Stage0Action,
  selectedPlan: Stage0Plan = plan,
): Stage0State {
  const result = advanceStage0(state, action, selectedPlan)
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.detail}`)
  return result.value
}

function replay(
  actions: readonly Stage0Action[],
  selectedPlan: Stage0Plan = plan,
): Stage0State {
  return actions.reduce(
    (state, action) => apply(state, action, selectedPlan),
    initialStage0State(),
  )
}

describe('deterministic Stage-0 lifecycle', () => {
  it('rejects malformed plans before allocating lifecycle work', () => {
    expect(validateStage0Plan({ ...plan, roles: [0, 0] })).toMatchObject({
      ok: false,
      error: { code: 'bad-format' },
    })
    expect(
      validateStage0Plan({
        ...plan,
        readinessOrder: Array(17).fill({
          kind: 'funding-active-final',
          legId: 'same',
        }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'bad-format' } })
    expect(
      validateStage0Plan({
        ...plan,
        recoveryMode: 'recoverable',
        recoveryPlans: [{ role: 0, action: 'refund' }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'bad-format' } })
  })

  it('requires every preparation gate and makes duplicates idempotent', () => {
    expect(
      advanceStage0(
        initialStage0State(),
        { kind: 'transaction-commitments', role: 0 },
        plan,
      ),
    ).toMatchObject({ ok: false, error: { code: 'transition-rejected' } })

    let state = replay(preparation)
    const duplicate = apply(state, preparation.at(-1)!)
    expect(duplicate).toEqual(state)
    state = apply(state, { kind: 'ready-to-fund', role: 0 })
    expect(state.phase).toBe('preparation')
    state = apply(state, { kind: 'ready-to-fund', role: 1 })
    expect(state.phase).toBe('ready-to-fund')
  })

  it('can terminally abort after every pre-cutoff durable transition', () => {
    let state = initialStage0State()
    for (const action of preparation) {
      state = apply(state, action)
      const cancelled = advanceStage0(state, { kind: 'cancel', role: 0 }, plan)
      expect(cancelled).toMatchObject({
        ok: true,
        value: { phase: 'outcome', outcome: 'failed-before-funding' },
      })
    }
  })

  it('replays after restart and reaches adaptor completion only in order', () => {
    const afterAuthorization = replay([
      ...preparation,
      { kind: 'ready-to-fund', role: 0 },
      { kind: 'ready-to-fund', role: 1 },
      { kind: 'funding-authorization-released', role: 0 },
    ])
    expect(
      advanceStage0(
        afterAuthorization,
        { kind: 'funding-active-final', legId: 'ecash' },
        plan,
      ),
    ).toMatchObject({ ok: false, error: { code: 'transition-rejected' } })
    const beforeRestart: readonly Stage0Action[] = [
      ...preparation,
      { kind: 'ready-to-fund', role: 0 },
      { kind: 'ready-to-fund', role: 1 },
      { kind: 'funding-authorization-released', role: 0 },
      { kind: 'funding-active-final', legId: 'monad' },
      { kind: 'artifact-reveal-validated', revealId: 'withheld-parent' },
    ]
    const before = replay(beforeRestart)
    const stateAfterRestart = replay(beforeRestart)
    expect(stateAfterRestart).toEqual(before)
    let state = stateAfterRestart
    expect(
      advanceStage0(
        state,
        {
          kind: 'artifact-reveal-validated',
          revealId: 'adaptor-presignature',
        },
        plan,
      ),
    ).toMatchObject({ ok: false, error: { code: 'transition-rejected' } })
    state = apply(state, { kind: 'funding-active-final', legId: 'ecash' })
    state = apply(state, {
      kind: 'artifact-reveal-validated',
      revealId: 'adaptor-presignature',
    })
    expect(state.phase).toBe('ready-to-settle')
    expect(
      advanceStage0(state, { kind: 'counter-leg-settlement-evidence' }, plan),
    ).toMatchObject({ ok: false, error: { code: 'transition-rejected' } })
    state = apply(state, { kind: 'first-leg-settlement-evidence' })
    expect(state.phase).toBe('settling')
    state = apply(state, { kind: 'extracted-adaptor-secret' })
    state = apply(state, { kind: 'counter-leg-settlement-evidence' })
    expect(state).toMatchObject({ phase: 'outcome', outcome: 'complete' })
  })

  it('never restores cancel after an unknown funding outcome', () => {
    const cutoff = replay([...preparation, { kind: 'ready-to-fund', role: 0 }])
    expect(
      advanceStage0(cutoff, { kind: 'cancel', role: 0 }, plan),
    ).toMatchObject({ ok: false, error: { code: 'transition-rejected' } })
    const recovery = apply(cutoff, { kind: 'enter-recovery', role: 0 })
    const locked = apply(recovery, {
      kind: 'recovery-outcome',
      outcome: 'permanently-locked-by-design',
    })
    expect(locked).toMatchObject({
      phase: 'outcome',
      outcome: 'permanently-locked-by-design',
    })
  })

  it('does not claim failed-before-funding after either role crosses the cutoff', () => {
    const cutoff = replay([...preparation, { kind: 'ready-to-fund', role: 1 }])
    expect(
      advanceStage0(cutoff, { kind: 'cancel', role: 0 }, plan),
    ).toMatchObject({ ok: false, error: { code: 'transition-rejected' } })
  })

  it('keeps custody branches disjoint', () => {
    const nativePlan: Stage0Plan = {
      ...plan,
      custodyMode: 'native-atomic',
      recoveryMode: 'recoverable',
      recoveryPlans: [
        { role: 0, action: 'refund' },
        { role: 1, action: 'refund' },
      ],
      readinessOrder: [
        { kind: 'funding-active-final', legId: 'ecash' },
        { kind: 'funding-active-final', legId: 'monad' },
      ],
    }
    let state = replay(
      [
        ...preparation,
        { kind: 'ready-to-fund', role: 0 },
        { kind: 'ready-to-fund', role: 1 },
        { kind: 'funding-authorization-released', role: 0 },
        { kind: 'funding-active-final', legId: 'ecash' },
        { kind: 'funding-active-final', legId: 'monad' },
      ],
      nativePlan,
    )
    expect(state.phase).toBe('ready-to-settle')
    expect(
      advanceStage0(
        state,
        { kind: 'first-leg-settlement-evidence' },
        nativePlan,
      ),
    ).toMatchObject({ ok: false, error: { code: 'transition-rejected' } })
    state = apply(state, { kind: 'atomic-settlement-evidence' }, nativePlan)
    expect(state.outcome).toBe('complete')
  })

  it('requires preimage evidence on the hashlock branch', () => {
    const hashlockPlan: Stage0Plan = {
      ...plan,
      custodyMode: 'hashlock-or-program',
      readinessOrder: [
        { kind: 'funding-active-final', legId: 'first' },
        { kind: 'funding-active-final', legId: 'counter' },
      ],
    }
    let state = replay(
      [
        ...preparation,
        { kind: 'ready-to-fund', role: 0 },
        { kind: 'ready-to-fund', role: 1 },
        { kind: 'funding-authorization-released', role: 0 },
        { kind: 'funding-active-final', legId: 'first' },
        { kind: 'funding-active-final', legId: 'counter' },
        { kind: 'first-leg-settlement-evidence' },
      ],
      hashlockPlan,
    )
    expect(
      advanceStage0(state, { kind: 'extracted-adaptor-secret' }, hashlockPlan),
    ).toMatchObject({ ok: false, error: { code: 'transition-rejected' } })
    state = apply(state, { kind: 'revealed-preimage-evidence' }, hashlockPlan)
    state = apply(
      state,
      { kind: 'counter-leg-settlement-evidence' },
      hashlockPlan,
    )
    expect(state.outcome).toBe('complete')
  })
})
