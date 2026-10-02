declare module 'level' {
  export class LevelDBIterator {
    next(): Promise<string>
    end(): Promise<void>
  }

  export class LevelDB {
    open(): Promise<void>
    put(key: string, value: string): Promise<void>
    get(key: string): Promise<string>
    del(key: string): Promise<void>
    close(): Promise<void>
    clear(): Promise<void>
    iterator(options: Record<string, unknown>): Promise<LevelDBIterator>
  }

  function level(
    location: string,
    options?: { createIfMissing?: boolean }
  ): LevelDB
  export default level
}
