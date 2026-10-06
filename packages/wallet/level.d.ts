declare module 'level' {
  export class LevelDBIterator {
    next(callback?: (error: any, key: any, value: any) => void): Promise<string> | void
    end(callback?: (error?: any) => void): Promise<void> | void
    [Symbol.asyncIterator](): AsyncIterableIterator<[string, string]>
  }

  export class LevelDBBatch {
    put(key: string, value: string): this
    del(key: string): this
    clear(): this
    write(options?: any, callback?: any): Promise<void>
  }

  export class LevelDB {
    open(callback?: any): Promise<void>
    put(key: string, value: string, options?: any, callback?: any): Promise<void>
    get(key: string, options?: any, callback?: any): Promise<string>
    del(key: string, options?: any, callback?: any): Promise<void>
    close(callback?: any): Promise<void>
    clear(options?: any, callback?: any): Promise<void>
    iterator(options?: any): LevelDBIterator
    batch(): LevelDBBatch
    batch(ops: any[], options?: any, callback?: any): Promise<any>
  }

  function level(
    location: string,
    options?: { createIfMissing?: boolean; [key: string]: unknown }
  ): LevelDB
  export default level
}
