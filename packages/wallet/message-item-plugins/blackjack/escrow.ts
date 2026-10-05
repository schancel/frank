/**
 * Two-party threshold ECDSA escrow for trustless peer-to-peer Blackjack.
 *
 * Backed by `@frank/joint-signer` (Silence-DKLs23 WebAssembly and Frank-Lindell backends).
 * Neither party ever holds the private key alone:
 *  1. Key generation produces a single 2-of-2 EVM address on Monad testnet.
 *  2. Both parties fund the joint address (player stakes bet, dealer stakes cover).
 *  3. After the cards are played out via shared entropy, both parties cooperatively
 *     sign an EIP-1559 settlement transaction transferring the funds to the winner.
 *  4. The signed transaction is broadcast to the Monad RPC node and confirmed on-chain.
 */
import { randomBytes as cryptoRandomBytes } from 'crypto'
import {
  getBytes,
  hexlify,
  Transaction,
  type Provider,
} from 'ethers'
import { loadSilenceDklsNode } from '@frank/joint-signer/src/silence-dkls/load-node.js'
import type {
  JointKey,
  JointSignature,
  JointSigner,
  KeygenSession,
  Role,
  SignSession,
} from '@frank/joint-signer'
import { addressOf, digestOf, signedRawTx, transferTx, verifySignedTxSender } from './evm'
import type { BlackjackOutcome } from './game'

export type EscrowPhase =
  | 'idle'
  | 'keygen'
  | 'funded'
  | 'signing_settlement'
  | 'settled'
  | 'aborted'

export interface EscrowFundingAmounts {
  /** The player's wager stake. */
  playerDepositWei: bigint
  /** The dealer's cover stake (1.5x wager for 3:2 blackjack payout). */
  dealerCoverWei: bigint
  /** Total value expected in the joint escrow address. */
  totalEscrowWei: bigint
}

export function computeEscrowFunding(wagerWei: bigint): EscrowFundingAmounts {
  const dealerCoverWei = (wagerWei * 3n) / 2n
  return {
    playerDepositWei: wagerWei,
    dealerCoverWei,
    totalEscrowWei: wagerWei + dealerCoverWei,
  }
}

export interface PayoutDistribution {
  playerPayoutWei: bigint
  dealerPayoutWei: bigint
}

export function computeSettlementPayout(params: {
  outcome: BlackjackOutcome
  wagerWei: bigint
  dealerCoverWei?: bigint
  gasReserveWei?: bigint
}): PayoutDistribution {
  const cover = params.dealerCoverWei ?? (params.wagerWei * 3n) / 2n
  const gas = params.gasReserveWei ?? 0n

  switch (params.outcome) {
    case 'player_blackjack': {
      // 3:2 payout: player receives wager + 1.5 * wager
      const playerGross = params.wagerWei + (params.wagerWei * 3n) / 2n
      const playerPayoutWei = playerGross > gas ? playerGross - gas : playerGross
      const dealerPayoutWei = cover > (params.wagerWei * 3n) / 2n ? cover - (params.wagerWei * 3n) / 2n : 0n
      return { playerPayoutWei, dealerPayoutWei }
    }
    case 'player_win': {
      // 1:1 payout: player receives wager + wager = 2 * wager
      const playerGross = params.wagerWei * 2n
      const playerPayoutWei = playerGross > gas ? playerGross - gas : playerGross
      const dealerPayoutWei = cover > params.wagerWei ? cover - params.wagerWei : 0n
      return { playerPayoutWei, dealerPayoutWei }
    }
    case 'push': {
      // Tie: each party gets their principal back
      const playerPayoutWei = params.wagerWei > gas / 2n ? params.wagerWei - gas / 2n : params.wagerWei
      const dealerPayoutWei = cover > gas / 2n ? cover - gas / 2n : cover
      return { playerPayoutWei, dealerPayoutWei }
    }
    case 'dealer_win':
    default: {
      // Dealer wins: gets all
      const totalGross = params.wagerWei + cover
      const dealerPayoutWei = totalGross > gas ? totalGross - gas : totalGross
      return { playerPayoutWei: 0n, dealerPayoutWei }
    }
  }
}

export class BlackjackEscrowParty {
  readonly role: Role
  readonly gameId: string
  readonly partyName: string
  readonly peerName: string
  private readonly signer: JointSigner
  private readonly randomBytes: (length: number) => Uint8Array

  private keygenSession?: KeygenSession
  private signSession?: SignSession
  private jointKey?: JointKey
  private escrowAddress?: string
  private settlementTx?: Transaction
  private signedRawTx?: string
  private phase: EscrowPhase = 'idle'

  constructor(params: {
    role: Role
    gameId: string
    partyName: string
    peerName: string
    signer?: JointSigner
    randomBytes?: (length: number) => Uint8Array
  }) {
    this.role = params.role
    this.gameId = params.gameId
    this.partyName = params.partyName
    this.peerName = params.peerName
    this.signer = params.signer ?? loadSilenceDklsNode()
    this.randomBytes = params.randomBytes ?? (len => new Uint8Array(cryptoRandomBytes(len)))
  }

  getPhase(): EscrowPhase {
    return this.phase
  }

