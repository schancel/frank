/**
 * How a failed paid send is shown: a send blocked by an earlier message whose payment cannot
 * finish is its own reason, keeps no attempt (nothing was paid for it), and says which message.
 */
import { StampBlockedError } from '@frank/wallet/evm-stamp-client'
import { blockingMessage, classifySendFailure, errorDetail } from './chats-self-notes'

describe('classifySendFailure', () => {
  it('a send blocked by an earlier message is "blocked", keeps no attempt, and names the blocking message', () => {
    const error = new StampBlockedError('ab'.repeat(32), 'insufficient_total')
    expect(classifySendFailure(error, 'cd'.repeat(32))).toEqual({ reason: 'blocked' })
    expect(errorDetail(error)).toBe('ab'.repeat(32))
    const sent = { outbound: true, payloadDigest: 'ef'.repeat(32), delivery: { attemptDigest: 'ab'.repeat(32) } }
    expect(blockingMessage([undefined, { outbound: false, payloadDigest: 'ab'.repeat(32) }, sent], 'ab'.repeat(32))).toBe(sent)
    expect(blockingMessage([sent], 'not a digest')).toBeUndefined()
  })
})
