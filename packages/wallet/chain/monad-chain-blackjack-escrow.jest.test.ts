/**
 * Two real typed wallets play complete blackjack hands with 2-party threshold
 * ECDSA joint escrow on Monad testnet.
 *
 * Backed by `@frank/joint-signer` (Silence-DKLs23 WASM):
 *  1. Two parties run threshold keygen to establish a 2-of-2 EVM escrow address.
 *  2. Both parties fund the escrow on Monad testnet (player bet, dealer cover).
 *  3. Cards are played out using shared entropy.
 *  4. At showdown, both parties cooperatively sign an EIP-1559 settlement transaction
 *     transferring the winnings to the winner.
 *  5. The signed raw transaction is broadcast to the Monad RPC node (simulated here by
 *     the offline chain provider) and confirmed on-chain.
 */
import {
  START_BALANCE,
  STAMP,
  mockBalances,
  table,
  type Seat,
} from './canonical-two-wallets.testutil'
import {
  deriveEscrowStealthPayout,
  registerEscrowStealthPayout,
} from '../game-escrow'
import {
  BlackjackEscrowParty,
  computeEscrowFunding,
  computeSettlementPayout,
} from '../message-item-plugins/blackjack/escrow'
import {
  buildAccept,
  buildBet,
  buildChallenge,
  dealerStep,
  handView,
  playerMoves,
  playerStep,
  seedFromBytes,
  type HandItem,
  type HandRole,
  type HandState,
} from '../message-item-plugins/blackjack/hand'
import { Transaction } from 'ethers'

