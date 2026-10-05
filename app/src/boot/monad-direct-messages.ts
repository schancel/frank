import { boot } from 'quasar/wrappers'
import { initializeMonadIdentity } from '../utils/monad-identity-session'

/** Opens custody, then publishes the account's own directory entry and starts messaging in the
 * background. No user step: creating or restoring an account is enough. */
export default boot(async () => {
  await initializeMonadIdentity()
})
