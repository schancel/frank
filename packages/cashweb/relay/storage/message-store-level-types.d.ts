declare module 'level-js' {
  class LevelJS {
    constructor(location: string)
    readonly db: IDBDatabase
    readonly location: string
    store(mode: IDBTransactionMode): IDBObjectStore
    _serializeKey(key: string): IDBValidKey
    _serializeValue(value: string): IDBValidKey
  }
  export = LevelJS
}
declare module 'level-packager' {
  import { LevelDB } from 'level'
  import LevelJS = require('level-js')
  function packager(
    backend: (location: string, options?: object) => LevelJS,
  ): (
    location: string,
    options: object,
    callback: (error?: Error) => void,
  ) => LevelDB
  export = packager
}
