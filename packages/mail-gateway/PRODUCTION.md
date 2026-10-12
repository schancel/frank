# Mail gateway production boundary

The package contains SMTP, mail rendering, credit accounting, a Frank mailbox
listener, and a format-2 `MailJournal`. They are not yet composed into a safe
production host. `yarn start` refuses to start: the old executable used
`DemoGatewayStampProvider`, returned invented transaction hashes and balances,
and passed neither a wallet nor an `ActiveChain` to `EmailGatewayDaemon`.
Consequently it never started the Frank mailbox listener. Do not deploy that
executable or route MX/webhooks to it.

## Ownership and replacement sequence

The current running-path owners overlap. `CreditLedger` stores credits, thread
mappings, held mail and a retry spool; `InboundEmailHandler` consumes credit
before handing mail to a sender; `OutboundEmailDelivery` writes its thread
mapping before `OutboundMtaWorker` hands mail to SMTP; the mailbox listener
starts at the current time minus one minute and keeps its cursor in memory.
`MailJournal` defines durable inbound mail, Frank send slots, mailbox cursor,
bridged messages and outbound jobs. `JournaledInboundSend` now uses its inbound
slots as a library seam; no executable has composed it yet.

The replacement host must open and validate one persisted Frank wallet on one
canonical `chainIdentifier`, restore its payment attempts, then open the
format-2 journal bound to that wallet's identity and the gateway domain. The
host owns lifecycle and wires typed wallet messaging, the journal, and verified
mail transports. Direct inbound SMTP remains supported; a Resend webhook can
be a deployment adapter. Both ingress paths must authenticate the sender and
feed the same durable admission path. Wallet custody owns keys/signing and wallet recovery;
the journal owns mail admission, the decision that a particular mail consumed
credit, thread identity, mailbox
cursor, delivery jobs and the binding from a mail to the wallet's stable
message ID and payload digest. `CreditLedger` continues to own credit balances;
its debit joins the journal's SQLite transaction. A transport receipt is separate from a wallet
delivery/payment result. No new wire format is required for this predecessor.

Implement this as separate reviewed landings:

1. Pin the current and target behavior with interruption/reopen tests. Reject
   the demo executable (landed in #1453).
2. Route inbound mail through `MailJournal.admitInboundEmail` and
   `relayInboundEmail`, persist a stable Frank message ID and complete send
   intent before wallet exposure, and reconcile the same wallet attempt on
   restart. Consume one credit only once. Preserve raw mail and its scope.
   `JournaledInboundSend` implements the library side of this step; a host must
   still verify sender authentication and transport provenance, open the wallet,
   run recovery, and connect SMTP and any webhook receiving endpoints.
3. Route Frank mailbox reads through the journal's inclusive cursor and
   `recordFrankMessage`. Honor incomplete timestamp floors; persist a terminal
   disposition for each observed envelope before advancing. Never create a
   fresh outbound email from a replayed message.
   `JournaledFrankMailbox` now provides the cursor and durable-disposition
   guard as a library seam. Its injected handler must finish the complete
   outbound-job commit before it resolves; a returning handler with no journal
   outcome is refused. A truncated fetch can advance over its complete prefix,
   while the inclusive timestamp lets a later poll replay its boundary.
4. Render/sign outbound mail, store its exact bytes in `addOutboundJob`, then
   submit. On an ambiguous transport result, retain the job as uncertain and
   reconcile it before another submission. Only after target paths have
   restart and duplicate-delivery proof remove legacy `thread_mappings`,
   `outbound_spool`, and their old writer paths. Do not migrate or delete an
   existing funded gateway wallet as part of that replacement.

For Resend inbound delivery, verify the webhook signature over its **raw**
body before fetching and admitting the `email.received` message. Their webhook
event provides a received-email ID; it is not the MIME body. Verify provider
authentication evidence rather than trusting sender-supplied headers. For
outbound delivery, Resend's API idempotency key is valid for 24 hours, so an
unknown submission older than that window cannot simply be repeated with the
same key. This is a transport choice for the replacement host, not a reason
to silently mark an uncertain mail delivered or failed. See [Resend webhook
verification](https://www.resend.com/changelog/managing-webhooks-via-api) and
[Resend idempotency](https://resend.com/changelog/idempotency-keys).

Acceptance evidence for the final host: authentic inbound MIME and a funded
wallet produce exactly one durable Frank message across process interruption;
the same mailbox envelope produces one signed outbound email and one credit
debit across restarts; mailbox truncation/incomplete rows cannot be skipped;
transport timeout cannot trigger a duplicate after the provider's idempotency
window; wallet recovery finishes the original authorized payment. Run the
package integration tests and `yarn typecheck:fast` before GKE deployment.

The inbound coordinator adds no SQLite tables, wallet records or wire payloads.
It does not activate the executable or the legacy SMTP path. Its unfinished
slot listing is read-only; any failed recovery slot stays in the journal and
is reported while other slots continue. The remaining host/transport stages
must be reviewed before mail can be offered to judges.

## Gateway discovery

The operator must advertise the gateway's public Frank identity and email
domain from the selected relay's API, keyed by exact canonical
`chainIdentifier`. This is operator configuration, not a protocol-wide chain
fact and not a key embedded in the PWA. The relay must validate the configured
identity and domain and refuse a mismatched network. The client must verify the
relay response against its selected canonical chain, reject missing or malformed
advertisements, and expose an explicit unavailable state. A changed advertised
identity must not silently retarget an existing email conversation or an
in-flight payment; show the new identity for confirmation or bind it only to
new conversations. An explicit user override may remain, scoped to its chain
and visibly distinct from the relay default. Remove the compiled
`0x1111111111111111111111111111111111111111` fallback from production
resolution when this discovery path lands. Profile-owned
`emailBridgeGatewayAddress` is not an operator advertisement.
