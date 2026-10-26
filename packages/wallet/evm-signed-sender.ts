import { Transaction } from 'ethers'

/**
 * The sender of exact signed transaction bytes: `Transaction.from(raw).from`, which recovers the
 * signing key (about a millisecond) on every read. Sending one message checks each of its signed
 * transactions' senders at several boundaries (input admission, the submission check); the
 * answer for the same bytes never changes, so it is recovered once and remembered here, by the
 * exact bytes. Null for unsigned bytes. Bounded: cleared when full.
 *
 * The native journal does not read this: it recovers every row's signatures again on reopen.
 * It records what it recovered (`recordSignedTransactionSender`), so the boundaries after it
 * need not recover the same bytes again.
 */
export function signedTransactionSender(
  raw: string,
  parsed: Transaction = Transaction.from(raw),
): string | null {
  const known = senders.get(raw)
  if (known !== undefined) return known
  const sender = parsed.from
  if (senders.size >= SENDERS_KEPT) senders.clear()
  senders.set(raw, sender)
  return sender
}

/** Records the sender a full recovery of these exact bytes found. */
export function recordSignedTransactionSender(raw: string, sender: string): void {
  if (senders.has(raw)) return
  if (senders.size >= SENDERS_KEPT) senders.clear()
  senders.set(raw, sender)
}

const senders = new Map<string, string | null>()
const SENDERS_KEPT = 4096
