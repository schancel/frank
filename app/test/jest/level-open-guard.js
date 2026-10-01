'use strict'

// LevelUP emits a failed open on 'error' and throws when nothing is listening.
// Jest then fails whichever test is on the worker (seen as
// "Unhandled error. (Error {})" on MainLayout's rail-tab test). Mark those
// events handled. Listeners registered by a test still run.

const EventEmitter = require('events').EventEmitter
const originalEmit = EventEmitter.prototype.emit

function emitWithoutUnhandledLevelError(type) {
  if (
    type === 'error' &&
    this &&
    this.type === 'levelup' &&
    typeof this.listenerCount === 'function' &&
    this.listenerCount('error') === 0
  ) {
    return false
  }
  return originalEmit.apply(this, arguments)
}

EventEmitter.prototype.emit = emitWithoutUnhandledLevelError

const LevelUP = require('levelup')
if (LevelUP && LevelUP.prototype) {
  LevelUP.prototype.emit = emitWithoutUnhandledLevelError
}