jest.mock('../monad-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../monad-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)

// Scripted deck for deterministic card draws
let mockScriptedDeck: number[] | undefined
jest.mock('../message-item-plugins/blackjack/entropy', () => {
  const actual = jest.requireActual('../message-item-plugins/blackjack/entropy')
  return {
    ...actual,
    drawCard: (...args: [string, number, string, string, number[]]) =>
      mockScriptedDeck ? mockScriptedDeck[args[1]] : actual.drawCard(...args),
  }
})

function deckStarting(...first: number[]): number[] {
  return [...first, ...Array.from({ length: 52 }, (_, i) => i).filter(c => !first.includes(c))]
}

const RESERVE = 10n ** 16n
let games = 0
let seedCounter = 0
const freshSeed = () =>
  seedFromBytes(new Uint8Array(32).fill(0).map((_, i) => (i === 0 ? ++seedCounter : i * 7) & 255))

describe('Blackjack with 2-party threshold ECDSA escrow settlement', () => {
  jest.setTimeout(60_000)
  let f: Awaited<ReturnType<typeof table>>['f']
  let alice: Seat
  let bob: Seat

  beforeEach(async () => {
    ;({ f, alice, bob } = await table())
  })
  afterEach(() => f.close())

  const WAGER = 100_000_000_000_000_000n // 0.1 MON

  it('runs keygen, funds joint escrow, plays hand, and threshold-settles player win on-chain', async () => {
    // Player win: player 19 vs dealer 17
    mockScriptedDeck = deckStarting(9, 35, 22, 6)

    const gameId = (++games).toString(16).padStart(32, '0')
    const playerSeat = alice
    const dealerSeat = bob

    // --- Phase 1: Two-Party Threshold Keygen ---
    const playerEscrow = new BlackjackEscrowParty({
      role: 'initiator',
      gameId,
      partyName: 'alice-player',
      peerName: 'bob-dealer',
    })
    const dealerEscrow = new BlackjackEscrowParty({
      role: 'responder',
      gameId,
      partyName: 'bob-dealer',
      peerName: 'alice-player',
    })

    let keygenMsg = playerEscrow.startKeygen()
    dealerEscrow.startKeygen()

    let toDealer = true
    while (keygenMsg !== null) {
      keygenMsg = toDealer
        ? dealerEscrow.stepKeygen(keygenMsg)
        : playerEscrow.stepKeygen(keygenMsg)
      toDealer = !toDealer
    }

    const escrowAddress = playerEscrow.getEscrowAddress()
    expect(escrowAddress).toBe(dealerEscrow.getEscrowAddress())

    // --- Phase 2: Escrow Funding on Chain ---
    const playerReceiveAddress = (await playerSeat.wallet.getReceiveAddress()).raw
    const dealerReceiveAddress = (await dealerSeat.wallet.getReceiveAddress()).raw

    const funding = computeEscrowFunding(WAGER)
    // Transfer player deposit into escrowAddress
    const playerBalBefore = mockBalances.get(playerReceiveAddress.toLowerCase()) ?? START_BALANCE
    mockBalances.set(playerReceiveAddress.toLowerCase(), playerBalBefore - funding.playerDepositWei)
    mockBalances.set(escrowAddress.toLowerCase(), funding.playerDepositWei)

    // Transfer dealer cover into escrowAddress
    const dealerBalBefore = mockBalances.get(dealerReceiveAddress.toLowerCase()) ?? START_BALANCE
    mockBalances.set(dealerReceiveAddress.toLowerCase(), dealerBalBefore - funding.dealerCoverWei)
    mockBalances.set(
      escrowAddress.toLowerCase(),
      (mockBalances.get(escrowAddress.toLowerCase()) ?? 0n) + funding.dealerCoverWei,
    )

    expect(mockBalances.get(escrowAddress.toLowerCase())).toBe(funding.totalEscrowWei)

    // --- Phase 3: Play Hand via Shared Entropy ---
    const dealerSeed = freshSeed()
    dealerSeat.seeds.set(gameId, dealerSeed)

    const challenge = buildChallenge({
      gameId,
      role: 'dealer',
      maxBetWei: WAGER * 2n,
      spendableWei: await dealerSeat.balance(),
      reserveWei: RESERVE,
      seed: dealerSeed,
    })
    if ('error' in challenge) throw new Error(challenge.error)
    await dealerSeat.send(challenge.item)
    await playerSeat.poll()

    const playerSeed = freshSeed()
    playerSeat.seeds.set(gameId, playerSeed)

    // Bet message carries zero or nominal stamp since funding is in joint escrow
    await playerSeat.send(buildBet(playerSeat.hand(gameId), playerSeed)!, STAMP)
    await dealerSeat.poll()

    // Dealer deals
    const dealStep = dealerStep(dealerSeat.hand(gameId), dealerSeed)!
    await dealerSeat.send(dealStep.item, STAMP)
    await playerSeat.poll()

    // Player stands
    const standStep = playerStep(playerSeat.hand(gameId), 'stand', playerSeed)!
    await playerSeat.send(standStep, STAMP)
    await dealerSeat.poll()

    // Dealer reveals
    const revealStep = dealerStep(dealerSeat.hand(gameId), dealerSeed)!
    await dealerSeat.send(revealStep.item, STAMP)
    await playerSeat.poll()

    const finalState = playerSeat.hand(gameId)!
    expect(finalState.phase).toBe('resolved')
    expect(finalState.outcome).toBe('player_win')

    // --- Phase 4: Cooperative Threshold Settlement at Showdown ---
    const payout = computeSettlementPayout({
      outcome: finalState.outcome!,
      wagerWei: WAGER,
      dealerCoverWei: funding.dealerCoverWei,
    })
    expect(payout.playerPayoutWei).toBe(WAGER * 2n)

    // Both parties construct the settlement transaction paying the player from escrowAddress
    const settlementTx = playerEscrow.createSettlementTx({
      to: playerReceiveAddress,
      valueWei: payout.playerPayoutWei,
      nonce: 0,
    })
    dealerEscrow.createSettlementTx({
      to: playerReceiveAddress,
      valueWei: payout.playerPayoutWei,
      nonce: 0,
    })

    // Run threshold signing session
    let signMsg = playerEscrow.startSettlementSigning()
    dealerEscrow.startSettlementSigning()

    toDealer = true
    while (signMsg !== null) {
      signMsg = toDealer
        ? dealerEscrow.stepSettlementSigning(signMsg)
        : playerEscrow.stepSettlementSigning(signMsg)
      toDealer = !toDealer
    }

    const rawSignedTx = playerEscrow.getSignedRawTx()
    expect(rawSignedTx).toBe(dealerEscrow.getSignedRawTx())

    // --- Phase 5: Broadcast to Chain & Verify On-Chain Settlement ---
    // Submit raw signed transaction through the wallet's Monad HTTP client
    const txHash = await playerSeat.wallet.httpClient.submitRawTransaction(rawSignedTx)

    expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/)

    // Verify on-chain balances updated:
    // Escrow address was debited
    expect(mockBalances.get(escrowAddress.toLowerCase())).toBe(
      funding.totalEscrowWei - payout.playerPayoutWei,
    )
    // Player address was credited with the full winnings (2 * wager) minus tiny gas fees for messages
    const playerBalAfter = mockBalances.get(playerReceiveAddress.toLowerCase())!
    expect(playerBalAfter).toBeGreaterThan(playerBalBefore)
    expect(playerBalAfter).toBeLessThanOrEqual(
      playerBalBefore - funding.playerDepositWei + payout.playerPayoutWei,
    )

    // Verify decoded transaction fields from broadcast
    const parsedTx = Transaction.from(rawSignedTx)
    expect(parsedTx.from?.toLowerCase()).toBe(escrowAddress.toLowerCase())
    expect(parsedTx.to?.toLowerCase()).toBe(playerReceiveAddress.toLowerCase())
    expect(parsedTx.value).toBe(payout.playerPayoutWei)
  })

  it('cooperatively settles a dealer win on-chain', async () => {
    // Dealer win: player 15 vs dealer 20
    mockScriptedDeck = deckStarting(9, 35, 6, 22)

    const gameId = (++games).toString(16).padStart(32, '0')
    const playerSeat = alice
    const dealerSeat = bob

    const playerEscrow = new BlackjackEscrowParty({
      role: 'initiator',
      gameId,
      partyName: 'alice-player',
      peerName: 'bob-dealer',
    })
    const dealerEscrow = new BlackjackEscrowParty({
      role: 'responder',
      gameId,
      partyName: 'bob-dealer',
      peerName: 'alice-player',
    })

    let keygenMsg = playerEscrow.startKeygen()
    dealerEscrow.startKeygen()
    let toDealer = true
    while (keygenMsg !== null) {
      keygenMsg = toDealer
        ? dealerEscrow.stepKeygen(keygenMsg)
        : playerEscrow.stepKeygen(keygenMsg)
      toDealer = !toDealer
    }

    const escrowAddress = playerEscrow.getEscrowAddress()
    const funding = computeEscrowFunding(WAGER)
    const dealerReceiveAddress = (await dealerSeat.wallet.getReceiveAddress()).raw

    mockBalances.set(escrowAddress.toLowerCase(), funding.totalEscrowWei)
    const dealerBalBefore = mockBalances.get(dealerReceiveAddress.toLowerCase()) ?? START_BALANCE

    const payout = computeSettlementPayout({
      outcome: 'dealer_win',
      wagerWei: WAGER,
      dealerCoverWei: funding.dealerCoverWei,
    })
    expect(payout.playerPayoutWei).toBe(0n)
    expect(payout.dealerPayoutWei).toBe(funding.totalEscrowWei)

    // Construct settlement paying dealer
    playerEscrow.createSettlementTx({
      to: dealerReceiveAddress,
      valueWei: payout.dealerPayoutWei,
      nonce: 0,
    })
    dealerEscrow.createSettlementTx({
      to: dealerReceiveAddress,
      valueWei: payout.dealerPayoutWei,
      nonce: 0,
    })

    let signMsg = playerEscrow.startSettlementSigning()
    dealerEscrow.startSettlementSigning()
    toDealer = true
    while (signMsg !== null) {
      signMsg = toDealer
        ? dealerEscrow.stepSettlementSigning(signMsg)
        : playerEscrow.stepSettlementSigning(signMsg)
      toDealer = !toDealer
    }

    const rawSignedTx = playerEscrow.getSignedRawTx()
    const txHash = await dealerSeat.wallet.httpClient.submitRawTransaction(rawSignedTx)

    expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/)
    expect(mockBalances.get(escrowAddress.toLowerCase())).toBe(0n)
    expect(mockBalances.get(dealerReceiveAddress.toLowerCase())).toBe(dealerBalBefore + funding.totalEscrowWei)
  })

  it('settles a player win directly to a one-time DKSAP stealth address, indexed in player stealthKeyring', async () => {
    // Player win: player 19 vs dealer 17
    mockScriptedDeck = deckStarting(9, 35, 22, 6)

    const gameId = (++games).toString(16).padStart(32, '0')
    const playerSeat = alice
    const dealerSeat = bob

    const playerEscrow = new BlackjackEscrowParty({
      role: 'initiator',
      gameId,
      partyName: 'alice-player',
      peerName: 'bob-dealer',
    })
    const dealerEscrow = new BlackjackEscrowParty({
      role: 'responder',
      gameId,
      partyName: 'bob-dealer',
      peerName: 'alice-player',
    })

    let keygenMsg = playerEscrow.startKeygen()
    dealerEscrow.startKeygen()
    let toDealer = true
    while (keygenMsg !== null) {
      keygenMsg = toDealer
        ? dealerEscrow.stepKeygen(keygenMsg)
        : playerEscrow.stepKeygen(keygenMsg)
      toDealer = !toDealer
    }

    const escrowAddress = playerEscrow.getEscrowAddress()
    const funding = computeEscrowFunding(WAGER)
    mockBalances.set(escrowAddress.toLowerCase(), funding.totalEscrowWei)

    // Play blackjack game
    const dealerSeed = freshSeed()
    dealerSeat.seeds.set(gameId, dealerSeed)
    const challenge = buildChallenge({
      gameId,
      role: 'dealer',
      maxBetWei: WAGER * 2n,
      spendableWei: await dealerSeat.balance(),
      reserveWei: RESERVE,
      seed: dealerSeed,
    })
    if ('error' in challenge) throw new Error(challenge.error)
    await dealerSeat.send(challenge.item)
    await playerSeat.poll()

    const playerSeed = freshSeed()
    playerSeat.seeds.set(gameId, playerSeed)
    await playerSeat.send(buildBet(playerSeat.hand(gameId), playerSeed)!, STAMP)
    await dealerSeat.poll()

    const dealStep = dealerStep(dealerSeat.hand(gameId), dealerSeed)!
    await dealerSeat.send(dealStep.item, STAMP)
    await playerSeat.poll()

    const standStep = playerStep(playerSeat.hand(gameId), 'stand', playerSeed)!
    await playerSeat.send(standStep, STAMP)
    await dealerSeat.poll()

    const revealStep = dealerStep(dealerSeat.hand(gameId), dealerSeed)!
    await dealerSeat.send(revealStep.item, STAMP)
    await playerSeat.poll()

    const finalState = playerSeat.hand(gameId)!
    expect(finalState.outcome).toBe('player_win')

    const payout = computeSettlementPayout({
      outcome: finalState.outcome!,
      wagerWei: WAGER,
      dealerCoverWei: funding.dealerCoverWei,
    })

    // Winner derives fresh DKSAP stealth address for payout
    const stealthPayout = deriveEscrowStealthPayout({
      recipientSpendPubKey: playerSeat.wallet.identity.compressedPubKey,
    })

    // Both parties construct settlement transaction targeting the one-time stealth address
    playerEscrow.createSettlementTx({
      to: stealthPayout.stealthAddress,
      valueWei: payout.playerPayoutWei,
      nonce: 0,
    })
    dealerEscrow.createSettlementTx({
      to: stealthPayout.stealthAddress,
      valueWei: payout.playerPayoutWei,
      nonce: 0,
    })

    let signMsg = playerEscrow.startSettlementSigning()
    dealerEscrow.startSettlementSigning()
    toDealer = true
    while (signMsg !== null) {
      signMsg = toDealer
        ? dealerEscrow.stepSettlementSigning(signMsg)
        : playerEscrow.stepSettlementSigning(signMsg)
      toDealer = !toDealer
    }

    const rawSignedTx = playerEscrow.getSignedRawTx()
    const txHash = await playerSeat.wallet.httpClient.submitRawTransaction(rawSignedTx)

    expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/)
    expect(mockBalances.get(stealthPayout.stealthAddress.toLowerCase())).toBe(payout.playerPayoutWei)

    // Player registers/indexes the stealth payout into stealthKeyring
    const stealthRecord = await registerEscrowStealthPayout({
      wallet: playerSeat.wallet,
      ephemeralPubKey: stealthPayout.ephemeralPubKey,
      stealthAddress: stealthPayout.stealthAddress,
      payoutWei: payout.playerPayoutWei,
      txHash,
      networkTag: 'MONT',
    })

    expect(stealthRecord.address.toLowerCase()).toBe(stealthPayout.stealthAddress.toLowerCase())
    expect(playerSeat.wallet.stealthKeyring.hasAccount(stealthPayout.stealthAddress)).toBe(true)

    // Player's total balance includes this stealth account
    const totalBal = await playerSeat.wallet.getBalance()
    expect(totalBal).toBeGreaterThanOrEqual(payout.playerPayoutWei)

    // Player can spend from this stealth account directly without sweeping
    const spendable = await playerSeat.wallet.stealthKeyring.selectAccountForSpend(
      WAGER,
      playerSeat.wallet.provider,
      'MONT',
    )
    expect(spendable).toBeDefined()
    expect(spendable?.address.toLowerCase()).toBe(stealthPayout.stealthAddress.toLowerCase())
  })
})
