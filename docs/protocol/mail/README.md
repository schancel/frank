# Mail local-part policy

`reserved-local-parts-v1.json` is the shared, case-insensitive denylist for
relay username claims and user-issued email local parts. `bounce+…` is also
reserved as an entire local-part prefix. Operator aliases are outside the
Frank user-mailbox mapping; the mail host must route them to a separately
managed mailbox or reject them.

`MailJournal` format 4 owns explicit, immutable mailbox issuance. A local part
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

Format 2 and 3 journals are refused by the format 4 reader without mutation. Format 4
stores the envelope local part and its assigned conversation on each inbound delivery,
including held mail. One RFC message addressed to two issued aliases has two independent
delivery keys and durable slots. It also stores the admitted stamp value, including
while held; a later credit top-up cannot change the intended payment amount.
Archive the journal together with its gateway wallet stores before starting a new
prelaunch format 4 instance; do not discard a funded gateway wallet or replay
an ambiguous payment as a new one.
