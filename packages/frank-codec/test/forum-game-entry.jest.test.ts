import {
  encodeForumPost,
  encodeForumGameContent,
  validateFrame,
  defaultContext,
  FrankCodecError,
  encodeFrame,
  encodeCanonical,
} from '../src'

describe('Kind 2: Forum Game Entry CBOR encoding and validation', () => {
  const authored = { seconds: 1700000000n, nanoseconds: 0 }

  it('encodes and validates a native Kind 2 game table announcement', () => {
    const frame = encodeForumPost({
      network: 'monad-testnet',
      topic: 'games',
      authored,
      entries: [
        {
          kind: 'game',
          gameType: 'poker',
          tableId: 'table-poker-99',
          hostAddress: '0xAlice111111111111111111111111111111111111',
          buyInAmount: '1000 chips',
          currentPlayers: 2,
          maxPlayers: 6,
          botAddress: '0xBot22222222222222222222222222222222222222',
          title: 'High Roller Poker Table',
          message: 'Blinds are 10/20. No limit holdem rules apply.',
        },
      ],
    })

    const parsed = validateFrame(frame, defaultContext())
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') return

    const post = parsed.typed as any
    expect(post.type).toBe(9)
    expect(post.schemaVersion).toBe(2)
    expect(post.content.entries).toHaveLength(1)

    const gameEntry = post.content.entries[0]
    expect(gameEntry.kind).toBe('game')
    expect(gameEntry.gameType).toBe('poker')
    expect(gameEntry.tableId).toBe('table-poker-99')
    expect(gameEntry.hostAddress).toBe(
      '0xAlice111111111111111111111111111111111111',
    )
    expect(gameEntry.buyInAmount).toBe('1000 chips')
    expect(gameEntry.currentPlayers).toBe(2)
    expect(gameEntry.maxPlayers).toBe(6)
    expect(gameEntry.botAddress).toBe(
      '0xBot22222222222222222222222222222222222222',
    )
    expect(gameEntry.title).toBe('High Roller Poker Table')
    expect(gameEntry.message).toBe(
      'Blinds are 10/20. No limit holdem rules apply.',
    )
  })

  it('encodes and validates single game content via encodeForumGameContent helper', () => {
    const body = encodeForumGameContent(authored, {
      gameType: 'liars-dice',
      tableId: 'dice-777',
      hostAddress: '0xBob',
      currentPlayers: 1,
      maxPlayers: 5,
    })

    const rawPayload = new Map<number, any>([
      [0, 'monad-testnet'],
      [1, 'games'],
      [3, body],
    ])
    const frame = encodeFrame(
      { typeId: 9, schemaVersion: 2, minReaderVersion: 2 },
      rawPayload,
    )

    const parsed = validateFrame(frame, defaultContext())
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') return

    const post = parsed.typed as any
    const entry = post.content.entries[0]
    expect(entry.kind).toBe('game')
    expect(entry.gameType).toBe('liars-dice')
    expect(entry.tableId).toBe('dice-777')
    expect(entry.hostAddress).toBe('0xBob')
    expect(entry.currentPlayers).toBe(1)
    expect(entry.maxPlayers).toBe(5)
    expect(entry.buyInAmount).toBeUndefined()
  })

  it('supports mixed post and game entries within the same topic post', () => {
    const frame = encodeForumPost({
      network: 'monad-testnet',
      topic: 'arcade',
      authored,
      entries: [
        {
          kind: 'post',
          title: 'Arcade Night Announcements',
          message: 'Join us tonight for multiplayer tables!',
        },
        {
          kind: 'game',
          gameType: 'rps',
          tableId: 'rps-challenge-1',
          hostAddress: '0xCharlie',
          buyInAmount: '0.05 MON',
          currentPlayers: 1,
          maxPlayers: 2,
        },
      ],
    })

    const parsed = validateFrame(frame, defaultContext())
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') return

    const post = parsed.typed as any
    expect(post.content.entries).toHaveLength(2)
    expect(post.content.entries[0].kind).toBe('post')
    expect(post.content.entries[0].title).toBe('Arcade Night Announcements')
    expect(post.content.entries[1].kind).toBe('game')
    expect(post.content.entries[1].gameType).toBe('rps')
    expect(post.content.entries[1].tableId).toBe('rps-challenge-1')
  })

  it('rejects kind 2 entries missing required fields (tableId, hostAddress)', () => {
    // Missing required field 3 (hostAddress)
    const invalidEntry = new Map<number, any>([
      [0, 2],
      [1, 'poker'],
      [2, 'table-1'],
      // 3 (hostAddress) missing
    ])
    const body = encodeCanonical(
      new Map<number, any>([
        [
          0,
          new Map<number, any>([
            [0, 1700000000n],
            [1, 0],
          ]),
        ],
        [1, [invalidEntry]],
      ]),
    )
    const payload = new Map<number, any>([
      [0, 'monad-testnet'],
      [1, 'games'],
      [3, body],
    ])
    const frame = encodeFrame(
      { typeId: 9, schemaVersion: 2, minReaderVersion: 2 },
      payload,
    )

    expect(() => validateFrame(frame, defaultContext())).toThrow(FrankCodecError)
  })

  it('rejects player counts outside allowed range 0..1000', () => {
    const invalidEntry = new Map<number, any>([
      [0, 2],
      [1, 'poker'],
      [2, 'table-1'],
      [3, '0xHost'],
      [5, 1001], // currentPlayers > 1000
    ])
    const body = encodeCanonical(
      new Map<number, any>([
        [
          0,
          new Map<number, any>([
            [0, 1700000000n],
            [1, 0],
          ]),
        ],
        [1, [invalidEntry]],
      ]),
    )
    const payload = new Map<number, any>([
      [0, 'monad-testnet'],
      [1, 'games'],
      [3, body],
    ])
    const frame = encodeFrame(
      { typeId: 9, schemaVersion: 2, minReaderVersion: 2 },
      payload,
    )

    expect(() => validateFrame(frame, defaultContext())).toThrow(FrankCodecError)
  })
})
