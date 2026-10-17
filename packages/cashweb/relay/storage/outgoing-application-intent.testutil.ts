import type { OutgoingApplicationMessageClaim } from './storage'

/** Two-choice synthetic application: the semantic slot stays fixed for accept/decline. */
export const applicationClaim: OutgoingApplicationMessageClaim = {
  version: 1,
  intentKey: 'ab'.repeat(32),
  accountId: 'synthetic-account',
  signerKeyId: 'cd'.repeat(32),
  messagingChainIdentifier: 'monad-testnet',
  recipientPublicKey:
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  conversationId: '11111111-2222-4333-8444-555555555555',
  stampValueWei: '0',
  intentHex: '616363657074', // accept
}
export const applicationCompletion = {
  claim: applicationClaim,
  signedPayloadHex: '7369676e65642d616363657074', // signed-accept fixture (no real signature)
  messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
}
export const numberedClaim = (
  number: number,
  accountId = applicationClaim.accountId,
): OutgoingApplicationMessageClaim => ({
  ...applicationClaim,
  accountId,
  intentKey: number.toString(16).padStart(64, '0'),
})
