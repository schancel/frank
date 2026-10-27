import type { EvmNativeOperationStatus } from '@frank/wallet/chain'
import enUS from '../i18n/en-us'
import frFR from '../i18n/fr-fr'
import {
  nativeOperationOutcome,
  nativeOperationProgress,
  nativeOperationSettling,
} from './native-operation-outcome'

type Member = EvmNativeOperationStatus['members'][number]
const member = (
  state: Member['state'],
  submitted: boolean,
  role: Member['role'] = 'funding',
): Member => ({ role, account: '0xabc', nonce: 0, submitted, state })

describe('the outcome line of a send', () => {
  // A QA run saw "Payment outcome is unresolved … Funds may have moved" about 25 s after a Send
  // max, while its funding had landed and its payment was waiting for that funding to be sent.
  it('a Send max whose payment waits for its landed funding is sending, not unresolved', () => {
    const operation = {
      payment: 'unknown' as const,
      members: [
        member('included-success', true),
        member('included-success', true),
        member('pending', true),
        member('unknown', false, 'payment'),
      ],
    }
    expect(nativeOperationProgress(operation)).toEqual({
      confirmed: 2,
      total: 4,
    })
    expect(nativeOperationOutcome(operation, 'Monad Regtest')).toEqual({
      key: 'nativeOperation.sending',
      params: { confirmed: 2, total: 4, network: 'Monad Regtest' },
    })
  })

  it('a transaction that was sent and that the chain could not tell about stays unresolved', () => {
    const operation = {
      payment: 'unknown' as const,
      members: [
        member('included-success', true),
        member('unknown', true, 'payment'),
      ],
    }
    expect(nativeOperationProgress(operation)).toBeUndefined()
    expect(nativeOperationOutcome(operation, 'Monad Regtest').key).toBe(
      'nativeOperation.unknown',
    )
  })

  it.each(['included-revert', 'superseded'] as const)(
    'a %s member keeps the outcome open, as it was',
    state => {
      const operation = {
        payment: 'unknown' as const,
        members: [
          member('unknown', false, 'payment'),
          member(state, true, 'funding'),
        ],
      }
      expect(nativeOperationProgress(operation)).toBeUndefined()
      expect(nativeOperationOutcome(operation, 'X').key).toBe(
        'nativeOperation.unknown',
      )
    },
  )

  it.each([
    'included',
    'partial',
    'pending',
    'missing',
    'reverted',
    'cancelled',
  ] as const)('an outcome of %s keeps its own line', payment => {
    const operation = {
      payment,
      members: [member('unknown', false, 'payment')],
    }
    expect(nativeOperationOutcome(operation, 'X').key).toBe(
      `nativeOperation.${payment}`,
    )
  })

  it('no operation read yet is the unresolved line, as before', () => {
    expect(nativeOperationOutcome(undefined, 'X').key).toBe(
      'nativeOperation.unknown',
    )
  })

  it.each([
    [enUS, 'Sending on Monad Regtest… 2 of 4 transactions confirmed.'],
    [
      frFR,
      'Envoi en cours sur Monad Regtest… 2 transactions confirmées sur 4.',
    ],
  ])('reads in each language (%#)', (messages, expected) => {
    expect(
      messages.nativeOperation.sending
        .replace('{network}', 'Monad Regtest')
        .replace('{confirmed}', '2')
        .replace('{total}', '4'),
    ).toBe(expected)
  })
})

describe('a sent transfer whose change is still settling', () => {
  // QA on main 10390a333: "Sent on Monad Regtest." for 54 s while the change (same account, next
  // nonce) had not reached the node. Sent is right; the change is said to be settling.
  it('counts what is in a block while the recipient is paid and the change is not', () => {
    const operation = {
      payment: 'included' as const,
      members: [
        member('included-success', true, 'payment'),
        member('unknown', false, 'change'),
      ],
    }
    expect(nativeOperationSettling(operation)).toEqual({
      confirmed: 1,
      total: 2,
    })
  })

  it.each(['included-success', 'included-revert', 'superseded'] as const)(
    'a change that is %s is final: nothing is settling',
    state => {
      expect(
        nativeOperationSettling({
          payment: 'included',
          members: [
            member('included-success', true, 'payment'),
            member(state, true, 'change'),
          ],
        }),
      ).toBeUndefined()
    },
  )

  it.each(['unknown', 'pending', 'missing', 'partial'] as const)(
    'an outcome of %s is not "sent": no settling line',
    payment => {
      expect(
        nativeOperationSettling({
          payment,
          members: [member('pending', true, 'payment')],
        }),
      ).toBeUndefined()
    },
  )

  // French agrees with the count confirmed: 0 or 1 is singular ("1 transaction confirmée").
  it.each([
    [
      enUS,
      'changeSettlingOne',
      1,
      'Change still settling (1 of 2 transactions confirmed).',
    ],
    [
      enUS,
      'changeSettling',
      2,
      'Change still settling (2 of 3 transactions confirmed).',
    ],
    [
      frFR,
      'changeSettlingOne',
      1,
      'Le rendu de la monnaie est en cours (1 transaction confirmée sur 2).',
    ],
    [
      frFR,
      'changeSettling',
      2,
      'Le rendu de la monnaie est en cours (2 transactions confirmées sur 3).',
    ],
  ] as const)(
    'reads in each language (%#)',
    (messages, key, confirmed, expected) => {
      expect(
        messages.nativeOperation[key]
          .replace('{confirmed}', String(confirmed))
          .replace('{total}', String(confirmed + 1)),
      ).toBe(expected)
    },
  )
})
