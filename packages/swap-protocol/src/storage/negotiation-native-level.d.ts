// Explicit native-only Level7 UTF-8 subset; never included by the pure or browser gate.
declare module 'level/level.js' {
  interface Database {
    on(event: 'error', listener: (error: Error) => void): Database
    close(): Promise<void>
    batch(
      operations: { type: 'put'; key: string; value: string }[],
      options: { sync: true },
    ): Promise<void>
    iterator(): AsyncIterable<[string, string]>
  }
  export default function level(
    location: string,
    options: {
      keyEncoding: 'utf8'
      valueEncoding: 'utf8'
      createIfMissing: boolean
      errorIfExists: boolean
    },
    callback: (error: Error | null) => void,
  ): Database
}
