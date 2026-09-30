import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The Phase 0 audit must cite the CBOR profile that is already in this tree.
// Suite 65535 is reserved there; it is not an uncitable task-statement gap.
test('phase 0 audit cites the CBOR readme for suite 65535', () => {
  const audit = readFileSync(new URL('./nakamoto-audit.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('./protocol/cbor/README.md', import.meta.url), 'utf8');
  assert.match(readme, /S2c\. Encryption-suite identifier 65535/);
  assert.match(readme, /MUST NOT be emitted by a production writer/);
  assert.doesNotMatch(audit, /is not in this tree/);
  assert.doesNotMatch(audit, /taken from the task statement/);
  assert.match(audit, /docs\/protocol\/cbor\/README\.md/);
  assert.match(audit, /65535/);
  assert.match(audit, /production writer MUST NOT emit it/);
  assert.doesNotMatch(audit, /encryption-suite ticket cites that file/);
  assert.match(audit, /encryption-suite ticket must cite that file/);
  assert.match(audit, /must not invent a production suite id/);
});
