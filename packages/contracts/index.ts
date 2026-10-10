import StateChannelArtifact from './artifacts/StateChannel.json'
import GenericHTLCArtifact from './artifacts/GenericHTLC.json'
import IERC20Artifact from './artifacts/IERC20.json'

export const StateChannel = StateChannelArtifact
export const GenericHTLC = GenericHTLCArtifact
export const IERC20 = IERC20Artifact

export const CONTRACT_NAMES = {
  StateChannel: 'StateChannel',
  GenericHTLC: 'GenericHTLC',
  IERC20: 'IERC20',
} as const

export {
  DEPLOYMENTS,
  type ContractDeployment,
  type DeployedContractName,
  type DeploymentRecord,
} from './deployments'
export * from './solana-escrow'
