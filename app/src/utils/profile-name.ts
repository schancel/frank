import { validateProfileDisplayName } from '@frank/wallet/profile-display-name'

/** Quasar input rule: true when the name satisfies Decision #189, otherwise the message. */
export function profileNameRule(value: string, message: string): true | string {
  return validateProfileDisplayName(value ?? '').valid || message
}

/** The canonical value the profile editor displays, validates, emits and persists. */
export function normalizedProfileName(value: string): string {
  return validateProfileDisplayName(value ?? '').normalized
}
