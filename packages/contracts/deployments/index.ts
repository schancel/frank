/**
 * Where Frank's contracts are deployed, by canonical `chainIdentifier`.
 *
 * Each record is the file `yarn --cwd packages/contracts deploy --chain <chainIdentifier> ...`
 * wrote next to this one after reading the code back from the chain. To make a new record
 * visible to the wallet, import its JSON here and add it to `DEPLOYMENTS`; nothing else
 * holds contract addresses. A network that is not listed has no deployment.
 *
 * This file is imported by the browser bundle: keep it free of Node-only imports.
 */
import monadTestnet from './monad-testnet.json'

export type DeployedContractName = 'GenericHTLC' | 'StateChannel'

export interface ContractDeployment {
  address: string
  deployer: string
  deployedVia: 'create2-proxy' | 'create'
  transactionHash: string
  blockNumber: number
  initCodeHash: string
  runtimeCodeHash: string
  compiler: {
    version: string
    settings: {
      optimizer: { enabled: boolean; runs: number }
      evmVersion: string
    }
  }
}

export interface DeploymentRecord {
  chainIdentifier: string
  /** The native chain id the node reported, as a decimal string. */
  chainId: string
  /** Present when the contracts went through the deterministic deployment proxy. */
  create2?: { proxy: string; salt: string }
  contracts: Record<DeployedContractName, ContractDeployment>
}

export const DEPLOYMENTS: Readonly<Record<string, DeploymentRecord>> =
  Object.freeze({
    'monad-testnet': monadTestnet as DeploymentRecord,
  })
