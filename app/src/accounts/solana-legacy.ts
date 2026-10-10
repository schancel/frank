/**
 * Composition for the Solana wallet's legacy transactions (calls to a program, such as a swap):
 * where the wallet journals them on this device, and how its sync event reaches the account's
 * other frontends.
 *
 * The wallet owns the facts: it journals the signed bytes with the record before broadcasting
 * and raises the sync event once the chain has finalised the transaction. This module only
 * wires that event to the account's free note to itself, the same note a native send and an
 * EVM swap use, and offers the journal to whoever needs to read it.
 *
 * A journal is one account's on one network. A note is sent only by the account whose swap it
 * records: after an account switch an unfinished swap's note stays owed in its own account's
 * journal and goes out when that account is open again.
 */
import { keccak256, getBytes, toUtf8Bytes } from 'ethers'
import { activeChain } from '@frank/wallet/chain'
import {
  BrowserSolanaLegacyJournal,
  type SolanaLegacyJournal,
  type SolanaLegacySync,
} from '@frank/wallet/solana-swap'
import { accountSession } from './session'

/** The Solana address of the account that is open now. */
export async function currentSolanaAccount(): Promise<string> {
  return (
    accountSession.getCachedChainAddress?.('solana') ??
    (await accountSession.getChainAddress('solana'))
  )
}

/** This device's journal of one account's legacy transactions on one Solana network. */
export function solanaLegacyJournal(
  account: string,
  chainIdentifier: string,
): SolanaLegacyJournal {
  return new BrowserSolanaLegacyJournal(window.localStorage, {
    account,
    chainIdentifier,
  })
}

/** The open account is not the one whose swap the note records. The note stays owed. */
export class SolanaLegacyNoteForAnotherAccountError extends Error {
  constructor() {
    super(
      'This swap was made by another account; its note is not sent from this one',
    )
    this.name = 'SolanaLegacyNoteForAnotherAccountError'
  }
}

/**
 * The wallet's sync event, delivered: a free message (no stamp) from the account to its own
 * mailbox carrying the swap's record. The message's identity is fixed by the chain and the
 * transaction, so a repeat is the same message. Rejects when the note could not be sent, or
 * when the account now open is not the swap's own; the wallet then keeps it owed and offers it
 * again at that account's next open.
 */
export const sendSolanaLegacySyncNote: SolanaLegacySync = async item => {
  const opened = accountSession.state.revision
  const isSwapsAccount = async () =>
    accountSession.state.revision === opened &&
    (await currentSolanaAccount()) === item.account
  if (!(await isSwapsAccount())) {
    throw new SolanaLegacyNoteForAnotherAccountError()
  }
  const wallet = await accountSession.getWallet()
  // The messaging wallet is whichever account is open: make sure it is still the swap's.
  if (!(await isSwapsAccount())) {
    throw new SolanaLegacyNoteForAnotherAccountError()
  }
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

/** What the Solana wallet of one account on one network is constructed with for legacy sends. */
export function solanaLegacyWiring(
  account: string,
  chainIdentifier: string,
): {
  journal: SolanaLegacyJournal
  onSync: SolanaLegacySync
} {
  return {
    journal: solanaLegacyJournal(account, chainIdentifier),
    onSync: sendSolanaLegacySyncNote,
  }
}
