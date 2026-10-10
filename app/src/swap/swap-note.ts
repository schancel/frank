/**
 * The note to self that records a swap: a free message (no stamp) from the account to its own
 * mailbox carrying a `swap-record` item, sent the way a native send notes itself. Every
 * frontend of the account reads it back and shows the same swap; a reload or a new device
 * rebuilds the history from it.
 *
 * The message's identity is fixed by the swap's chain and transaction, so sending it again is
 * the same message, not a second one.
 */
import { keccak256, toUtf8Bytes, getBytes } from 'ethers'
import { activeChain } from '@frank/wallet/chain'
import { accountSession } from 'src/accounts/session'
import { swapRecordItem, type SwapRecord } from 'src/stores/swaps'

export function swapNoteMessageId(record: SwapRecord): Uint8Array {
  return getBytes(
    keccak256(
      toUtf8Bytes(
        `frank-swap-record:${record.chainIdentifier ?? record.chain}:${
          record.txHash
        }`,
      ),
    ),
  ).slice(0, 16)
}

/** Sends the note. Resolves when the relay has it, including when it already had it. */
export async function sendSwapNote(record: SwapRecord): Promise<void> {
  const wallet = await accountSession.getWallet()
  try {
    await activeChain.directMessages.send({
      wallet,
      recipient: { raw: wallet.identity.address.raw },
      items: [swapRecordItem(record)],
      stampValue: 0n,
      messageId: swapNoteMessageId(record),
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
