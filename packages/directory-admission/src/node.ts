import type { Anchor, DirectoryStore, OpenMode } from './index'
import { AdmissionError, validateAnchor } from './policy/history'
import { openStore } from './policy/store'
import { openLevel } from './storage/level'

export type * from './index'
export { AdmissionError } from './policy/history'
export async function openNodeDirectoryStore(options: {
  location: string
  anchor: Anchor
  mode: OpenMode
}): Promise<DirectoryStore> {
  const owned = structuredClone(options)
  validateAnchor(owned.anchor)
  if (owned.mode?.kind !== 'new' && owned.mode?.kind !== 'reopen')
    throw new AdmissionError('continuity')
  if (owned.mode.kind === 'reopen' && !owned.mode.checkpoint)
    throw new AdmissionError('continuity')
  return openStore(
    await openLevel(owned.location, owned.mode.kind),
    owned.anchor,
    owned.mode,
  )
}
