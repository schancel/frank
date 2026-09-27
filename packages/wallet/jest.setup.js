/* eslint-env node */
// Matches app/test/jest/jest.setup.ts's own setup: some tests here (e.g.
// monad-stamp-nonce-race.jest.test.ts) were originally written and tuned against this app-wide
// jest environment, which replaces the native Promise with the 'promise' package -- its
// microtask-chaining tick count differs from V8's native Promise, and tests that count exact
// flushMicrotasks() iterations are calibrated against this one, not the native implementation.
global.Promise = require('promise')