  getEscrowAddress(): string {
    if (!this.escrowAddress) {
      throw new Error('Key generation not completed: escrow address unavailable')
    }
    return this.escrowAddress
  }

  getJointKey(): JointKey {
    if (!this.jointKey) {
      throw new Error('Key generation not completed: joint key unavailable')
    }
    return this.jointKey
  }

  getSignedRawTx(): string {
    if (!this.signedRawTx) {
      throw new Error('Settlement signing not completed')
    }
    return this.signedRawTx
  }

  /**
   * Start 2-party threshold key generation session.
   * Returns initial outgoing message (initiator returns non-null bytes, responder returns null).
   */
  startKeygen(): Uint8Array | null {
    const sessionId = getBytes(
      hexlify(
        new TextEncoder().encode(`frank:blackjack:keygen:${this.gameId}`.padEnd(32, '\0')).slice(0, 34),
      ),
    ).slice(0, 32)

    const res = this.signer.startKeygen({
      role: this.role,
      sessionId,
      localId: new TextEncoder().encode(this.partyName),
      peerId: new TextEncoder().encode(this.peerName),
      randomBytes: this.randomBytes,
    })

    if (!res.ok) {
      this.phase = 'aborted'
      throw new Error(`Failed to start keygen: ${res.error.code}`)
    }

    this.keygenSession = res.value.session
    this.phase = 'keygen'

    if (res.value.result) {
      this.recordJointKey(res.value.result)
    }

    return res.value.outgoing
  }

  /**
   * Step 2-party threshold key generation with an incoming protocol message.
   * Returns outgoing message for the peer, or null if keygen is completed.
   */
  stepKeygen(incomingMessage: Uint8Array): Uint8Array | null {
    if (!this.keygenSession) {
      throw new Error('Keygen session not initialized')
    }

    const res = this.signer.keygenStep(this.keygenSession, incomingMessage)
    if (!res.ok) {
      this.phase = 'aborted'
      throw new Error(`Keygen step failed: ${res.error.code}`)
    }

    this.keygenSession = res.value.session
    if (res.value.result) {
      this.recordJointKey(res.value.result)
    }

    return res.value.outgoing
  }

  private recordJointKey(key: JointKey) {
    this.jointKey = key
    const desc = this.signer.describeKey(key)
    if (!desc.ok) {
      throw new Error(`Failed to describe joint key: ${desc.error.code}`)
    }
    this.escrowAddress = addressOf(desc.value.publicKey)
    this.phase = 'funded'
  }

  /**
   * Constructs the settlement payout transaction from the escrow address.
   */
  createSettlementTx(params: {
    to: string
    valueWei: bigint
    nonce?: number
    gasLimit?: bigint
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
  }): Transaction {
    this.settlementTx = transferTx({
      to: params.to,
      valueWei: params.valueWei,
      nonce: params.nonce ?? 0,
      gasLimit: params.gasLimit,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    })
    return this.settlementTx
  }

  /**
   * Starts threshold ECDSA signing session for the settlement transaction.
   * Returns initial outgoing message.
   */
  startSettlementSigning(tx?: Transaction): Uint8Array | null {
    if (!this.jointKey) {
      throw new Error('Joint key required before signing settlement')
    }

    if (tx) {
      this.settlementTx = tx
    }
    if (!this.settlementTx) {
      throw new Error('Settlement transaction must be set before signing')
    }

    const digest = digestOf(this.settlementTx)
    const sessionId = getBytes(
      hexlify(
        new TextEncoder().encode(`frank:blackjack:settle:${this.gameId}`.padEnd(32, '\0')).slice(0, 34),
      ),
    ).slice(0, 32)

    const res = this.signer.startSign({
      key: this.jointKey,
      role: this.role,
      sessionId,
      digest,
      randomBytes: this.randomBytes,
    })

    if (!res.ok) {
      this.phase = 'aborted'
      throw new Error(`Failed to start signing settlement: ${res.error.code}`)
    }

    this.signSession = res.value.session
    this.phase = 'signing_settlement'

    if (res.value.result) {
      this.recordJointSignature(res.value.result)
    }

    return res.value.outgoing
  }

  /**
   * Steps threshold ECDSA signing session with incoming protocol message.
   * Returns next outgoing message, or null when signing is complete.
   */
  stepSettlementSigning(incomingMessage: Uint8Array): Uint8Array | null {
    if (!this.signSession) {
      throw new Error('Signing session not initialized')
    }

    const res = this.signer.signStep(this.signSession, incomingMessage)
    if (!res.ok) {
      this.phase = 'aborted'
      throw new Error(`Settlement sign step failed: ${res.error.code}`)
    }

    this.signSession = res.value.session
    if (res.value.result) {
      this.recordJointSignature(res.value.result)
    }

    return res.value.outgoing
  }

  private recordJointSignature(jointSig: JointSignature) {
    if (!this.settlementTx) {
      throw new Error('Settlement transaction missing')
    }
    this.signedRawTx = signedRawTx(this.settlementTx, jointSig.signature, jointSig.recovery)
    if (this.escrowAddress && !verifySignedTxSender(this.signedRawTx, this.escrowAddress)) {
      throw new Error('Signed transaction sender does not match joint escrow address')
    }
    this.phase = 'settled'
  }
}
