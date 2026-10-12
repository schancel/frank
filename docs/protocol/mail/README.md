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
