/**
 * Boot wiring for the Monad direct-message session (ticket #42, in-place finish #389).
 *
 * Kept separate from `setup-apis.ts` (the Lotus boot sequence) so a failure in either path
 * cannot take down the other. The work itself lives in `utils/monad-identity-session.ts` so
 * sign-up can run it after the seed is committed without reloading the page. This file only
 * publishes the env knobs Vite can see (`import.meta.env`) and calls that initializer.
 *
 * `QCLI_SETUP_FINISH_RELOAD=true` restores the old full-page reload after Finish. The default
 * is in-place. `QCLI_MONAD_DM_POLL_INTERVAL_MS` is the poll cadence (not `MONAD_DM_POLL_INTERVAL_MS`).
 */
import { boot } from 'quasar/wrappers'

import {
  configureMonadIdentitySession,
  initializeMonadIdentity,
} from '../utils/monad-identity-session'

configureMonadIdentitySession({
  pollIntervalMs: Number(
    import.meta.env.QCLI_MONAD_DM_POLL_INTERVAL_MS ?? 7000,
  ),
  finishReloads: import.meta.env.QCLI_SETUP_FINISH_RELOAD === 'true',
})

export default boot(async () => {
  await initializeMonadIdentity()
})
