// No console.log() / setTimeout
// console.log = jest.fn(() => { throw new Error('Do not use console.log() in production') })
jest.setTimeout(1000)

// jsdom in this repo does not provide the platform text codecs. Wallet envelope
// code constructs them at import, which sign-up now reaches from Setup.vue.
const util = require('util') as {
  TextEncoder: typeof TextEncoder
  TextDecoder: typeof TextDecoder
}
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = util.TextEncoder
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = util.TextDecoder
}

// jsdom cross-realm Buffer/Uint8Array compatibility for ethers and Node crypto
Object.defineProperty(Uint8Array, Symbol.hasInstance, {
  value: function (instance: any) {
    if (instance == null) return false
    return (
      instance.constructor?.name === 'Uint8Array' ||
      instance.constructor?.name === 'Buffer' ||
      Object.prototype.toString.call(instance) === '[object Uint8Array]' ||
      Object.prototype.toString.call(instance) === '[object Buffer]' ||
      (typeof instance === 'object' &&
        typeof instance.byteLength === 'number' &&
        typeof instance.slice === 'function')
    )
  },
  configurable: true,
  writable: true,
})

// jest speedup when errors are part of the game
// Error.stackTraceLimit = 0

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
global.Promise = require('promise')

/*
import chai from 'chai'
// Make sure chai and jasmine ".not" play nice together
// https://medium.com/@RubenOostinga/combining-chai-and-jest-matchers-d12d1ffd0303
// updated here: https://www.andrewsouthpaw.com/jest-chai/
const originalNot = Object.getOwnPropertyDescriptor(chai.Assertion.prototype, 'not').get
Object.defineProperty(chai.Assertion.prototype, 'not', {
  get() {
    Object.assign(this, this.assignedNot)
    return originalNot.apply(this)
  },
  set(newNot) { 
    this.assignedNot = newNot
    return newNot
  }
})

// Combine both jest and chai matchers on expect
const originalExpect = global.expect

global.expect = (actual) => {
  const originalMatchers = originalExpect(actual)
  const chaiMatchers = chai.expect(actual)

  // Add middleware to Chai matchers to increment Jest assertions made
  const { assertionsMade } = originalExpect.getState()
  Object.defineProperty(chaiMatchers, 'to', {
    get() {
      originalExpect.setState({ assertionsMade: assertionsMade + 1 })
      return chai.expect(actual)
    },
  })

  const combinedMatchers = Object.assign(chaiMatchers, originalMatchers)
  return combinedMatchers
}
Object.keys(originalExpect).forEach(key => (global.expect[key] = originalExpect[key]))
*/

// do this to make sure we don't get multiple hits from both webpacks when running SSR
setTimeout(() => {
  // do nothing
}, 1)
