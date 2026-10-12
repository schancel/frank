import {
  activeChain,
  type NativeWalletHandle,
  type WalletHandle,
} from '@frank/wallet/chain'
import { accountSession } from '../accounts/session'
import { peekOpenedUtxoWallets } from '../accounts/utxo-wallets'
import {
  createFinancialOperationRecovery,
  type FinancialRecoveryFailure,
} from './recovery'

/** References existing session owners only. Financial journals and durable message outcomes
 * retain their facts independently of chat retention; this runtime owns no persistence. */
export function financialRecoveryForPolling({
  wallet,
  isCancelled,
  onError,
}: {
  wallet: WalletHandle
  isCancelled: () => boolean
  onError: (failure: FinancialRecoveryFailure) => void
}) {
  const client = activeChain.directMessages
  const chainIdentifier = activeChain.chainIdentifier
  const { account, revision } = accountSession.state
  const isCurrent = () =>
    !isCancelled() &&
    accountSession.state.status === 'ready' &&
    accountSession.state.account === account &&
    accountSession.state.revision === revision &&
    activeChain.directMessages === client &&
    activeChain.chainIdentifier === chainIdentifier
  return createFinancialOperationRecovery({
    onError,
    async captureSession() {
      if (!isCurrent() || !client.deliveryOf) return undefined
      if ((await accountSession.getWallet()) !== wallet || !isCurrent())
        return undefined
      const opened: NativeWalletHandle[] = [
        await accountSession.getWallet(),
        ...peekOpenedUtxoWallets().map(value => value.wallet),
      ]
      if (!isCurrent()) return undefined
      const owners = [...new Set(opened)]
      return {
        isCurrent,
        wallets: owners.flatMap(owner =>
          owner.stealthPayments
            ? [
                {
                  chainIdentifier: owner.chainIdentifier,
                  owner,
                  payments: owner.stealthPayments,
                },
              ]
            : [],
        ),
        deliveryOf: (payloadDigest: string) =>
          client.deliveryOf!({ wallet, payloadDigest }),
      }
    },
  })
}
