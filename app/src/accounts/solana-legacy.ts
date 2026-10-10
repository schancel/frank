/**
 * Composition for the Solana wallet's legacy transactions (calls to a program, such as a swap):
 * where the wallet journals them on this device, and how its sync event reaches the account's
 * other frontends.
 *
 * The wallet owns the facts: it journals the signed bytes with the record before broadcasting
 * and raises the sync event once the chain has finalised the transaction. This module only
 * wires that event to the account's free note to itself, the same note a native send and an
 * EVM swap use, and offers the journal to whoever needs to read it.
 */
import { keccak256, getBytes, toUtf8Bytes } from 'ethers'
import { activeChain } from '@frank/wallet/chain'
import {
  BrowserSolanaLegacyJournal,
  type SolanaLegacyJournal,
  type SolanaLegacySync,
} from '@frank/wallet/solana-swap'
import { accountSession } from './session'

let journal: SolanaLegacyJournal | undefined

/** This device's journal of the Solana wallet's legacy transactions. */
export function solanaLegacyJournal(): SolanaLegacyJournal {
  journal ??= new BrowserSolanaLegacyJournal(window.localStorage)
  return journal
}

/**
 * The wallet's sync event, delivered: a free message (no stamp) from the account to its own
 * mailbox carrying the swap's record. The message's identity is fixed by the chain and the
 * transaction, so a repeat is the same message. Rejects when the note could not be sent; the
 * wallet then keeps it owed and offers it again at the next open.
 */
export const sendSolanaLegacySyncNote: SolanaLegacySync = async item => {
  const wallet = await accountSession.getWallet()
  try {
    await activeChain.directMessages.send({
      wallet,
      recipient: { raw: wallet.identity.address.raw },
      // Only the record: Solana has no account pool for a wallet-sync item to update.
      items: [item],
      stampValue: 0n,
      messageId: getBytes(
        keccak256(
          toUtf8Bytes(
            `frank-wallet-sync:${item.chainIdentifier}:${item.txHash}`,
          ),
        ),
      ).slice(0, 16),
    })
  } catch (error) {
    // This wallet has already sent this exact note.
    if (
      error instanceof Error &&
      error.name === 'DirectMessageAlreadyAttemptedError'
    )
      return
    throw error
  }
}

/** What the Solana wallet is constructed with so that it can make legacy sends. */
export function solanaLegacyWiring(): {
  journal: SolanaLegacyJournal
  onSync: SolanaLegacySync
} {
  return { journal: solanaLegacyJournal(), onSync: sendSolanaLegacySyncNote }
}
