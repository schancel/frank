import { Transaction, getBytes, getAddress } from 'ethers'
import {
  contentHash,
  toHex,
  topicVoteCommitment,
  topicBurnCalldata,
  matchForumView,
  verifyTopicPostAuthor,
} from '@frank/codec'
import type { ParsedFrame } from '@frank/codec'

export interface ForumGameMessageEntry {
  kind: 'game'
  gameType: string
  tableId: string
  hostAddress: string
  buyInAmount?: string
  currentPlayers?: number
  maxPlayers?: number
  botAddress?: string
  title?: string
  message?: string
}

export type ForumMessageEntry =
  | {
      kind: 'post'
      title?: string
      url?: string
      message?: string
    }
  | ForumGameMessageEntry
export interface ForumMessage {
  poster: string
  topic: string
  voteWeightWei: string
  entries: ForumMessageEntry[]
  payloadDigest: string
  parentDigest?: string
  /** Display only; ordering and query decisions use visibleTimestamp. */
  timestamp: Date | string
  visibleTimestamp: { seconds: string; nanoseconds: number }
  epoch: string
  revision: string
  transactionHash: string
  authorBurnTx: string
  blockNumber: string
  transactionIndex: string
  replies?: ForumMessage[]
}
export interface DiscoveredTopic {
  topic: string
  postCount: string
  lastActivityMs: number
  lastActivity: { seconds: string; nanoseconds: number }
  epoch: string
  revision: string
}
export interface ForumReadPolicy {
  network: string
  chainId: bigint
  burnAddress: string
}

/** Compares the observed author with the signed transaction; this is no finality proof. */
export function projectForumView(
  frame: ParsedFrame,
  policy: ForumReadPolicy,
): ForumMessage {
  const view = frame.typed
  if (view?.type !== 12) throw new Error('Expected Forum view')
  const post = view.postFrame.typed
  if (post?.type !== 9 || post.schemaVersion !== 2) {
    throw new Error('Expected canonical Forum content')
  }
  const tx = Transaction.from('0x' + toHex(view.authorBurnTx))
  const hash = contentHash(view.postFrame)
  const commitment = topicVoteCommitment(policy.network, hash)
  if (
    !tx.signature ||
    !tx.from ||
    !tx.hash ||
    tx.chainId !== policy.chainId ||
    tx.to?.toLowerCase() !== policy.burnAddress.toLowerCase() ||
    tx.value < 1n ||
    tx.value > 9223372036854775807n ||
    tx.data !== '0x' + toHex(topicBurnCalldata('up', commitment))
  ) {
    throw new Error('Author burn policy mismatch')
  }
  matchForumView(frame.frame, {
    network: policy.network,
    topic: post.topic,
    targetHash: hash,
    rawTransaction: getBytes(tx.serialized),
    transactionHash: getBytes(tx.hash),
    sender: getBytes(tx.from),
    direction: 1,
    commitment,
  })
  let magnitude = BigInt('0x' + toHex(view.aggregate.magnitude))
  if (view.aggregate.negative) magnitude = -magnitude
  const displayed = new Date(
    Number(view.firstVisible.seconds) * 1000 +
      view.firstVisible.nanoseconds / 1e6,
  )
  const verifiedAuthor = verifyTopicPostAuthor(post)
  const poster = verifiedAuthor
    ? getAddress('0x' + toHex(verifiedAuthor))
    : getAddress(tx.from)
  return {
    poster,
    topic: post.topic,
    voteWeightWei: magnitude.toString(),
    entries: post.content.entries
      .filter(
        (
          entry,
        ): entry is Extract<
          typeof entry,
          { kind: 'post' } | { kind: 'game' }
        > => entry.kind === 'post' || entry.kind === 'game',
      )
      .map(entry => {
        if (entry.kind === 'post') {
          return {
            kind: 'post' as const,
            title: entry.title,
            url: entry.url,
            message: entry.message,
          }
        }
        return {
          kind: 'game' as const,
          gameType: entry.gameType,
          tableId: entry.tableId,
          hostAddress: entry.hostAddress,
          buyInAmount: entry.buyInAmount,
          currentPlayers: entry.currentPlayers,
          maxPlayers: entry.maxPlayers,
          botAddress: entry.botAddress,
          title: entry.title,
          message: entry.message,
        }
      }),
    payloadDigest: toHex(hash),
    parentDigest: post.parentHash && toHex(post.parentHash),
    timestamp: Number.isNaN(displayed.getTime())
      ? view.firstVisible.seconds.toString()
      : displayed,
    visibleTimestamp: {
      seconds: view.firstVisible.seconds.toString(),
      nanoseconds: view.firstVisible.nanoseconds,
    },
    epoch: toHex(view.epoch),
    revision: view.revision.toString(),
    transactionHash: toHex(view.transactionHash),
    authorBurnTx: '0x' + toHex(view.authorBurnTx),
    blockNumber: view.block.toString(),
    transactionIndex: view.transactionIndex.toString(),
  }
}
