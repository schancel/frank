import StateChannelArtifact from './artifacts/StateChannel.json'
import GenericHTLCArtifact from './artifacts/GenericHTLC.json'

export const StateChannel = StateChannelArtifact
export const GenericHTLC = GenericHTLCArtifact

export const CONTRACT_NAMES = {
  StateChannel: 'StateChannel',
  GenericHTLC: 'GenericHTLC',
} as const

export { compileContracts } from './scripts/compile'
export { deployAll, CREATE2_FACTORY, type DeploymentRecord } from './scripts/deploy'
