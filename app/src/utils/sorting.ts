import type { MessageWithReplies } from 'src/stores/forum'

export const sortModes = ['hot', 'top', 'new'] as const
export type SortMode = (typeof sortModes)[number]

/** Approximate ranking scalar only; stored and displayed weights remain exact. */
export function halfLife(weight: string | bigint | number, timestamp: Date, now: Date) {
  return Number(weight) * Math.pow(0.5, (now.valueOf() - timestamp.valueOf()) / 86400000)
}

function tie(a: MessageWithReplies, b: MessageWithReplies): number {
  return a.payloadDigest < b.payloadDigest ? -1 : a.payloadDigest > b.payloadDigest ? 1 : 0
}
function compareWeight(a: MessageWithReplies, b: MessageWithReplies): number {
  const x = BigInt(a.voteWeightWei), y = BigInt(b.voteWeightWei)
  return x === y ? tie(a, b) : x > y ? -1 : 1
}
export function halfLifeSort(posts: MessageWithReplies[]) {
  const now = new Date()
  return posts.slice().sort((a, b) => {
    const score = halfLife(b.voteWeightWei, new Date(b.timestamp), now) - halfLife(a.voteWeightWei, new Date(a.timestamp), now)
    return score || compareWeight(a, b)
  })
}
export function timeSort(posts: MessageWithReplies[]) {
  return posts.slice().sort((a, b) => {
    const secondsA = BigInt(a.visibleTimestamp.seconds)
    const secondsB = BigInt(b.visibleTimestamp.seconds)
    if (secondsA !== secondsB) return secondsA > secondsB ? -1 : 1
    const nanosA = a.visibleTimestamp.nanoseconds
    const nanosB = b.visibleTimestamp.nanoseconds
    return nanosA === nanosB ? tie(a, b) : nanosA > nanosB ? -1 : 1
  })
}
export function voteSort(posts: MessageWithReplies[]) {
  return posts.slice().sort(compareWeight)
}
export function sortPostsByMode(posts: MessageWithReplies[], sortMode: SortMode) {
  switch (sortMode) {
    case 'top': return voteSort(posts)
    case 'new': return timeSort(posts)
    default: return halfLifeSort(posts)
  }
}
