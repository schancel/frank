import { createNativeTransferContext } from '../accounts/native-transfer'
import type { StealthAssetOption } from './options'

/** What a stealth payment of this asset could draw on now, from its financial owner. Read-only:
 * it records and reserves nothing. Undefined when that wallet cannot say before quoting. */
export async function stealthAvailableBalance(
  option: Pick<StealthAssetOption, 'chainIdentifier' | 'asset'>,
): Promise<bigint | undefined> {
  const context = await createNativeTransferContext(option.chainIdentifier)
  const binding = await context.captureWallet()
  const payments = binding.wallet.stealthPayments
  if (!payments?.available) return undefined
  const available = await payments.available({ ...option.asset })
  await binding.assertCurrent()
  return available
}
