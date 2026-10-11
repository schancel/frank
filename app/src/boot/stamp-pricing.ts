import { boot } from 'quasar/wrappers'
import {
  getActiveChain,
  getChainRegistryEntry,
  installDefaultStampResolver,
} from '@frank/wallet/chain'
import {
  createStampDefaultResolver,
  stampPolicyConfig,
} from '@frank/wallet/oracle'
import { useOracleStore } from '../stores/oracle'

/** Bind the already-configured chain before restoration starts any account runtime effects. */
export default boot(() => {
  const chain = getActiveChain()
  const entry = getChainRegistryEntry(chain.chainIdentifier)
  if (!entry)
    throw new Error('Stamp pricing requires a configured canonical chain')
  const oracle = useOracleStore()
  installDefaultStampResolver(
    chain.chainIdentifier,
    createStampDefaultResolver({
      chainIdentifier: chain.chainIdentifier,
      asset: entry.kind,
      supportsDirectMessages: chain.capabilities.directMessages,
      baseUnitsPerCoin: chain.fromDisplayAmount('1'),
      config: stampPolicyConfig(
        import.meta.env.QCLI_FRANK_DM_DEFAULT_STAMP_AVU,
      ),
      getRates: async () => {
        await oracle.restored
        return oracle.current
      },
    }),
  )
})
