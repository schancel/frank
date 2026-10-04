import { deserializeMessageItems } from '@frank/wallet/chain/monad-chain'

/** Extracts the user's prompt from a decrypted envelope plaintext, or `undefined` when the
 * message carries nothing a human typed.
 *
 * The real UI wraps plaintext as a JSON array of `MessageItem`. Only `text` items are prompts.
 * Structured items (catalog, raffle round status, dealer moves, error items) must never be fed to
 * the model: an earlier version fell back to the raw JSON when no text item existed, so bot output
 * was quoted back and answered, feeding the bot ping-pong (#311). A payload that is not a JSON
 * array at all is the legacy bare-string convention and is used as-is. */
export function extractPromptText(plaintext: string): string | undefined {
  let items
  try {
    items = deserializeMessageItems(plaintext)
  } catch {
    return plaintext
  }
  const text = items
    .filter(
      (item): item is { type: 'text'; text: string } =>
        item?.type === 'text' && typeof item.text === 'string',
    )
    .map(item => item.text)
    .join('\n')
  return text || undefined
}

/** Canonical (#778) counterpart: only fully validated type-17 text items are prompts. Any other
 * typed or unknown item is never fed to the model, and a message with no text is not a prompt. */
export function extractCanonicalPromptText(
  items: ReadonlyArray<{
    kind: string
    typed?: { type: number; text?: unknown }
  }>,
): string | undefined {
  const text = items
    .flatMap(item =>
      item.kind === 'parsed' &&
      item.typed?.type === 17 &&
      typeof item.typed.text === 'string'
        ? [item.typed.text]
        : [],
    )
    .join('\n')
  return text || undefined
}
