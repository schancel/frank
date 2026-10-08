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

export { compileContracts } from './scripts/compile'
export {
  deployAll,
  CREATE2_FACTORY,
  type DeploymentRecord,
} from './scripts/deploy'
export * from './solana-escrow'
