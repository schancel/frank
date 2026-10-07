export type TextPost = {
  kind: 'post'
  title?: string
  url?: string
  message?: string
}

export type ForumGameEntry = {
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

export type ForumMessageEntry = TextPost | ForumGameEntry

export type ForumMessage = {
  /// Lotus address of poster
  poster: string
  topic: string
  satoshis: number
  entries: ForumMessageEntry[]
  payloadDigest: string
  parentDigest?: string
  timestamp: Date

  /// Filled in based on local processing
  replies?: ForumMessage[]
}
