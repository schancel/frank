/**
 * For the plugins whose bytes are one FRNK frame (the item types that already have a canonical
 * wire encoding): validates bytes as a frame with the core codec and reports any failure as the
 * registry's typed decode error. The plugin then projects its own type from the parsed frame.
 */
import { defaultContext, validateFrame, type ParsedFrame } from '@frank/codec'

import { MessageItemDecodeError } from '../registry'
import { detailOf } from './cbor-fields'

export function openItemFrame(type: string, bytes: Uint8Array): ParsedFrame {
  let result
  try {
    result = validateFrame(bytes, defaultContext())
  } catch (error) {
    throw new MessageItemDecodeError(type, detailOf(error))
  }
  if (result.kind !== 'parsed')
    throw new MessageItemDecodeError(type, 'not an interpretable frame')
  return result
}

/** Runs a plugin's projection, reporting anything it throws as the typed decode error. */
export function decodeWith<T>(type: string, project: () => T): T {
  try {
    return project()
  } catch (error) {
    if (error instanceof MessageItemDecodeError) throw error
    throw new MessageItemDecodeError(type, detailOf(error))
  }
}
