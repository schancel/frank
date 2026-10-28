/**
 * How a failed paid send is shown: a send blocked by an earlier message whose payment cannot
 * finish is its own reason, keeps no attempt (nothing was paid for it), and says which message.
 */
import { StampBlockedError } from '@frank/wallet/evm-stamp-client'
import { UnsupportedContactPaymentRecordError } from '@frank/wallet/chain'
import { directMessageNotAttempted } from '@frank/wallet/chain/active-chain'
import {
  failedBeforePayment,
  unretryableFailure,
} from '../utils/outgoing-failure'
import enUS from '../i18n/en-us'
import {
  blockingMessage,
  classifySendFailure,
  errorDetail,
} from './chats-self-notes'

describe('classifySendFailure', () => {
  it('a send blocked by an earlier message is "blocked", keeps no attempt, and names the blocking message', () => {
    const error = new StampBlockedError('ab'.repeat(32), 'insufficient_total')
    expect(classifySendFailure(error, 'cd'.repeat(32))).toEqual({
      reason: 'blocked',
    })
    expect(errorDetail(error)).toBe('ab'.repeat(32))
    const sent = {
      outbound: true,
      payloadDigest: 'ef'.repeat(32),
      delivery: { attemptDigest: 'ab'.repeat(32) },
    }
    expect(
      blockingMessage(
        [undefined, { outbound: false, payloadDigest: 'ab'.repeat(32) }, sent],
        'ab'.repeat(32),
      ),
    ).toBe(sent)
    expect(blockingMessage([sent], 'not a digest')).toBeUndefined()
  })

  // The wallet labels its refusal of such a message as not attempted
  // (`contact-payment.jest.test.ts`).
  it('a message carrying a payment an older version made is refused as such: no attempt kept, no Retry, said in plain words', () => {
    const error = Object.defineProperty(
      new UnsupportedContactPaymentRecordError('0x' + '11'.repeat(20), 'm'),
      directMessageNotAttempted,
      { value: true },
    )
    expect(classifySendFailure(error, 'cd'.repeat(32))).toEqual({
      reason: 'payment-older-version',
    })
    expect(unretryableFailure('payment-older-version')).toBe(true)
    expect(enUS.outgoing.reasonPaymentOlderVersion).toMatch(/older version/)
  })

  // The same error out of a payment's submit or release, after its set was signed and perhaps
  // handed out, carries no label: it is not a refusal made before anything was paid.
  it('the same error without the label is not read as "nothing was paid": the attempt is kept', () => {
    const error = new UnsupportedContactPaymentRecordError(
      '0x' + '11'.repeat(20),
      'm',
    )
    const failure = classifySendFailure(error, 'cd'.repeat(32))
    expect(failure.reason).not.toBe('payment-older-version')
    expect(failure.keepDigest).toBe('cd'.repeat(32))
    expect(failedBeforePayment({ failureReason: failure.reason })).toBe(false)
  })
})
