/**
 * Test-only stand-in for `navigator.locks` (the Web Locks API) shared by every "tab" of a test:
 * exclusive locks with `ifAvailable`, and `query()`. `install()` puts it on `globalThis.navigator`
 * and returns a function that restores what was there.
 */
export class FakeLockManager {
  readonly held = new Set<string>()

  async request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => Promise<T>,
  ): Promise<T> {
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null)
      throw new Error('FakeLockManager only supports ifAvailable requests')
    }
    this.held.add(name)
    try {
      return await callback({ name })
    } finally {
      this.held.delete(name)
    }
  }

  async query(): Promise<{ held: { name: string }[] }> {
    return { held: [...this.held].map(name => ({ name })) }
  }

  /** Holds `name` (as another tab mid-send would) until the returned function is called. */
  hold(name: string): () => void {
    let release: () => void = () => undefined
    const released = new Promise<void>(resolve => (release = resolve))
    void this.request(name, { ifAvailable: true }, () => released)
    return release
  }

  install(): () => void {
    const g = globalThis as { navigator?: unknown }
    const before = Object.getOwnPropertyDescriptor(g, 'navigator')
    Object.defineProperty(g, 'navigator', {
      configurable: true,
      writable: true,
      value: { locks: this },
    })
    return () => {
      if (before) Object.defineProperty(g, 'navigator', before)
      else delete g.navigator
    }
  }
}
