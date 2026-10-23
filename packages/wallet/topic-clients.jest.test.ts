import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultContext,
  encodeForumPost,
  TYPE_FORUM_OPERATION_STATUS,
  validateFrame,
} from '@frank/codec'
import { TopicPostClient, TopicPostAbandonedError } from './topic-post-client'
import { TopicVoteClient, TopicVoteAbandonedError } from './topic-vote-client'
import {
  TopicOperationPendingError,
  TopicUnsupportedError,
} from './topic-operations'
import type {
  TopicOperationCapability,
  TopicOperationRequest,
  TopicOperationResult,
} from './topic-operations'

function wallet(chainIdentifier: string) {
  const requests: TopicOperationRequest[] = []
  const frame = validateFrame(
    encodeForumPost({
      network: chainIdentifier,
      topic: 'test',
      authored: { seconds: 1n, nanoseconds: 0 },
      entries: [{ kind: 'post', message: 'hello' }],
    }),
    defaultContext(),
  )
  if (frame.kind !== 'parsed') throw new Error('Invalid test frame')
  const result: TopicOperationResult = {
    transactionSetHash: 'adapter-owned-set',
    transactionHashes: ['adapter-owned-transaction'],
    status: {
      type: TYPE_FORUM_OPERATION_STATUS,
      network: chainIdentifier,
      submittedFrame: frame,
      targetHash: new Uint8Array(32),
      transactionHash: new Uint8Array(32),
      sender: new Uint8Array(32),
      direction: 1,
      value: 5n,
      revision: 1n,
      epoch: new Uint8Array(16),
      unknownFields: new Map(),
      state: 1,
      evidence: 'relay-observed',
    },
  }
  const capability: TopicOperationCapability = {
    chainIdentifier,
    submit: jest.fn(async request => {
      requests.push(request)
      return result
    }),
    reconcile: jest.fn(async () => undefined),
  }
  return { chainIdentifier, topicOperations: capability, requests, result }
}

it.each(['ethereum-sepolia', 'solana-devnet', 'bitcoin-testnet'])(
  'posts and votes through an active %s wallet without native account assumptions',
  async chainIdentifier => {
    const active = wallet(chainIdentifier)
    const posts = new TopicPostClient(active)
    const result = await posts.submitTopicPost({
      topic: 'test',
      entries: [{ kind: 'post', message: 'hello' }],
      direction: 'up',
      amountAtomic: 5n,
      timestampMs: 1000,
      operationId: 'post',
    })
    expect(result.transactionHashes).toEqual(['adapter-owned-transaction'])
    expect(active.requests[0]).toMatchObject({
      kind: 'post',
      amountAtomic: 5n,
      operationId: 'post',
    })
    const parsed = validateFrame(result.postFrame, defaultContext())
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') throw new Error('Expected post')
    expect(parsed.typed).toMatchObject({
      network: chainIdentifier,
      topic: 'test',
    })
    expect(active.requests[0]!.postFrame).toEqual(result.postFrame)
    const votes = new TopicVoteClient(active)
    await expect(
      votes.castVote({
        targetPayloadHash: new Uint8Array(32),
        direction: 'down',
        amountAtomic: 6n,
      }),
    ).resolves.toEqual(active.result)
    expect(active.requests[1]).toMatchObject({
      kind: 'vote',
      direction: 'down',
      amountAtomic: 6n,
    })
    expect(active.requests[1]).not.toHaveProperty('postFrame')
    expect(active.requests).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ burnAddress: expect.anything() }),
      ]),
    )
    await posts.resumePendingOperations()
    await votes.resumePendingOperations()
    expect(active.topicOperations.reconcile).toHaveBeenNthCalledWith(1, 'post')
    expect(active.topicOperations.reconcile).toHaveBeenNthCalledWith(2, 'vote')
  },
)

it('rejects unsupported and foreign capabilities before any operation', async () => {
  const unsupported = { chainIdentifier: 'solana-devnet' }
  await expect(
    new TopicPostClient(unsupported).submitTopicPost({
      topic: 'test',
      entries: [],
      direction: 'up',
      amountAtomic: 1n,
    }),
  ).rejects.toBeInstanceOf(TopicUnsupportedError)
  const foreign = wallet('ethereum-sepolia')
  foreign.chainIdentifier = 'solana-devnet'
  await expect(
    new TopicVoteClient(foreign).castVote({
      targetPayloadHash: new Uint8Array(32),
      direction: 'up',
      amountAtomic: 1n,
    }),
  ).rejects.toThrow('different chain')
  expect(foreign.topicOperations.submit).not.toHaveBeenCalled()
})

it('keeps uncertain operation failures explicit without retrying a new payment', async () => {
  const active = wallet('solana-devnet')
  const submit = jest
    .spyOn(active.topicOperations, 'submit')
    .mockRejectedValue(
      new TopicOperationPendingError(
        'Unknown broadcast outcome',
        new Error('network lost'),
      ),
    )
  await expect(
    new TopicPostClient(active).submitTopicPost({
      topic: 'test',
      entries: [{ kind: 'post', message: 'hello' }],
      direction: 'up',
      amountAtomic: 1n,
    }),
  ).rejects.toBeInstanceOf(TopicPostAbandonedError)
  await expect(
    new TopicVoteClient(active).castVote({
      targetPayloadHash: new Uint8Array(32),
      direction: 'up',
      amountAtomic: 1n,
    }),
  ).rejects.toBeInstanceOf(TopicVoteAbandonedError)
  expect(submit).toHaveBeenCalledTimes(2)
})

it('keeps the public Forum clients and capability free of EVM dependencies', () => {
  for (const file of [
    'topic-post-client.ts',
    'topic-vote-client.ts',
    'topic-operations.ts',
  ]) {
    const source = readFileSync(join(__dirname, file), 'utf8')
    expect(source).not.toMatch(/from\s+['"][^'"]*(?:ethers|evm-|monad-)/i)
    expect(source).not.toMatch(
      /\b(?:burnAddress|voteWeightWei|nonce|gasLimit|Monad\w+)\b/,
    )
  }
})
