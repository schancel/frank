# Mail gateway production boundary

`yarn start` selects [the daemon](src/bin/daemon.ts), which loads validated
configuration and calls [startMailGateway](src/host/gateway-service.ts). The host
opens an explicitly bound testnet wallet and composes the journaled inbound,
Frank mailbox, outbound transport and recovery paths.

This describes source composition, not production acceptance. Real SMTP/provider
delivery, funded sends, interruption/restart recovery and restoration still need
acceptance on the intended runtime before deployment or routing MX/webhooks to it.

## Current ownership and startup

The executable selects [createJournaledMailHost](src/host/journaled-mail-host.ts).
`MailJournal` owns durable
inbound admission, Frank send slots, thread identity, mailbox position and
outbound jobs, including exact signed bytes persisted before submission.
`CreditLedger` owns credit balances; its debit joins the journal's SQLite
admission transaction.

The host owns lifecycle and wires typed wallet messaging, the journal and mail
transports. Both ingress paths must authenticate the sender and feed the same
durable admission path. Wallet custody owns keys/signing and wallet recovery;
the journal binds each mail to the wallet's stable message ID and payload digest.
A transport receipt is separate from a wallet delivery/payment result.

The selected startup sequence is:

1. [loadGatewayHostConfig](src/host/gateway-config.ts) requires explicit identity,
   storage, domain, relay and listener settings. Required Resend credentials come
   from protected files; native SMTP is optional and requires its complete TLS/listener
   configuration. [openGatewayWallet](src/host/gateway-wallet.ts) validates the
   existing owner-only roots, expected identity and canonical network-bound wallet
   state. Startup does not replace a missing funded wallet with a fresh one.
2. `createJournaledMailHost` opens the identity/domain-bound journal, credit ledger
   and blob store, and installs `JournaledInboundSend`, `JournaledFrankMailbox`,
   `JournaledFrankOutbound`, `JournaledOutboundWorker` and provider reconciliation.
   Normal `existing` journal mode refuses a missing journal; `provision` is an
   explicit initialization mode. The current journal format is 9; the existing
   format-8 migration retains its backup. Other unsupported formats fail clearly.
3. The host opens directory storage and starts profile publication, then awaits
   [JournaledMailRuntime.runOnce](src/host/journaled-runtime.ts) before starting the
   webhook listener and configured native SMTP listener. Recovery covers held
   admissions, original Frank send slots, inclusive mailbox polling, outbound jobs
   and uncertain provider submissions. Persist complete send intent before wallet
   exposure, consume credit once, and never create a fresh send from replayed mail.
4. Periodic recovery passes control ingress readiness; a failed pass marks ingress
   unavailable while retaining durable work for reconciliation. Shutdown marks
   ingress unavailable, waits for active work and closes the host, directory and
   wallet. Uncertain SMTP acceptance remains fenced rather than authorizing a
   duplicate submission. Do not delete or reset funded state to clear a refusal.

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

Source composition and package tests do not establish those runtime outcomes.
Failed recovery slots remain durable and observable while other slots can
continue; a failed recovery pass must not be represented as healthy ingress.
Protected state restoration, real transport authentication/delivery and funded
wallet recovery remain release acceptance gates.

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
and visibly distinct from the relay default. Current
[client resolution](../../app/src/stores/settings.ts) uses a verified relay
advertisement or an explicit override, returns unavailable without one, and
marks changed advertisements for confirmation; it has no compiled-address
fallback. Actual operator advertisement and intended-origin behavior still
require runtime qualification. Profile-owned
`emailBridgeGatewayAddress` is not an operator advertisement.


### First-email postage introduction

A normalized, transport-authenticated sender's first inbound email to a normally resolved user mailbox (issued alias, relay username or direct account address) receives three ordinary postage credits, once across all recipients. The existing credit ledger provider transaction records the one-time grant; grant, credit consumption and original send-slot admission commit together. Existing inbound history prevents retroactive introductions to returning senders. The configured inbound stamp amount remains unchanged. Reply allowances retain priority over ordinary credits. Operator contact/operational exemptions require the resolved account to match the configured operator; a user-owned `help`, `info` or `contact` alias uses normal postage.

After the first send is accepted by the relay, the normal recovery pass prepares one welcome receipt. Its balance is ordinary postage (including any purchased credits), measured when the receipt is composed. The existing responder stores the raw receipt before SMTP submission and fences uncertain acceptance; a restart never authorizes another welcome submission. Automated/list/backscatter and rate suppression still apply. This authenticates a sender address; it does not establish one unique human across multiple addresses or create a global promotion budget.

The receipt links to the journal-backed delivery/postage page. Pending delivery is reported as pending, accepted mail never asks for payment to deliver it again, and verified purchases add configured postage without creating a second send. Card top-up is offered only when both a configured tier link and webhook verification are available; otherwise the page says payment is unavailable and offers existing account onboarding.
