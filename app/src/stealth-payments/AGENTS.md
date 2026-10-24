# Financial operations at the messaging boundary

Read [README.md](README.md) for ownership, write ordering and exact verification commands. Root architectural invariants remain authoritative.

- `outgoing.ts` captures existing family payment capabilities; it must not construct a replacement payment during retry.
- `financial-envelope-recovery.ts` owns orchestration over injected capabilities. Keep it free of Vue/Pinia, mutable application globals, custody initialization and direct transport construction.
- The existing message-store binding is the association authority. Canonical messaging owns original envelopes; family owners own reservations, signed bytes and settlement. Do not add a competing journal or completion cache.
- Preserve the distinction between identifying an original, authorizing exposure, delivery and financial settlement. Lookup is not exposure; successful submission is not necessarily settlement.
- Test failures around real writes and external handoffs, including deleted presentation rows, ambiguous acknowledgements and account/chain changes. Keep the original operation and bytes in every recovery assertion.
- Composition belongs to the session adapter. Do not introduce a timer or UI lifecycle inside the recovery factory.
