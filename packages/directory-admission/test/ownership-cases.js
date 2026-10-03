import {
  anchor,
  candidate,
  context,
  hash,
  equal,
  assert,
  rejects,
} from './shared'

function views(value, make) {
  if (value instanceof Uint8Array) return make(value)
  if (value instanceof Map)
    return new Map([...value].map(([key, item]) => [key, views(item, make)]))
  if (Array.isArray(value)) return value.map(item => views(item, make))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, views(item, make)]),
    )
  return value
}
function shared(value) {
  const buffers = []
  return {
    value: views(value, bytes => {
      const copy = new Uint8Array(new SharedArrayBuffer(bytes.byteLength))
      copy.set(bytes)
      buffers.push(copy)
      return copy
    }),
    mutate() {
      for (const bytes of buffers) bytes.fill(0)
    },
  }
}

// Observe a specific caller backing buffer at the clone boundary. Only 8 MiB is
// allocated; no heap exhaustion, timing threshold, or process memory estimate is used.
function bounded(value) {
  const backing = new ArrayBuffer(8 * 1024 * 1024)
  let offset = 128
  const supplied = views(value, bytes => {
    const copy = new Uint8Array(backing, offset, bytes.byteLength)
    copy.set(bytes)
    offset += bytes.byteLength + 128
    return copy
  })
  let backingClones = 0
  const original = globalThis.structuredClone
  return {
    value: supplied,
    start() {
      globalThis.structuredClone = function (input, ...options) {
        views(input, bytes => {
          if (bytes.buffer === backing) backingClones++
          return bytes
        })
        return original.call(globalThis, input, ...options)
      }
    },
    finish() {
      globalThis.structuredClone = original
      equal(
        backingClones,
        0,
        'small public byte views must not clone their 8 MiB caller backing buffer',
      )
    },
    restore() {
      globalThis.structuredClone = original
    },
  }
}

async function sharedCase(open, field, name) {
  let store
  try {
    if (field === 'anchor') {
      const supplied = shared(anchor())
      const opening = open(name, supplied.value, { kind: 'new' })
      supplied.mutate()
      store = await opening
      const current = await store.enroll([candidate('bootstrap')], context())
      equal(
        current.evidence.hash,
        hash('bootstrap'),
        'open captures owned anchor bytes',
      )
      return
    }
    store = await open(name, anchor(), { kind: 'new' })
    if (field === 'candidate' || field === 'prospective') {
      const supplied = shared(candidate('bootstrap'))
      const pending =
        field === 'candidate'
          ? store.enroll([supplied.value], context())
          : store.checkpointForEnrollment(supplied.value, context().now)
      supplied.mutate()
      const result = await pending
      if (field === 'candidate') {
        equal(
          result.evidence.statement,
          candidate('bootstrap').statement,
          'candidate statement captured before queue',
        )
        equal(
          result.evidence.attestation,
          candidate('bootstrap').attestation,
          'candidate wrapper captured before queue',
        )
        assert(
          !(result.evidence.attestation.buffer instanceof SharedArrayBuffer),
          'returned signed bytes have independent ordinary backing',
        )
      } else
        equal(
          result.head,
          hash('bootstrap'),
          'prospective checkpoint captures candidate bytes',
        )
      return
    }
    await store.enroll([candidate('bootstrap')], context())
    const before = await store.status()
    if (field === 'relay') {
      const supplied = shared(context())
      const pending = store.current(supplied.value)
      supplied.mutate()
      equal(
        (await pending).evidence.hash,
        before.head,
        'current captures relay ID and identity bytes',
      )
    } else if (field === 'hash') {
      const supplied = shared(hash('bootstrap'))
      const pending = store.historicalEvidence(supplied.value)
      supplied.mutate()
      equal(
        (await pending)?.statement,
        candidate('bootstrap').statement,
        'historical lookup captures hash bytes',
      )
    } else {
      const supplied = shared(before.checkpoint)
      await store.close()
      store = null
      const pending = open(name, anchor(), {
        kind: 'reopen',
        checkpoint: supplied.value,
      })
      supplied.mutate()
      store = await pending
      equal(await store.status(), before, 'reopen captures continuity bytes')
    }
  } finally {
    await store?.close()
  }
}

