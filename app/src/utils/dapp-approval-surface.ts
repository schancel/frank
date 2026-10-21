import {
  FRANK_DAPP_APPROVALS_CHANGED,
  FRANK_DAPP_BRIDGE_CHANNEL,
} from '../../src-bex/runtime-adapter'

/**
 * True for the background's notice that the dApp approval queue changed. The
 * queue is answered in the extension's approval window (src-bex/approval.ts);
 * other extension views only show how many requests wait there.
 */
export function isDappApprovalsChangedMessage(message: unknown): boolean {
  const m = message as { channel?: unknown; type?: unknown } | null
  return (
    m?.channel === FRANK_DAPP_BRIDGE_CHANNEL &&
    m?.type === FRANK_DAPP_APPROVALS_CHANGED
  )
}
