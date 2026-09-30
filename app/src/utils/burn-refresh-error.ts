import { errorNotify, infoNotify } from './notifications'

/**
 * The burn (post or vote) already went through, but reading the result back failed. Kept apart
 * from every other error so no caller invites a retry: retrying would burn a second time.
 */
export class BurnRefreshError extends Error {
  readonly kind: 'post' | 'vote'
  constructor(kind: 'post' | 'vote', cause: unknown) {
    super(
      `The ${kind} was sent but reading it back failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
    this.name = 'BurnRefreshError'
    this.kind = kind
  }
}

/** Runs the read-back after a successful burn; any failure becomes a {@link BurnRefreshError}. */
export async function refreshAfterBurn(
  kind: 'post' | 'vote',
  refresh: () => Promise<unknown>,
): Promise<void> {
  try {
    await refresh()
  } catch (err) {
    throw new BurnRefreshError(kind, err)
  }
}

type Translate = (key: string) => string

/** Reports a failed vote/post: a read-back failure after a landed burn is an info notice that says
 * to reload (and not to retry); everything else is an error. */
export function notifyBurnFailure(err: unknown, t: Translate): void {
  if (err instanceof BurnRefreshError) {
    infoNotify(
      t(
        err.kind === 'post'
          ? 'stampPreparation.postedRefreshFailed'
          : 'stampPreparation.votedRefreshFailed',
      ),
    )
    return
  }
  errorNotify(err instanceof Error ? err : new Error(String(err)))
}
