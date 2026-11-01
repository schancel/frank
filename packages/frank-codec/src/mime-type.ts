/** Canonical bare MIME metadata: lowercase ASCII, no parameters, wildcards or whitespace. */
export const MAX_MIME_TYPE_BYTES = 127
export function isMimeType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_MIME_TYPE_BYTES &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)
  )
}
