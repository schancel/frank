import {
  PROFILE_DISPLAY_NAME_MAX_SCALARS,
  validateProfileDisplayName,
} from '@frank/wallet/profile-display-name'

type Translate = (key: string, params?: Record<string, unknown>) => string

/** The message telling the user what is wrong with a display name and what to do (ticket #268), or
 * `undefined` when the name satisfies Decision #189. One message per failure class. */
export function profileNameError(
  value: string,
  t: Translate,
): string | undefined {
  const result = validateProfileDisplayName(value ?? '')
  switch (result.reason) {
    case undefined:
      return undefined
    case 'blank':
      return t('profile.nameBlank')
    case 'too-long':
      return t('profile.nameTooLong', { max: PROFILE_DISPLAY_NAME_MAX_SCALARS })
    case 'forbidden-character':
      return t('profile.nameForbiddenCharacters')
    case 'invalid-unicode':
      return t('profile.nameInvalidUnicode')
  }
}

/** Quasar input rule: true when the name satisfies Decision #189, otherwise the message. */
export function profileNameRule(value: string, t: Translate): true | string {
  return profileNameError(value, t) ?? true
}

/** The canonical value the profile editor displays, validates, emits and persists. */
export function normalizedProfileName(value: string): string {
  return validateProfileDisplayName(value ?? '').normalized
}
