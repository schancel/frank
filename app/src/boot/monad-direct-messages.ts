import { boot } from 'quasar/wrappers'
import { initializeMonadIdentity } from '../utils/monad-identity-session'

/** Opens custody and resumes canonical messaging only where it was already admitted (#778).
 * Nothing here publishes directory evidence or legacy keys; first enrollment is an explicit
 * Settings action after the operator installed the public bundle. */
export default boot(async () => {
  await initializeMonadIdentity()
})