async function boundedCase(open, field, name) {
  let store
  let supplied
  try {
    if (field === 'anchor') {
      supplied = bounded(anchor())
      supplied.start()
      store = await open(name, supplied.value, { kind: 'new' })
      await store.enroll([candidate('bootstrap')], context())
    } else {
      store = await open(name, anchor(), { kind: 'new' })
      if (field === 'candidate') {
        supplied = bounded(candidate('bootstrap'))
        supplied.start()
        const current = await store.enroll([supplied.value], context())
        equal(
          current.evidence.statement,
          candidate('bootstrap').statement,
          'bounded candidate retains exact visible bytes',
        )
      } else {
        await store.enroll([candidate('bootstrap')], context())
        if (field === 'relay') {
          supplied = bounded(context())
          supplied.start()
          await store.current(supplied.value)
        } else if (field === 'hash') {
          supplied = bounded(hash('bootstrap'))
          supplied.start()
          equal(
            (await store.historicalEvidence(supplied.value))?.hash,
            hash('bootstrap'),
            'bounded hash lookup succeeds',
          )
        } else {
          supplied = bounded((await store.status()).checkpoint)
          await store.close()
          store = null
          supplied.start()
          store = await open(name, anchor(), {
            kind: 'reopen',
            checkpoint: supplied.value,
          })
        }
      }
    }
    supplied.finish()
  } finally {
    supplied?.restore()
    await store?.close()
  }
}

export const ownershipCaseNames = [
  ...['anchor', 'candidate', 'relay', 'checkpoint', 'hash', 'prospective'].map(
    field => `shared-${field}`,
  ),
  ...['anchor', 'candidate', 'relay', 'checkpoint', 'hash'].map(
    field => `bounded-${field}`,
  ),
  ...['bytes', 'depth', 'clock-order', 'evidence-order', 'resource-order'].map(
    field => `optional-${field}`,
  ),
]
async function optionalCase(open, field, name) {
  const store = await open(name, anchor(), { kind: 'new' })
  try {
    await store.enroll([candidate('bootstrap')], context())
    const before = await store.status()
    const supplied = context()
    let nested = null
    for (let i = 0; i < 33; i++) nested = [nested]
    supplied.relay.unknownFields =
      field === 'depth'
        ? new Map([[100n, nested]])
        : new Map([
            [100n, new Uint8Array(140000)],
            [101n, new Uint8Array(140000)],
          ])
    if (field === 'clock-order') supplied.now = null
    let batch = []
    if (field === 'evidence-order')
      batch = [{ statement: new Uint8Array(1), attestation: new Uint8Array(1) }]
    if (field === 'resource-order')
      batch = [
        { statement: new Uint8Array(262145), attestation: new Uint8Array(1) },
      ]
    const expected =
      {
        'clock-order': 'clock',
        'evidence-order': 'evidence',
        'resource-order': 'resource',
      }[field] || 'binding'
    await rejects(
      () => store.advance(batch, supplied),
      expected,
      `optional relay ${field} public boundary`,
    )
    equal(
      await store.status(),
      before,
      'optional relay rejection preserves durable state',
    )
  } finally {
    await store.close()
  }
}
export async function runOwnership(open, selected = ownershipCaseNames) {
  const results = []
  for (const name of selected) {
    assert(ownershipCaseNames.includes(name), `unknown ownership case ${name}`)
    const kind = name.split('-')[0]
    const field = name.slice(kind.length + 1)
    try {
      await (kind === 'shared'
        ? sharedCase
        : kind === 'optional'
        ? optionalCase
        : boundedCase)(open, field, `ownership-${name}`)
      results.push({ name, ok: true })
    } catch (error) {
      results.push({ name, ok: false, code: error.code, error: error.message })
    }
  }
  return {
    ok: results.every(result => result.ok),
    cases: results.length,
    results,
  }
}
