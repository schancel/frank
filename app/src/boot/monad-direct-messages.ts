import { boot } from 'quasar/wrappers'
import { initializeMonadIdentity } from '../utils/monad-identity-session'

/** Typed accounts deliberately do not publish legacy directory keys or start DM pollers. */
export default boot(async () => {
  await initializeMonadIdentity()
})
