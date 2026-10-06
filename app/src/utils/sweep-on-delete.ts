import { getBytes } from 'ethers'
import { deriveMonadStampChildPrivate } from '@frank/wallet/monad-stamp-stealth'
import {
  sweepRecoveredMonadStampPayment,
  type RecoveredMonadStampPayment,
} from '@frank/wallet/monad-stamp-client'
import { relayChangeAddressPublicKey } from '@frank/cashweb/relay'
import type RelayClient from '@frank/cashweb/relay'
import type { WalletHandle } from '@frank/wallet/chain'
import type { Wallet as LotusWallet } from '@frank/cashweb/legacy-wallet'
import { useMonadWallet, useWallet } from './clients'
import { accountSession } from '../accounts/session'
import type { ChatMessage } from '../stores/chats'

export interface SweepOnDeleteOutcome {
  sweptCount: number
  sweptWei: bigint
  changeAddress?: string
  txHashes: string[]
}

/**
 * Strips '0x' prefix from a hex string if present.
 */
function bareHex(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex
}

/**
 * Safely obtains the active Monad wallet handle from the environment or session.
 */
async function resolveWallet(
  override?: WalletHandle,
): Promise<WalletHandle | undefined> {
  if (override) return override
  try {
    const fromClients = useMonadWallet()
    if (fromClients) return fromClients
  } catch {
    // not available from clients yet
  }
  try {
    const fromSession = await accountSession.getWallet()
    if (fromSession) return fromSession as unknown as WalletHandle
  } catch {
    // not available from session
  }
  return undefined
}

/**
 * Sweeps any spendable funds (Monad stamp payments or Lotus UTXOs) belonging to an incoming
 * message into ephemeral change accounts derived from the seed (e.g. m/44'/60'/0'/1/i for Monad),
 * prior to or when the message is deleted from the relay server and local storage.
 *
 * This preserves the historical Stamp guarantee that message deletion never permanently loses funds.
 */
export async function sweepMessageFundsOnDelete(params: {
  message: ChatMessage
  wallet?: WalletHandle
  relayClient?: RelayClient | null
  lotusWallet?: LotusWallet | null
}): Promise<SweepOnDeleteOutcome> {
  const { message } = params
  const outcome: SweepOnDeleteOutcome = {
    sweptCount: 0,
    sweptWei: 0n,
    txHashes: [],
  }

  // 1. Guard against nonexistent messages, outgoing messages, or already swept messages.
  // Inbound messages are those where the user is the recipient of the funds.
  if (!message || message.outbound || (message as any).fundsSwept) {
    return outcome
  }

  // 2. Monad Stamp Payments:
  if (message.stampPayments && message.stampPayments.length > 0) {
    const wallet = await resolveWallet(params.wallet)
    if (wallet) {
      // Determine destination ephemeral change address derived from the seed:
      // m/44'/60'/0'/1/i via wallet.changePool
      let changeAddress: string | undefined
      let changeIndex: number | undefined

      if (
        wallet.changePool &&
        typeof wallet.changePool.peekNextChangeAddress === 'function'
      ) {
        const nextChange = wallet.changePool.peekNextChangeAddress()
        changeAddress = nextChange.address
        changeIndex = nextChange.index
      } else if (wallet.identity) {
        changeAddress =
          (wallet.identity as any).displayAddress ??
          (wallet.identity as any).address?.raw
      }

      if (!changeAddress) {
        try {
          changeAddress = await accountSession.getChainAddress('monad')
        } catch {
          // ignore fallback error
        }
      }

      const privKeyHex =
        (wallet.identity as any)?.toPrivateKeyHex?.() ??
        (wallet as any).privateKey
      if (changeAddress && privKeyHex && wallet.provider && wallet.httpClient) {
        outcome.changeAddress = changeAddress
        const rawDigest = message.payloadDigest.startsWith('0x')
          ? message.payloadDigest
          : `0x${message.payloadDigest}`
        const payloadHash = getBytes(rawDigest)
        const recipientPrivateKey = getBytes(privKeyHex)

        for (let i = 0; i < message.stampPayments.length; i++) {
          const payment = message.stampPayments[i]
          const childIndex = (payment as any).childIndex ?? i

          try {
            const child = deriveMonadStampChildPrivate({
              payloadHash,
              recipientPrivateKey,
              paymentIndex: childIndex,
            })

            const recovered: RecoveredMonadStampPayment = {
              childIndex,
              address: child.address,
              privateKey: child.privateKey,
              txHash: payment.txHash,
              valueWei: payment.valueWei,
            }

            const sweepOutcome = await sweepRecoveredMonadStampPayment({
              payment: recovered,
              destinationAddress: changeAddress,
              provider: wallet.provider,
              httpClient: wallet.httpClient,
            })

            if (sweepOutcome.swept) {
              outcome.sweptCount++
              outcome.sweptWei += sweepOutcome.valueWei
              outcome.txHashes.push(sweepOutcome.txHash)

              // Advance change account index in change pool
              if (
                changeIndex !== undefined &&
                wallet.changePool &&
                typeof wallet.changePool.setNextUnusedIndex === 'function'
              ) {
                changeIndex++
                try {
                  wallet.changePool.setNextUnusedIndex(changeIndex)
                } catch {
                  // ignore if store manages own advancement
                }
              }

              // Update durable stamp payment journal if available
              if (wallet.stampPaymentJournal) {
                const existing = wallet.stampPaymentJournal.get(
                  bareHex(message.payloadDigest),
                  childIndex,
                )
                if (existing) {
                  await wallet.stampPaymentJournal.put({
                    ...existing,
                    status: 'swept',
                    sweepTxHash: sweepOutcome.txHash,
                    sweepValueWei: sweepOutcome.valueWei.toString(),
                    sweepDestinationAddress: changeAddress,
                  })
                }
              }
            }
          } catch (paymentErr) {
            console.error(
              `Failed to sweep Monad stamp payment for child ${childIndex} of message ${message.payloadDigest}:`,
              paymentErr,
            )
          }
        }
      }
    }
  }

  // 3. Lotus Legacy Outpoints:
  if (message.outpoints && message.outpoints.length > 0) {
    let lotusWallet = params.lotusWallet ?? (params.relayClient as any)?.wallet
    if (!lotusWallet) {
      try {
        lotusWallet = useWallet()
      } catch {
        // no legacy wallet loaded
      }
    }

    if (lotusWallet?.changeKeys && lotusWallet.changeKeys.length > 0) {
      try {
        const randomChangeIdx =
          (lotusWallet.changeKeys.length * Math.random()) << 0
        const changeKey = lotusWallet.changeKeys[randomChangeIdx]
        const compressed =
          (changeKey.privKey as unknown as { compressed?: boolean })
            ?.compressed ?? true

        await lotusWallet.forwardUTXOsToPubkey({
          utxos: message.outpoints,
          pubkey: relayChangeAddressPublicKey(
            Uint8Array.from(changeKey.privKey.toBuffer()),
            compressed,
          ),
        })
        outcome.sweptCount += message.outpoints.length
      } catch (lotusErr) {
        console.error(
          `Failed to forward Lotus UTXOs for message ${message.payloadDigest}:`,
          lotusErr,
        )
      }
    }
  }

  // Mark message funds as swept on this in-memory object to prevent re-sweep
  ;(message as any).fundsSwept = true

  return outcome
}
