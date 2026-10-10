/**
 * Binds the swap view to the wallet that will sign: the account's EVM wallet for one canonical
 * chain, its main account (which holds the tokens and pays the gas), and the chain's swap
 * deployment. Composition only: quoting and execution live in `@frank/wallet/swap`.
 */
import {
  getEvmDexDeployment,
  listEvmSwapVenues,
  type UniswapV4Deployment,
} from '@frank/wallet/chain/dex-deployments'
import type {
  SwapExecutionReader,
  SwapWallet,
} from '@frank/wallet/swap/swap-execution'
import { accountSession } from 'src/accounts/session'

export interface EvmSwapSession {
  readonly chainIdentifier: string
  readonly deployment: UniswapV4Deployment
  /** The main account: it swaps, and the tokens it receives stay on it. */
  readonly account: string
  readonly reader: SwapExecutionReader
  readonly wallet: SwapWallet
  /** False once the signed-in account has changed: an open form must not sign for another. */
  isCurrent(): boolean
}

export type EvmSwapUnavailable = 'no-deployment' | 'wrong-network' | 'no-wallet'

export class EvmSwapUnavailableError extends Error {
  constructor(readonly reason: EvmSwapUnavailable) {
    super(`Swap unavailable: ${reason}`)
    this.name = 'EvmSwapUnavailableError'
  }
}

export function evmSwapDeployment(
  chainIdentifier: string | undefined,
): UniswapV4Deployment | undefined {
  return chainIdentifier ? getEvmDexDeployment(chainIdentifier) : undefined
}

/** The venues a chain's EVM wallet can swap on, in order; empty when it has none. */
export function evmSwapVenues(
  chainIdentifier: string | undefined,
): readonly UniswapV4Deployment[] {
  return chainIdentifier ? listEvmSwapVenues(chainIdentifier) : []
}

export async function openEvmSwapSession(
  chainIdentifier: string,
  venueId?: string,
): Promise<EvmSwapSession> {
  const deployment = getEvmDexDeployment(chainIdentifier, venueId)
  if (!deployment) throw new EvmSwapUnavailableError('no-deployment')
  const wallet = await accountSession.getWallet()
  const { account: signedIn, revision } = accountSession.state
  if (wallet.family !== 'evm' || wallet.chainIdentifier !== chainIdentifier)
    throw new EvmSwapUnavailableError('wrong-network')
  const reader = wallet.evmReader
  if (!reader || !wallet.sendContractCall || !wallet.getContractCallFunds)
    throw new EvmSwapUnavailableError('no-wallet')
  return {
    chainIdentifier,
    deployment,
    // The EVM handle's receive address is its main account; execution checks it again against
    // the account the wallet actually signs from.
    account: (await wallet.getReceiveAddress()).raw,
    reader,
    wallet: {
      sendContractCall: params => wallet.sendContractCall!(params),
      getContractCallFunds: () => wallet.getContractCallFunds!(),
      fundMainAccount: wallet.fundMainAccount
        ? params => wallet.fundMainAccount!(params)
        : undefined,
      resumeLegacySend: wallet.resumeLegacySend
        ? id => wallet.resumeLegacySend!(id)
        : undefined,
      resumeNativeOperation: wallet.resumeNativeOperation
        ? id => wallet.resumeNativeOperation!(id)
        : undefined,
      getUnresolvedContractCalls: wallet.getUnresolvedContractCalls
        ? () => wallet.getUnresolvedContractCalls!()
        : undefined,
      reobserveNativeOperations: wallet.reobserveNativeOperations
        ? () => wallet.reobserveNativeOperations!()
        : undefined,
    },
    isCurrent: () =>
      accountSession.state.status === 'ready' &&
      accountSession.state.account === signedIn &&
      accountSession.state.revision === revision,
  }
}
