import type { Anchor, DirectoryStore, OpenMode } from './index'
import { validateAnchor } from './policy/history'
import { openStore } from './policy/store'
import { openIndexedDb } from './storage/indexeddb'
import { ownAnchor, ownMode } from './policy/owned-inputs'

export type * from './index'
export { AdmissionError } from './policy/history'
export async function openBrowserDirectoryStore(options: {
  name: string
  anchor: Anchor
  mode: OpenMode
}): Promise<DirectoryStore> {
  const owned = {
    name: options.name,
    anchor: ownAnchor(options.anchor),
    mode: ownMode(options.mode),
  }
  validateAnchor(owned.anchor)
  return openStore(
    await openIndexedDb(owned.name, owned.mode.kind),
    owned.anchor,
    owned.mode,
  )
}
