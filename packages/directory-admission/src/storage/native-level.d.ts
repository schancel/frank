declare module 'level' {
  interface Options {
    keyEncoding: 'utf8'
    valueEncoding: 'utf8'
    createIfMissing: boolean
    errorIfExists: boolean
  }
  interface Database {
    on(event: 'error', listener: (error: Error) => void): Database
    open(): Promise<void>
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
    callback: (error?: Error) => void,
  ): Database
}
