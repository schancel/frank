import { boot } from 'quasar/wrappers'
import { startupRestoration } from './startup-state'
import { initializeMonadIdentity } from '../utils/monad-identity-session'

/** Opens custody, then publishes the account's own directory entry and starts messaging in the
 * background. No user step: creating or restoring an account is enough. */
export default boot(async () => {
  if (startupRestoration.value.phase !== 'restored') return
  await initializeMonadIdentity()
})
