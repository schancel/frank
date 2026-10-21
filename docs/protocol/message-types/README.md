# Frank-CBOR type identifier registry v1

`v1.json` is the one source of every Frank-CBOR frame type identifier (`type_id`, envelope key 0):
directory, delivery, content/message-item, topic/forum and proof-only types. Codecs, plugins,
relays and docs take their identifiers from the files generated from it. Nothing else defines a
type identifier.

Each entry has:

| Field                          | Meaning                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `id`                           | The wire `type_id` (uint32). Changing it changes wire bytes, hashes and vectors.         |
| `key`                          | Stable name; the generated constant is `TYPE_` + `key` in upper snake case.              |
| `family`                       | `directory`, `delivery`, `content`, `topic` or `proof`.                                  |
| `open_item_field`              | Whether an open message-item field may carry this type (S8); `false` types are rejected. |
| `status`                       | `active` or `proof-only` (never written by a production writer).                         |
| `owner`                        | The package whose codec implements the type.                                             |
| `plugins`                      | Message-item plugins that carry the type, if any.                                        |
| `name`, `schema`               | The E5 row in [`../cbor/README.md`](../cbor/README.md) (schema path relative to it).     |
| `title`, `rule`, `description` | The row in [`packages/docs/cbor/spec.md`](../../../packages/docs/cbor/spec.md).          |

Identifiers are never reused (E5). Generated outputs list types in `id` order whatever the order
of entries in `v1.json`.

## Generated outputs

| Output                                                              | Consumer                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/frank-codec/src/message-types.generated.ts`               | `@frank/codec` (re-exported from `constants.ts`), plugins, wallet, relay client |
| `backend/cashweb/frank-cbor/src/message_types.rs`                   | `frank_cbor::message_types`, `cashweb-registry`                                 |
| E5 table in `docs/protocol/cbor/README.md`                          | Protocol readers                                                                |
| "Type ID Allocation Registry" table in `packages/docs/cbor/spec.md` | Docs site                                                                       |

The two tables are spliced between `BEGIN GENERATED: message-types` / `END GENERATED` markers;
the prose around them is hand-written.

## Commands

From the repository root (Python 3, no dependencies):

```sh
yarn message-types:generate   # python3 docs/protocol/message-types/generate.py
yarn message-types:check      # python3 docs/protocol/message-types/generate.py --check
```

`--check` fails when:

- the registry is malformed (duplicate `id` or `key`, an id outside uint32, a missing required
  field);
- any generated output differs from what the registry produces (edit `v1.json`, then regenerate;
  never edit a generated file);
- a tracked TypeScript/JavaScript/Rust file defines a constant with a generated name and a number
  literal (a shadow copy, whether or not it agrees), or non-test source defines any `TYPE_*`
  constant as a number literal.

The `typecheck` workflow, which has no path filter, runs the check on every push and pull request.
`packages/frank-codec/test/message-types.jest.test.ts` and
`backend/cashweb/frank-cbor/tests/message_types.rs` also compare the generated constants with the
registry inside each language's test suite.

## Renumbering

Edit `id` in `v1.json` and run `yarn message-types:generate`. Code that compares with or builds
frames from the generated constants follows automatically. A TypeScript number literal still
compared with a typed projection's `type` discriminant stops compiling, because those discriminants
are `typeof TYPE_…`; a literal compared with a plain `typeId: number` does not, so search for any
that remain. Test vectors, fixtures, test code and the prose of the CBOR README still name numbers
and must be regenerated or edited in the same change.

## Map field keys and enumerated values

`fields/*.json` (one file per protocol area: `common`, `directory`, `delivery`, `content`,
`topic`, `blackjack`, `groups`, and `storage` for local persisted rows that never travel) is the
one source of every Frank-CBOR map key and every enumerated integer value that code reads or
writes. Message-item plugins that declare their own field table with `cborItemCodec`
(`req(N, …)`/`opt(N, …)`) own those keys; that table is their single source. `fields.py` beside this file loads it; `generate.py` renders it.

A **struct** names the keys of one map and lists its **shapes**:

```json
{
  "key": "forwarding-delivery-envelope",
  "fields": {
    "network": 0,
    "destination": 1,
    "payload-frame": 2,
    "payload-digest": 3,
    "payments": 4
  },
  "shapes": [
    {
      "cddl": "docs/protocol/cbor/direct-message.cddl#forwarding-delivery-envelope",
      "required": [
        "network",
        "destination",
        "payload-frame",
        "payload-digest",
        "payments"
      ],
      "optional": [],
      "open": true
    }
  ]
}
```

A shape is one CDDL map rule: its required and optional keys, and whether it is open (undeclared
keys are retained under V6.3) or closed (C12 rejects them). A struct whose key space is shared
by several schema versions or actions (`directory-statement`, blackjack items) has one named
shape per version or action. `cddl` is `path#rule`, or `path#rule.<key>` for an inline map in
that rule's field; a shape without `cddl` (for example a historical schema the CDDL no longer
spells out) is not compared.

An **enum** names the integer values of one field (`account-type`, `bot-role`, blackjack action
codes and so on). `rust_type` selects the Rust integer type (default `u32`).

| Output                                                 | Contents                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `packages/frank-codec/src/message-fields.generated.ts` | `FORWARDING_DELIVERY_ENVELOPE.payloadFrame`, `FORWARDING_DELIVERY_ENVELOPE_SHAPE`, enums    |
| `backend/cashweb/frank-cbor/src/message_fields.rs`     | `forwarding_delivery_envelope::PAYLOAD_FRAME`, `forwarding_delivery_envelope::SHAPE`, enums |

Codecs read maps through a shape (`fields(payload, P, SHAPE, allow)` in TypeScript,
`fields_of(Some(payload), path, &SHAPE, allow)` in Rust), read fields by name, write maps with the
same constants, and build error paths from them (`at(P, K.payments)`).

`--check` also fails when:

- a shape disagrees with the CDDL rule it names (required keys, optional keys, or open/closed);
- non-test source under `packages/frank-codec/src/` or `backend/cashweb/frank-cbor/src/` spells a
  map key, a field path or a type id as a number literal (`m.get(5)`, `m.set(5, …)`, `${P}.4`,
  `(3, CborValue::…)`, `.push((3, …))`, `type_id == 19`, a key alone on its own line inside a
  map literal). A line that must use a raw key, for example to build a deliberately malformed
  map, carries a `raw-cbor-key: <reason>` comment on it or on the line above;
- non-test source in a protocol consumer (`packages/cashweb/relay/`,
  `packages/cashweb/message-items/`, `packages/wallet/`, `packages/group-messaging/`,
  `backend/cashweb/cashweb-registry/src/`) does the same. A consumer file is checked only when it
  touches Frank-CBOR (`cborMap`, `encodeCanonical`/`decodeCanonical`, `FrankValue`,
  `encodeFrame`, a bigint-keyed `.get`/`.has`/`.set`, `CborValue`, `cbor_map`). Rust consumers
  get the full Rust check. TypeScript consumers get only the patterns that are unambiguous
  outside a codec: map entries inside a map literal, map key literals in `.get`/`.has`/`.set`,
  typed-payload type comparisons and `typeId: N`.

Renumbering a field is an edit of its key in `fields/*.json` (and of the CDDL), then
`yarn message-types:generate`. Changing a key changes wire bytes and every vector that holds
that map.
