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

Backend CI runs the check. `packages/frank-codec/test/message-types.jest.test.ts` and
`backend/cashweb/frank-cbor/tests/message_types.rs` also compare the generated constants with the
registry inside each language's test suite.

## Renumbering

Edit `id` in `v1.json` and run `yarn message-types:generate`. Code that compares with or builds
frames from the generated constants follows automatically. A TypeScript number literal still
compared with a typed projection's `type` discriminant stops compiling, because those discriminants
are `typeof TYPE_…`; a literal compared with a plain `typeId: number` does not, so search for any
that remain. Test vectors, fixtures, test code and the prose of the CBOR README still name numbers
and must be regenerated or edited in the same change.
