import ChannelVaultArtifact from './artifacts/ChannelVault.json'
import TablePotVaultArtifact from './artifacts/TablePotVault.json'
import GenericHTLCArtifact from './artifacts/GenericHTLC.json'

export const ChannelVault = ChannelVaultArtifact
export const TablePotVault = TablePotVaultArtifact
export const GenericHTLC = GenericHTLCArtifact

export const CONTRACT_NAMES = {
  ChannelVault: 'ChannelVault',
  TablePotVault: 'TablePotVault',
  GenericHTLC: 'GenericHTLC',
} as const

export { compileContracts } from './scripts/compile'
export { deployAll, CREATE2_FACTORY, type DeploymentRecord } from './scripts/deploy'
