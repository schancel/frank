/**
 * For the plugins whose bytes are one FRNK frame (the item types that already have a canonical
 * wire encoding): gives the plugin its frame as the core codec validated it, and reports any
 * failure as the registry's typed decode error. The plugin then projects its own type from it.
 *
 * The frame is never validated under a fresh budget. When the item arrived in its own dedicated
 * frame, the enclosing message's validation has already parsed it and that result is used. When
 * the frame is nested in a generic plugin item, it is opened through the enclosing budget.
 */
import type { ParsedFrame } from '@frank/codec'

import {
  MessageItemDecodeError,
  type MessageItemDecodeContext,
} from '../registry'
import { detailOf } from './cbor-fields'

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function openItemFrame(
  type: string,
  bytes: Uint8Array,
  context: MessageItemDecodeContext,
): ParsedFrame {
  if (context.frame !== undefined) {
    if (!sameBytes(context.frame.frame, bytes))
      throw new MessageItemDecodeError(
        type,
        'the validated frame is not the frame of these bytes',
      )
    return context.frame
  }
  let result
  try {
    result = context.budget.openFrame(bytes, type)
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
