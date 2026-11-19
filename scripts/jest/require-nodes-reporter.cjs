/* eslint-env node */
/**
 * Under FRANK_REQUIRE_NODES=1 (set by every hosted CI step that runs a suite on a real node), a
 * jest run fails unless every test it found actually ran: no test skipped or todo, and at least
 * one test. A `-t` filter, an ignore pattern, a leftover `.skip` or a suite that skips itself
 * therefore fails the step instead of passing it with nothing exercised.
 *
 * The jest configs of wallet, bot, app and contracts spread `requireNodesReporters()` into
 * their config; it adds this reporter only when the flag is set.
 */
class RequireNodesReporter {
  constructor() {
    this.error = undefined
  }

  onRunComplete(_contexts, results) {
    const problems = []
    if (results.numTotalTests === 0) problems.push('no test ran')
    if (results.numPendingTests > 0) problems.push(`${results.numPendingTests} skipped`)
    if (results.numTodoTests > 0) problems.push(`${results.numTodoTests} todo`)
    if (problems.length === 0) return
    this.error = new Error(
      `FRANK_REQUIRE_NODES=1 requires every test found to run: ${problems.join(', ')}.`,
    )
    process.stderr.write(`\n${this.error.message}\n`)
  }

  getLastError() {
    return this.error
  }
}

/** `{ reporters }` adding this reporter when FRANK_REQUIRE_NODES=1, else `{}`. */
function requireNodesReporters(env = process.env) {
  return env.FRANK_REQUIRE_NODES === '1' ? { reporters: ['default', __filename] } : {}
}

module.exports = RequireNodesReporter
module.exports.requireNodesReporters = requireNodesReporters
