/**
 * The hackathon build is Monad-first, while the old Lotus UI remains available for compatible
 * wallets. The historical flag is inverted ("skip legacy setup"), so keep that detail in one
 * place instead of duplicating subtly different string checks throughout the app.
 */
import { legacyLotusModeForFlag } from './legacy-mode'

export function legacyLotusModeEnabled(): boolean {
  return legacyLotusModeForFlag(
    import.meta.env.QCLI_MONAD_SKIP_LEGACY_SETUP_GATE,
  )
}

export function monadModeEnabled(): boolean {
  return !legacyLotusModeEnabled()
}
