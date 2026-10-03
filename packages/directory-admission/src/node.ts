import type { Anchor, DirectoryStore, OpenMode } from './index'
import { validateAnchor } from './policy/history'
import { openStore } from './policy/store'
import { openLevel } from './storage/level'
import { ownAnchor, ownMode } from './policy/owned-inputs'

export type * from './index'
export { AdmissionError } from './policy/history'
export async function openNodeDirectoryStore(options: {
  location: string
  anchor: Anchor
  mode: OpenMode
}): Promise<DirectoryStore> {
  const owned = {
    location: options.location,
    anchor: ownAnchor(options.anchor),
    mode: ownMode(options.mode),
  }
  validateAnchor(owned.anchor)
  return openStore(
    await openLevel(owned.location, owned.mode.kind),
    owned.anchor,
    owned.mode,
  )
}
