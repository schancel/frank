import { Wallet, getBytes } from 'ethers'
import {
  encodeForumPost,
  encodeForumPostContent,
  encodeForumReadFrame,
  contentHash,
  topicPostSignatureDigest,
  validateFrame,
  defaultContext,
  topicVoteCommitment,
  topicBurnCalldata,
} from '@frank/codec'
import type { Encodable } from '@frank/codec'
import { projectForumView, ForumReadPolicy } from './forum-model'
import { MonadIdentity } from './monad-identity'
const time = (seconds: bigint) =>
  new Map<number, Encodable>([
    [0, seconds],
    [1, 0],
  ])
export const policy: ForumReadPolicy = {
  network: 'monad-testnet',
  chainId: 10143n,
  burnAddress: '0x000000000000000000000000000000000000dEaD',
}
export async function viewFixture(
  index = 1,
  magnitude = (1n << 255n) + 1n,
  negative = false,
) {
  const post = encodeForumPost({
    network: policy.network,
    topic: 'general',
    authored: { seconds: 1n, nanoseconds: 0 },
    entries: [{ title: 'Exact', message: String(index) }],
  })
  const p = validateFrame(post, defaultContext())
  if (p.kind !== 'parsed') throw Error('post')
  const wallet = new Wallet('0x' + '11'.repeat(32)),
    hash = contentHash(p)
  const raw = await wallet.signTransaction({
    type: 2,
    chainId: policy.chainId,
    nonce: index,
    to: policy.burnAddress,
    value: 9223372036854775807n,
    gasLimit: 21000,
    maxFeePerGas: 1,
    maxPriorityFeePerGas: 1,
    data: topicBurnCalldata('up', topicVoteCommitment(policy.network, hash)),
  })
  const tx = (await import('ethers')).Transaction.from(raw)
  const bytes = encodeForumReadFrame(
    12,
    new Map<number, Encodable>([
      [0, policy.network],
      [1, post],
      [2, getBytes(wallet.address)],
      [3, getBytes(raw)],
      [4, getBytes(tx.hash!)],
      [5, time(BigInt(index))],
      [6, 0],
      [7, 0],
      [
        8,
        new Map<number, Encodable>([
          [0, negative],
          [1, getBytes('0x' + magnitude.toString(16).padStart(64, '0'))],
        ]),
      ],
      [9, 18446744073709551615n],
      [10, new Uint8Array(16).fill(1)],
    ]),
  )
  return { bytes, hash }
}
describe('canonical observation model', () => {
  it('keeps signed 256-bit aggregates, u64 revision and zero block/index JSON exact', async () => {
    const { bytes } = await viewFixture(1, (1n << 256n) - 1n, true),
      p = validateFrame(bytes, defaultContext())
    if (p.kind !== 'parsed') throw Error('view')
    const model = projectForumView(p, policy)
    expect(model.voteWeightWei).toBe((-((1n << 256n) - 1n)).toString())
    expect(model.revision).toBe('18446744073709551615')
    expect(model.blockNumber).toBe('0')
    expect(model.transactionIndex).toBe('0')
    expect(JSON.parse(JSON.stringify(model)).voteWeightWei).toBe(
      model.voteWeightWei,
    )
    expect(() => projectForumView(p, { ...policy, chainId: 1n })).toThrow(
      'policy mismatch',
    )
  })

  it('attributes poster to signed identity instead of tx.from', async () => {
    const identity = MonadIdentity.generate()
    const authored = { seconds: 100n, nanoseconds: 0 }
    const entries = [{ title: 'Signed Post', message: 'Hello from identity' }]
    const body = encodeForumPostContent(authored, entries)
    const digest = topicPostSignatureDigest(policy.network, 'general', body)
    const from = {
      keyType: 1,
      keyBytes: new Uint8Array(identity.compressedPubKey),
    }
    const signature = new Uint8Array(identity.signHash(Buffer.from(digest)))
    const post = encodeForumPost({
      network: policy.network,
      topic: 'general',
      authored,
      entries,
      from,
      signature,
    })
    const p = validateFrame(post, defaultContext())
    if (p.kind !== 'parsed') throw Error('post')
    const burnWallet = new Wallet('0x' + '22'.repeat(32))
    const hash = contentHash(p)
    const raw = await burnWallet.signTransaction({
      type: 2,
      chainId: policy.chainId,
      nonce: 0,
      to: policy.burnAddress,
      value: 1000000n,
      gasLimit: 21000,
      maxFeePerGas: 1,
      maxPriorityFeePerGas: 1,
      data: topicBurnCalldata('up', topicVoteCommitment(policy.network, hash)),
    })
    const tx = (await import('ethers')).Transaction.from(raw)
    const bytes = encodeForumReadFrame(
      12,
      new Map<number, Encodable>([
        [0, policy.network],
        [1, post],
        [2, getBytes(burnWallet.address)],
        [3, getBytes(raw)],
        [4, getBytes(tx.hash!)],
        [5, time(100n)],
        [6, 0],
        [7, 0],
        [
          8,
          new Map<number, Encodable>([
            [0, false],
            [1, getBytes('0x' + (1000000n).toString(16).padStart(64, '0'))],
          ]),
        ],
        [9, 1n],
        [10, new Uint8Array(16).fill(1)],
      ]),
    )
    const viewParsed = validateFrame(bytes, defaultContext())
    if (viewParsed.kind !== 'parsed') throw Error('view')
    const model = projectForumView(viewParsed, policy)
    expect(model.poster).toBe(identity.address.raw)
    expect(model.poster).not.toBe(burnWallet.address)
  })

  it('projects Kind 2 game entries with structured fields', async () => {
    const post = encodeForumPost({
      network: policy.network,
      topic: 'games',
      authored: { seconds: 1n, nanoseconds: 0 },
      entries: [
        {
          kind: 'game',
          gameType: 'poker',
          tableId: 'poker-table-888',
          hostAddress: '0xAlice111111111111111111111111111111111111',
          buyInAmount: '500 chips',
          currentPlayers: 3,
          maxPlayers: 8,
          botAddress: '0xBot22222222222222222222222222222222222222',
          title: 'Texas Holdem Tournament',
          message: 'Tournament starting soon',
        },
      ],
    })
    const p = validateFrame(post, defaultContext())
    if (p.kind !== 'parsed') throw Error('post')
    const wallet = new Wallet('0x' + '22'.repeat(32)),
      hash = contentHash(p)
    const raw = await wallet.signTransaction({
      type: 2,
      chainId: policy.chainId,
      nonce: 10,
      to: policy.burnAddress,
      value: 1000000n,
      gasLimit: 21000,
      maxFeePerGas: 1,
      maxPriorityFeePerGas: 1,
      data: topicBurnCalldata('up', topicVoteCommitment(policy.network, hash)),
    })
    const tx = (await import('ethers')).Transaction.from(raw)
    const bytes = encodeForumReadFrame(
      12,
      new Map<number, Encodable>([
        [0, policy.network],
        [1, post],
        [2, getBytes(wallet.address)],
        [3, getBytes(raw)],
        [4, getBytes(tx.hash!)],
        [5, time(10n)],
        [6, 0],
        [7, 0],
        [
          8,
          new Map<number, Encodable>([
            [0, false],
            [1, getBytes('0x' + (1000000n).toString(16).padStart(64, '0'))],
          ]),
        ],
        [9, 1n],
        [10, new Uint8Array(16).fill(1)],
      ]),
    )
    const viewParsed = validateFrame(bytes, defaultContext())
    if (viewParsed.kind !== 'parsed') throw Error('view')
    const model = projectForumView(viewParsed, policy)
    expect(model.entries).toHaveLength(1)
    expect(model.entries[0]).toEqual({
      kind: 'game',
      gameType: 'poker',
      tableId: 'poker-table-888',
      hostAddress: '0xAlice111111111111111111111111111111111111',
      buyInAmount: '500 chips',
      currentPlayers: 3,
      maxPlayers: 8,
      botAddress: '0xBot22222222222222222222222222222222222222',
      title: 'Texas Holdem Tournament',
      message: 'Tournament starting soon',
    })
  })
})

