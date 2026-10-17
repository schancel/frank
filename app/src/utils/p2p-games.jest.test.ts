import {
  diceCommitment,
  dicePayoutWei,
  diceRoll,
  verifyDiceResult,
} from '@frank/wallet/message-item-plugins/dice/fair'
import {
  rpsCommitment,
  rpsPayoutWei,
  verifyRpsResult,
} from '@frank/wallet/message-item-plugins/rps/fair'

import {
  automaticP2pGameSteps,
  buildDiceChallenge,
  buildRpsChallenge,
  clearP2pGameSecretsForTests,
  dealerDiceStepForRoll,
  dealerRpsStepForMatch,
  deriveDiceSecret,
  deriveRpsSalt,
  saveDiceSecret,
  type P2pGameChatMessage,
} from './p2p-games'

describe('P2P Satoshi Dice & Rock-Paper-Scissors commit-reveal glue', () => {
  const alice = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const bob = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const privKey = '11'.repeat(32)

  beforeEach(() => {
    clearP2pGameSecretsForTests()
    if (typeof localStorage !== 'undefined') {
      localStorage.clear()
    }
  })

  it('derives deterministic dice secrets and RPS salts from private key + game ID', () => {
    const s1 = deriveDiceSecret('roll-1', alice, privKey)
    const s2 = deriveDiceSecret('roll-1', alice, privKey)
    const s3 = deriveDiceSecret('roll-2', alice, privKey)
    expect(s1).toHaveLength(64)
    expect(s1).toBe(s2)
    expect(s1).not.toBe(s3)

    const r1 = deriveRpsSalt('match-1', alice, privKey)
    const r2 = deriveRpsSalt('match-1', alice, privKey)
    const r3 = deriveRpsSalt('match-2', alice, privKey)
    expect(r1).toHaveLength(32)
    expect(r1).toBe(r2)
    expect(r1).not.toBe(r3)
  })

  it('builds a P2P Satoshi Dice challenge, computes the dealer step on peer roll, and passes verifyDiceResult', () => {
    const rollId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const secret = '5a'.repeat(32)
    saveDiceSecret(alice, bob, rollId, secret)
    const commitment = diceCommitment(secret)
    const clientSeed = 'c3'.repeat(16)
    const rolled = diceRoll(secret, clientSeed)

    // Pick a target where Bob loses so automaticP2pGameSteps auto-reveals
    const losingTarget = Math.max(1, rolled)
    const wagerWei = 10n ** 16n
    const messages: P2pGameChatMessage[] = [
      {
        outbound: true,
        items: [{ type: 'dice', action: 'table', rollId, commitment }],
      },
      {
        outbound: false,
        items: [
          {
            type: 'dice',
            action: 'roll',
            rollId,
            commitment,
            clientSeed,
            target: losingTarget,
            wagerWei: wagerWei.toString(),
          },
        ],
      },
    ]

    const step = dealerDiceStepForRoll(messages, alice, bob, rollId)
    expect(step).toBeDefined()
    expect(step!.isWin).toBe(false)
    expect(step!.payWei).toBe(0n)
    expect(
      verifyDiceResult(step!.item, messages[1].items![0] as any, []),
    ).toEqual({ ok: true })

    // Zero-payout reveal is included in automaticP2pGameSteps
    const autoSteps = automaticP2pGameSteps(messages, alice, bob)
    expect(autoSteps).toHaveLength(1)
    expect(autoSteps[0].key).toBe(`dice:${rollId}`)

    // Winning target requires manual dealer confirmation (payWei > 0n) and is excluded from automaticP2pGameSteps
    const winningTarget = Math.min(65535, rolled + 1)
    const winMessages: P2pGameChatMessage[] = [
      messages[0],
      {
        outbound: false,
        items: [
          {
            type: 'dice',
            action: 'roll',
            rollId,
            commitment,
            clientSeed,
            target: winningTarget,
            wagerWei: wagerWei.toString(),
          },
        ],
      },
    ]
    const winStep = dealerDiceStepForRoll(winMessages, alice, bob, rollId)
    expect(winStep).toBeDefined()
    expect(winStep!.isWin).toBe(true)
    expect(winStep!.payWei).toBe(dicePayoutWei(wagerWei, winningTarget))
    expect(automaticP2pGameSteps(winMessages, alice, bob)).toEqual([])
  })

  it('builds a P2P Rock-Paper-Scissors challenge, computes the dealer step on peer move, and passes verifyRpsResult', () => {
    const challenge = buildRpsChallenge(alice, bob, 'rock', 'match-rps-1')
    expect(challenge.item.commitHash).toBe(
      rpsCommitment('rock', challenge.salt),
    )

    const wagerWei = 5n * 10n ** 16n
    // Case 1: Peer plays scissors -> Peer loses (payWei === 0n -> auto-revealed)
    const loseMessages: P2pGameChatMessage[] = [
      { outbound: true, items: [challenge.item] },
      {
        outbound: false,
        items: [
          {
            type: 'rps',
            action: 'move',
            matchId: 'match-rps-1',
            commitHash: challenge.item.commitHash,
            playerMove: 'scissors',
            wagerWei: wagerWei.toString(),
          },
        ],
      },
    ]
    const loseStep = dealerRpsStepForMatch(
      loseMessages,
      alice,
      bob,
      'match-rps-1',
    )
    expect(loseStep).toBeDefined()
    expect(loseStep!.outcome).toBe('lose')
    expect(loseStep!.payWei).toBe(0n)
    expect(
      verifyRpsResult(loseStep!.item, loseMessages[1].items![0] as any),
    ).toEqual({ ok: true })
    expect(automaticP2pGameSteps(loseMessages, alice, bob)).toHaveLength(1)

    // Case 2: Peer plays paper -> Peer wins 2x stake (payWei > 0n -> manual dealer confirmation)
    const winMessages: P2pGameChatMessage[] = [
      { outbound: true, items: [challenge.item] },
      {
        outbound: false,
        items: [
          {
            type: 'rps',
            action: 'move',
            matchId: 'match-rps-1',
            commitHash: challenge.item.commitHash,
            playerMove: 'paper',
            wagerWei: wagerWei.toString(),
          },
        ],
      },
    ]
    const winStep = dealerRpsStepForMatch(
      winMessages,
      alice,
      bob,
      'match-rps-1',
    )
    expect(winStep).toBeDefined()
    expect(winStep!.outcome).toBe('win')
    expect(winStep!.payWei).toBe(rpsPayoutWei(wagerWei, 'win'))
    expect(automaticP2pGameSteps(winMessages, alice, bob)).toEqual([])
  })
})
