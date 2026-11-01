# Binary blob message items

The generic plugin container is frame 27: field 0 is its semantic item type, field 1 is plugin-owned bytes, and field 2 is optional common MIME metadata. The application plugin owns blob validation; the core codec owns framing and enclosing budgets.

The frozen historical `newer-schema-extra-key` vector used field 2 as an unknown integer. The current reader explicitly rejects that historical frame because field 2 now owns MIME text; the generated blob corpus qualifies still-unallocated field 3 as retained under a newer schema. The frozen historical corpus remains unchanged.

Field 2 is optional common MIME metadata, a canonical lowercase bare type/subtype
of at most 127 ASCII bytes (no parameters, whitespace or wildcards). It is separate
from the semantic item type and from the plugin payload. A `blob` plugin entry
requires this header and carries the actual file bytes directly in field 1, with a
524,288-byte plugin limit. The enclosing encrypted direct message still has its
8 MiB ceiling; many attachments do not raise it. Unknown valid MIME types remain
opaque downloadable attachments. MIME is a peer claim, not proof of content.
Browser image presentation admits PNG, JPEG, GIF and WebP only after signature and
dimension checks; active content is never embedded. The obsolete `image` data-URI
plugin is not read or written; retained older local records remain unsupported,
without conversion or deletion. Local history's byte-preserving JSON encoding is
independent of these canonical raw-byte payloads.

`vectors/blob-message-item.json`, built by
`packages/frank-codec/fixtures/blob-message-item.ts` through `yarn vectors:generate`,
pins native non-UTF8 bytes, MIME metadata and invalid headers. The TypeScript reader
validates the known container and the installed blob plugin validates its own
requirements. Rust currently does not interpret type 27: it validates restricted
CBOR framing and preserves the complete opaque frame byte-for-byte, including
application metadata it does not understand. It never treats that retained content
as a validated executable application item.

The optional MIME header is available on generic plugin entries. Dedicated text, email, game and other frame writers reject supplied MIME explicitly; they do not silently drop it. Signed group history reconstructs its current read-only projection from the authenticated payload; retired image plugins remain unsupported without rewriting stored rows.
