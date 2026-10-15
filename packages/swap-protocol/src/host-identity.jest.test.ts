import {
  appNegotiationIncarnation,
  botNegotiationIncarnation,
} from './host-identity'
const receipt = {
  schema: 1,
  policy: 'browser-preview-aes-gcm-v1',
  context: {
    accountId: 'account-a',
    creationId: 'creation-a',
    recoveryFormat: 'frank-codex32-v1',
    registry: 'frank-domain-roots-v1',
    purposes: ['evm-wallet', 'identity-authentication', 'messaging-encryption'],
    custodyEpoch: 0,
    recoveryFingerprint: 'fingerprint-a',
    retirementContext: 'retirement-a',
  },
  previousRevision: 0,
  revision: 1,
  operationId: 'operation-a',
}
test('app incarnation uses explicit tuple with exact purpose order and stable restored metadata', () => {
  const expected =
    'app-v1-3bdfd7917c994e8a03f5ce731c7d822a4ef932cbf46cf1c458db9660849128c3'
  expect(appNegotiationIncarnation(2, receipt)).toBe(expected)
  const restored = JSON.parse(JSON.stringify(receipt))
  expect(appNegotiationIncarnation(2, restored)).toBe(expected)
  expect(appNegotiationIncarnation(3, receipt)).not.toBe(expected)
  expect(
    appNegotiationIncarnation(2, { ...receipt, operationId: 'replacement' }),
  ).not.toBe(expected)
  expect(
    appNegotiationIncarnation(2, {
      ...receipt,
      context: {
        ...receipt.context,
        purposes: [...receipt.context.purposes].reverse(),
      },
    }),
  ).not.toBe(expected)
})
test('bot profile restoration retains identity independently of path and display name', () => {
  const owner = {
    botId: 'bot-a',
    chainIdentifier: 'monad-testnet',
    subject: '02' + '11'.repeat(32),
    address: '0x' + '22'.repeat(20),
  }
  const expected =
    'bot-v1-ce2dc29052c17a174c6a6e411b468ad7d634d8af0aa4eef1932382aa21c02eaa'
  expect(botNegotiationIncarnation(owner)).toBe(expected)
  expect(botNegotiationIncarnation({ ...owner })).toBe(expected)
  expect(
    botNegotiationIncarnation({ ...owner, subject: '03' + '11'.repeat(32) }),
  ).not.toBe(expected)
})
