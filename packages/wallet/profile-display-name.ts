export const PROFILE_DISPLAY_NAME_MAX_SCALARS = 128
export const PROFILE_DISPLAY_NAME_MAX_UTF8_BYTES = 512

const UNICODE_WHITESPACE = /^\p{White_Space}$/u
const FORBIDDEN_DISPLAY_NAME_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u

export interface ProfileDisplayNameValidation {
  normalized: string
  valid: boolean
}

function measureUnicode(input: string): {
  scalarCount: number
  utf8ByteCount: number
  validUnicode: boolean
} {
  let scalarCount = 0
  let utf8ByteCount = 0
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = input.charCodeAt(index + 1)
      // NaN (high surrogate at end of input) must fail too, hence the negated range check.
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        return { scalarCount, utf8ByteCount, validUnicode: false }
      }
      index += 1
      scalarCount += 1
      utf8ByteCount += 4
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return { scalarCount, utf8ByteCount, validUnicode: false }
    } else {
      scalarCount += 1
      utf8ByteCount += codeUnit <= 0x7f ? 1 : codeUnit <= 0x7ff ? 2 : 3
    }
  }
  return { scalarCount, utf8ByteCount, validUnicode: true }
}

/** Linear trim of the Unicode White_Space property (same set as Rust's `char::is_whitespace`).
 * Every White_Space code point is in the BMP, so scanning UTF-16 units is exact. */
function trimUnicodeWhitespace(input: string): string {
  let start = 0
  let end = input.length
  while (start < end && UNICODE_WHITESPACE.test(input[start])) start += 1
  while (end > start && UNICODE_WHITESPACE.test(input[end - 1])) end -= 1
  return input.slice(start, end)
}

/** Decision #189's browser-safe display-name contract. Unicode normalization is intentionally
 * absent: the user's interior code points and bytes are preserved exactly. */
export function validateProfileDisplayName(
  input: string,
): ProfileDisplayNameValidation {
  const normalized = trimUnicodeWhitespace(input)
  const { scalarCount, utf8ByteCount, validUnicode } =
    measureUnicode(normalized)
  return {
    normalized,
    valid:
      normalized.length > 0 &&
      validUnicode &&
      !FORBIDDEN_DISPLAY_NAME_CHARACTER.test(normalized) &&
      scalarCount <= PROFILE_DISPLAY_NAME_MAX_SCALARS &&
      utf8ByteCount <= PROFILE_DISPLAY_NAME_MAX_UTF8_BYTES,
  }
}

/** Return the canonical signed/displayed value, or refuse input outside Decision #189. */
export function requireValidProfileDisplayName(input: string): string {
  const result = validateProfileDisplayName(input)
  if (!result.valid) {
    throw new RangeError('Invalid profile display name')
  }
  return result.normalized
}
