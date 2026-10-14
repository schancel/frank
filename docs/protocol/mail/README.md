# Mail local-part policy

`reserved-local-parts-v1.json` is the shared, case-insensitive denylist for
relay username claims and user-issued email local parts. `bounce+…` is also
reserved as an entire local-part prefix. Operator aliases are outside the
Frank user-mailbox mapping; the mail host must route them to a separately
managed mailbox or reject them.

`MailJournal` format 8 owns explicit, immutable mailbox issuance. Its durable
marker binds the canonical chain, gateway account and mail domain; reopening
under another domain is refused before any signed SMTP job can be claimed. A local part
maps to one scoped Frank account and optionally one conversation ID; a repeat
assignment is idempotent and a conflicting assignment is refused. The
`createIssuedMailboxLookup` adapter lets both direct SMTP and a future signed
webhook importer use this same table. The current daemon still requires the
host to inject that adapter; it does not issue aliases on startup. A directory
username, raw account address, or catch-all SMTP recipient does not issue a
mailbox and cannot trigger credit consumption or a Frank stamp. Direct SMTP
remains a supported ingress, but untrusted SMTP bounce
messages cannot trigger paid Frank notifications. A future authenticated
bounce importer must have its own durable event identity and authorization
check before it can send.

This policy does not rename or erase previously stored relay claims. Before
enabling mail address issuance in an environment with existing claims, the
operator must audit the reserved names against the directory and resolve any
collisions explicitly with the claimant. New claims of those names receive
`reserved-username`; they never become user mailboxes.

Formats 2 through 7 are refused by the format 8 reader without mutation. Format 8
stores the envelope local part and its assigned conversation on each inbound delivery,
including held mail. One RFC message addressed to two issued aliases has two independent
delivery keys and durable slots. It also stores the admitted stamp value, including
while held; a later credit top-up cannot change the intended payment amount.
Outbound jobs in format 8 bind an issued sender local part to the same account
and conversation as the bridged message. Both signed From and Reply-To must
equal that routable address before a job can be claimed or handed to SMTP.
Jobs must be claimed durably before provider submission.
`submitting` after a restart and `uncertain` after an ambiguous response are
operator reconciliation states; neither is automatically retried. Positive
Resend sent-email evidence can mark a claimed job accepted, after checking its
Message-ID, issued sender alias, recipient, and submission time. An absent
listing result never authorizes a resend. Reconciliation returns a provider
page cursor while scanning one bounded job batch, then a job cursor to scan
past unresolved older jobs. A host must continue those cursors and start a new
pass at job ID zero later; keeping only the first page would starve later jobs.
Only a
confirmed rejection can return a claimed job to `pending` or mark it `failed`.
`JournaledFrankOutbound` is the headless Frank-to-email intake handler for one
plain-text recipient. It derives a stable private-salt reply alias per Frank
account and conversation, and commits the Frank disposition, mailbox issuance,
and exact outbound bytes in one SQLite transaction before the mailbox cursor
advances. Rich HTML, attachments, multiple recipients and custom Reply-To are
rejected as unsupported rather than partly forwarded. The salt must be derived
from the restored gateway root and remain stable across hosts and restarts.
Archive the journal together with its gateway wallet stores before starting a new
prelaunch format 8 instance; do not discard a funded gateway wallet or replay
an ambiguous payment as a new one.

## RFC 5322 Header-Based Threading & Sender Formatting

Inbound and outbound email messages use standard RFC 5322 header-based threading (`Message-ID`, `In-Reply-To`, and `References` chains) persisted in `MailJournal` (`packages/email-gateway`) alongside legacy `m<30-hex>` reply-alias compatibility:

- **Outbound Threading**: When bridging a Frank conversation to SMTP, the gateway generates a deterministic RFC 5322 `Message-ID` bound to the Frank message digest and populates `In-Reply-To` and `References` from prior bridged messages in the same conversation thread.
- **Canonical Sender Formatting**: Outbound `From` headers format the sender's verified relay username when available (`"<displayName>" <username@domain>`) or fall back to the issued conversation local part, while `Reply-To` always binds to the issued conversation reply alias so standard email client replies route back to the exact Frank thread.
- **Inbound Threading Resolution**: When an external email arrives, the gateway resolves the target Frank conversation by matching `In-Reply-To` / `References` header IDs against recorded outbound/inbound message IDs in `MailJournal`, falling back to the recipient `m<30-hex>` conversation alias when headers are absent.

## OpenPGP Web Key Directory (WKD) & Autocrypt Interoperability

The relay and email gateway expose a standards-compliant OpenPGP Web Key Directory (`/.well-known/openpgpkey`) supporting both Advanced (`/.well-known/openpgpkey/<domain>/hu/<zbase32-sha1>`) and Direct (`/.well-known/openpgpkey/hu/<zbase32-sha1>`) lookup methods plus the required `policy` endpoint:

- Every user with a registered relay username and published identity/encryption key material is automatically discoverable by external OpenPGP-capable mail clients (Thunderbird, Proton Mail, K-9 Mail, Delta Chat) via the 32-character z-base-32 SHA-1 hash of their lowercase local part.
- Outbound bridged emails also attach `Autocrypt` headers so external mail clients can opportunistically encrypt replies without manual key server lookups.

## Single-Record Domain Discovery (`/.well-known/cashweb.json`)

Operators can onboard an entire domain with a single HTTPS static file or proxy route at `GET /.well-known/cashweb.json` (with `_cashweb.<domain>` DNS TXT and SRV records as optional fallback). The JSON document declares the authoritative relay endpoint, mail gateway domain, cluster authority public key, and supported payment networks so Frank clients and external relays resolve domain handles (`alice@example.com`) in one round-trip.

## Secure Portal Claim Links & Outbound Reply Allowance

- **Self-Custodial Claim Links (`/onboard`)**: When a Frank user sends an email or stamped message to an external recipient who does not yet have a Frank wallet, the email gateway can include a secure claim link (`/onboard#...`) where the claim secret remains in the URL fragment (never sent to the HTTP server in request headers or logs). Opening the link guides the recipient through passkey/seed onboarding and sweeps the escrowed stamp or reply credit into their new self-custodial wallet.
- **Automatic Outbound `replyAllowance`**: When a Frank user sends an outbound bridged email whose attached stamp covers the gateway's `inboundStampValue` threshold, `JournaledFrankOutbound` automatically credits a `replyAllowance` for that `(account, conversation, externalRecipient)` tuple in `MailJournal`, allowing the external email recipient's reply to be stamped and delivered back into the sender's Frank inbox without requiring the external email user to hold crypto first.

