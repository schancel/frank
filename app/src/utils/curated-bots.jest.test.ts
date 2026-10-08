/** @jest-environment jsdom */
import { inferCuratedBotAttributes } from './curated-bots'

describe('curated-bots.ts', () => {
  it('infers game role for blackjack dealer, raffle, poker, dice, rps', () => {
    expect(inferCuratedBotAttributes('Blackjack Dealer')).toEqual({
      accountType: 1,
      botRole: 3,
      isBot: true,
    })
    expect(inferCuratedBotAttributes('Raffle')).toEqual({
      accountType: 1,
      botRole: 3,
      isBot: true,
    })
    expect(inferCuratedBotAttributes("Texas Hold'em Poker")).toEqual({
      accountType: 1,
      botRole: 3,
      isBot: true,
    })
    expect(inferCuratedBotAttributes('Satoshi Dice')).toEqual({
      accountType: 1,
      botRole: 3,
      isBot: true,
    })
    expect(inferCuratedBotAttributes("Liar's Dice (Perudo)")).toEqual({
      accountType: 1,
      botRole: 3,
      isBot: true,
    })
    expect(inferCuratedBotAttributes('RPS Arena')).toEqual({
      accountType: 1,
      botRole: 3,
      isBot: true,
    })
  })

  it('infers faucet service for Monad Faucet', () => {
    expect(inferCuratedBotAttributes('Monad Faucet')).toEqual({
      accountType: 2,
      botRole: 2,
      isBot: false,
    })
  })

  it('infers AI assistant for Qwen', () => {
    expect(inferCuratedBotAttributes('Qwen')).toEqual({
      accountType: 1,
      botRole: 1,
      isBot: true,
    })
  })

  it('infers merchant for Picture Shop', () => {
    expect(inferCuratedBotAttributes('Picture Shop')).toEqual({
      accountType: 1,
      botRole: 5,
      isBot: true,
    })
  })

  it('infers moderator for Lobby', () => {
    expect(inferCuratedBotAttributes('Lobby')).toEqual({
      accountType: 1,
      botRole: 6,
      isBot: true,
    })
  })

  it('returns empty for ordinary non-bot name', () => {
    expect(inferCuratedBotAttributes('Alice')).toEqual({})
    expect(inferCuratedBotAttributes('')).toEqual({})
  })
})
