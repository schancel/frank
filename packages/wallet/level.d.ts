// Third-party declaration for the bare `level` module, as installed: level 7.0.1
// (level-packager 6.0.1 -> levelup 5.1.1 + encoding-down 7.1.0 over leveldown 6.1.1 on Node and
// level-js 6.1.0 in the browser; abstract-leveldown 7.2.0). None of those packages ships types.
//
// This is the single owner of the bare `level` declaration for the whole repository. It lives in
// packages/wallet for historical reasons and is included explicitly by every consuming tsconfig.
// It is NOT a wallet facade and it is NOT Level's complete API. It declares only what this
// repository calls, for the default UTF-8 key/value encoding, in Promise mode plus the iterator
// callback mode. A call this file does not model must fail to compile; extend the file from the
// installed source rather than casting at the call site.
//
// Source of each signature (paths under node_modules/):
//   level/level.js, level/browser.js, level-packager/level-packager.js   factory
//   levelup/lib/levelup.js                                               open/close/get/put/del/batch/clear/iterator
//   levelup/lib/batch.js                                                 chained batch
//   abstract-leveldown/abstract-iterator.js                              next/end/async iteration
//   encoding-down/index.js                                               UTF-8 default, iterator key/value decoding
declare module 'level' {
  export interface LevelOpenOptions {
    createIfMissing?: boolean
  }

  export interface LevelWriteOptions {
    sync?: boolean
  }

  export interface LevelRangeOptions {
    gt?: string
    gte?: string
    lt?: string
    lte?: string
    reverse?: boolean
    limit?: number
  }

  export type LevelBatchOperation =
    | { type: 'put'; key: string; value: string }
    | { type: 'del'; key: string }

  // end(callback): the backend reports success as callback() or callback(null).
  export type LevelErrorCallback = (error?: Error | null) => void

  // What a next() callback observes on an iterator that reads values, as one correlated union so
  // that a callback written WITHOUT parameter annotations narrows `key` and `value` together:
  //   failure   -> callback(err)                         abstract-iterator.js:40-43
  //   entry     -> callback(null, key, value)            encoding-down/index.js:169
  //   exhausted -> callback(null, undefined, undefined)  encoding-down/index.js:154-169
  // All three members deliberately have the same length: mixed-length members stop TypeScript
  // from treating the parameters as dependent. A callback for this type must declare all three
  // parameters and must not annotate them.
  export type LevelEntryCallback = (
    ...args:
      | [error: Error, key: undefined, value: undefined]
      | [error: null | undefined, key: string, value: string]
      | [error: null | undefined, key: undefined, value: undefined]
  ) => void

  // Iterator over [key, value] entries (the default). abstract-leveldown/abstract-iterator.js.
  export interface LevelDBIterator {
    // Promise mode resolves one entry, or undefined once the range is exhausted.
    next(): Promise<[key: string, value: string] | undefined>
    // Callback mode returns the iterator itself.
    next(callback: LevelEntryCallback): this
    end(): Promise<void>
    end(callback: LevelErrorCallback): void
    // Ends the iterator when the loop finishes or exits early.
    [Symbol.asyncIterator](): AsyncGenerator<
      [key: string, value: string],
      void,
      undefined
    >
  }

  // Iterator opened with `values: false`: every entry's value is undefined.
  export interface LevelDBKeyIterator {
    next(): Promise<[key: string, value: undefined] | undefined>
    next(
      callback: (
        error: Error | null | undefined,
        key: string | undefined,
      ) => void,
    ): this
    end(): Promise<void>
    end(callback: LevelErrorCallback): void
    [Symbol.asyncIterator](): AsyncGenerator<
      [key: string, value: undefined],
      void,
      undefined
    >
  }

  // levelup/lib/batch.js. put/del throw synchronously on an invalid key or value.
  export interface LevelDBBatch {
    put(key: string, value: string): this
    del(key: string): this
    clear(): this
    write(options?: LevelWriteOptions): Promise<void>
  }

  // levelup/lib/levelup.js, Promise mode only. The callback overloads of these methods exist at
  // runtime but no code in this repository uses them, so they are not declared.
  export interface LevelDB {
    // Resolves the database itself (levelup.js:111,130).
    open(): Promise<LevelDB>
    close(): Promise<void>
    // Rejects with an error whose `notFound` is true when the key is absent (levelup.js:187-188).
    get(key: string): Promise<string>
    put(key: string, value: string, options?: LevelWriteOptions): Promise<void>
    del(key: string, options?: LevelWriteOptions): Promise<void>
    clear(): Promise<void>
    // Returns the iterator synchronously (levelup.js:273-275); it is NOT a Promise.
    iterator(options: LevelRangeOptions & { values: false }): LevelDBKeyIterator
    iterator(options?: LevelRangeOptions): LevelDBIterator
    batch(): LevelDBBatch
    batch(
      operations: readonly LevelBatchOperation[],
      options?: LevelWriteOptions,
    ): Promise<void>
  }

  // level-packager/level-packager.js:7-19. The database opens itself on construction; without a
  // callback an open failure is emitted as an 'error' event instead.
  function level(location: string, options?: LevelOpenOptions): LevelDB
  function level(
    location: string,
    options: LevelOpenOptions,
    callback: (error: Error | null, db?: LevelDB) => void,
  ): LevelDB
  export default level
}
