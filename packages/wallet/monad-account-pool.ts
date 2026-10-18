export * from './evm-account-pool'

// In CommonJS environments (e.g. Jest), share the exact module exports object with
// `./evm-account-pool` so `jest.spyOn` works identically across both module paths.
declare const module: { exports: unknown } | undefined
declare const require: ((id: string) => unknown) | undefined
if (typeof module !== 'undefined' && typeof require === 'function') {
  module.exports = require('./evm-account-pool')
}
