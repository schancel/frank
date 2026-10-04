/**
 * A send that was refused before anything was created: no message was stored, shown or paid for.
 * The composer keeps the typed text for these, and the user is told the real reason instead of
 * the generic "something went wrong".
 */
export type SendRefusalReason = 'messaging-pending' | 'too-large'

export class SendRefusedError extends Error {
  readonly reason: SendRefusalReason
  constructor(reason: SendRefusalReason, message: string) {
    super(message)
    this.name = 'SendRefusedError'
    this.reason = reason
  }
}

const REFUSAL_KEYS: Record<SendRefusalReason, string> = {
  'messaging-pending': 'chat.sendRefusedMessagingPending',
  'too-large': 'chat.sendRefusedTooLarge',
}

export function sendRefusalReason(err: unknown): SendRefusalReason | undefined {
  return err instanceof SendRefusedError ? err.reason : undefined
}

/** `errorNotify` options that show a refusal's own translated reason; empty for other errors. */
export function sendErrorNotifyOptions(err: unknown): { fallbackKey?: string } {
  const reason = sendRefusalReason(err)
  return reason === undefined ? {} : { fallbackKey: REFUSAL_KEYS[reason] }
}
