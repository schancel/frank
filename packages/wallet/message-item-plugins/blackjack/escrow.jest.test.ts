/**
 * Test suite for 2-party threshold ECDSA blackjack escrow.
 * Uses `@frank/joint-signer` with Silence-DKLs23 WASM backend.
 */
import { Transaction, Wallet } from 'ethers'
import {
  BlackjackEscrowParty,
  computeEscrowFunding,
  computeSettlementPayout,
} from './escrow'
import { MONAD_TESTNET_CHAIN_ID } from './evm'

describe('Blackjack joint escrow with threshold ECDSA', () => {
  jest.setTimeout(30_000)

  const WAGER = 50_000_000_000_000_000n // 0.05 MON

  describe('escrow funding and settlement calculation', () => {
    it('computes correct funding amounts for player and dealer', () => {
      const funding = computeEscrowFunding(WAGER)
      expect(funding.playerDepositWei).toBe(WAGER)
      expect(funding.dealerCoverWei).toBe((WAGER * 3n) / 2n)
      expect(funding.totalEscrowWei).toBe(WAGER + (WAGER * 3n) / 2n)
    })

    it('calculates player blackjack payout (3:2)', () => {
      const payout = computeSettlementPayout({
        outcome: 'player_blackjack',
        wagerWei: WAGER,
      })
      expect(payout.playerPayoutWei).toBe(WAGER + (WAGER * 3n) / 2n)
      expect(payout.dealerPayoutWei).toBe(0n)
    })

    it('calculates player regular win payout (1:1)', () => {
      const payout = computeSettlementPayout({
        outcome: 'player_win',
        wagerWei: WAGER,
      })
      expect(payout.playerPayoutWei).toBe(WAGER * 2n)
      // Unused cover returns to dealer:
      expect(payout.dealerPayoutWei).toBe((WAGER * 3n) / 2n - WAGER)
    })

    it('calculates push (tie refund)', () => {
      const payout = computeSettlementPayout({
        outcome: 'push',
        wagerWei: WAGER,
      })
      expect(payout.playerPayoutWei).toBe(WAGER)
      expect(payout.dealerPayoutWei).toBe((WAGER * 3n) / 2n)
    })

    it('calculates dealer win (dealer keeps all)', () => {
      const payout = computeSettlementPayout({
        outcome: 'dealer_win',
        wagerWei: WAGER,
      })
      expect(payout.playerPayoutWei).toBe(0n)
      expect(payout.dealerPayoutWei).toBe(WAGER + (WAGER * 3n) / 2n)
    })
  })

  describe('2-party threshold keygen and settlement signing session', () => {
    const gameId = 'a1b2c3d4e5f60102030405060708090a'
    const playerWallet = Wallet.createRandom()
    const dealerWallet = Wallet.createRandom()

    let player: BlackjackEscrowParty
    let dealer: BlackjackEscrowParty

    beforeEach(() => {
      player = new BlackjackEscrowParty({
        role: 'initiator',
        gameId,
        partyName: 'alice-player',
        peerName: 'bob-dealer',
      })
      dealer = new BlackjackEscrowParty({
        role: 'responder',
        gameId,
        partyName: 'bob-dealer',
        peerName: 'alice-player',
      })
    })

    it('runs keygen and derives identical 2-of-2 EVM address on both sides', () => {
      let msg = player.startKeygen()
      expect(dealer.startKeygen()).toBeNull()

      let toDealer = true
      let rounds = 0
      while (msg !== null && rounds < 20) {
        rounds++
        if (toDealer) {
          msg = dealer.stepKeygen(msg)
          toDealer = false
        } else {
          msg = player.stepKeygen(msg)
          toDealer = true
        }
      }

      expect(player.getPhase()).toBe('funded')
      expect(dealer.getPhase()).toBe('funded')

      const playerEscrowAddress = player.getEscrowAddress()
      const dealerEscrowAddress = dealer.getEscrowAddress()

      expect(playerEscrowAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)
      expect(playerEscrowAddress).toBe(dealerEscrowAddress)
      expect(playerEscrowAddress.toLowerCase()).not.toBe(playerWallet.address.toLowerCase())
      expect(playerEscrowAddress.toLowerCase()).not.toBe(dealerWallet.address.toLowerCase())
    })

    it('cooperatively signs a settlement transaction that recovers to joint escrow address', () => {
      // 1. Run keygen
      let msg = player.startKeygen()
      dealer.startKeygen()
      let toDealer = true
      while (msg !== null) {
        msg = toDealer ? dealer.stepKeygen(msg) : player.stepKeygen(msg)
        toDealer = !toDealer
      }

      const escrowAddress = player.getEscrowAddress()

      // 2. Prepare settlement tx (paying player who won)
      const payoutWei = WAGER * 2n
      const settlementTx = player.createSettlementTx({
        to: playerWallet.address,
        valueWei: payoutWei,
        nonce: 0,
      })

      // Dealer creates identical settlement tx
      dealer.createSettlementTx({
        to: playerWallet.address,
        valueWei: payoutWei,
        nonce: 0,
      })

      // 3. Cooperatively sign
      let signMsg = player.startSettlementSigning()
      expect(dealer.startSettlementSigning()).toBeNull()

      toDealer = true
      let signRounds = 0
      while (signMsg !== null && signRounds < 20) {
        signRounds++
        if (toDealer) {
          signMsg = dealer.stepSettlementSigning(signMsg)
          toDealer = false
        } else {
          signMsg = player.stepSettlementSigning(signMsg)
          toDealer = true
        }
      }

      expect(player.getPhase()).toBe('settled')
      expect(dealer.getPhase()).toBe('settled')

      // 4. Verify resulting broadcastable signed raw transactions
      const playerRawTx = player.getSignedRawTx()
      const dealerRawTx = dealer.getSignedRawTx()
      expect(playerRawTx).toBe(dealerRawTx)

      // 5. Parse raw transaction with ethers to verify chain parameters and recovered sender
      const parsed = Transaction.from(playerRawTx)
      expect(parsed.from?.toLowerCase()).toBe(escrowAddress.toLowerCase())
      expect(parsed.to?.toLowerCase()).toBe(playerWallet.address.toLowerCase())
      expect(parsed.value).toBe(payoutWei)
      expect(parsed.chainId).toBe(MONAD_TESTNET_CHAIN_ID)
      expect(parsed.nonce).toBe(0)
      expect(parsed.signature).toBeDefined()
    })
  })
})
