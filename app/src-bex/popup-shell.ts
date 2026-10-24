import {
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
  type ExtensionPopupHost,
  sendRuntimeMessage,
} from './runtime-adapter'

/** Runs in the fixed-size outer document, which owns the toolbar popup lifecycle. */
export function installPopupHost(scope: Record<string, any>): void {
  const host: ExtensionPopupHost = {
    close: () => scope.close(),
    requestSyncSender: () =>
      sendRuntimeMessage(
        {
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          type: 'request-sync-sender',
        },
        scope,
      ),
  }
  scope.frankPopupHost = Object.freeze(host)
}

if (typeof window !== 'undefined' && window.parent === window)
  installPopupHost(window)
