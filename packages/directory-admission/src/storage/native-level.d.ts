// The Node entry of level 7 is level.js. Keep this UTF-8-only dependency view
// scoped to that explicit entry: declaring the bare 'level' module here changes
// unrelated consumers' API when they import the public directory Node facade.
// This is the subset used by the directory store, not a replacement for Level's
// complete API (which also supports location-only and other encoding overloads).
declare module 'level/level.js' {
  interface Options {
    keyEncoding: 'utf8'
    valueEncoding: 'utf8'
    createIfMissing: boolean
    errorIfExists: boolean
  }
  interface Database {
    on(event: 'error', listener: (error: Error) => void): Database
    open(): Promise<Database>
    close(): Promise<void>
    batch(
      operations: { type: 'put'; key: string; value: string }[],
      options: { sync: true },
    ): Promise<void>
    iterator(): AsyncIterable<[string, string]>
  }
  export default function level(
    location: string,
    options: Options,
    callback: (error: Error | null) => void,
  ): Database
}
