# Mail local-part policy

`reserved-local-parts-v1.json` is the shared, case-insensitive denylist for
relay username claims and user-issued email local parts. `bounce+…` is also
reserved as an entire local-part prefix. Operator aliases are outside the
Frank user-mailbox mapping; the mail host must route them to a separately
managed mailbox or reject them.

The current mail gateway accepts only an explicitly injected issued-mailbox
lookup. A directory username, raw account address, or catch-all SMTP recipient
does not issue a mailbox and cannot trigger credit consumption or a Frank
stamp. Direct SMTP remains a supported ingress, but untrusted SMTP bounce
messages cannot trigger paid Frank notifications. A future authenticated
bounce importer must have its own durable event identity and authorization
check before it can send.

This policy does not rename or erase previously stored relay claims. Before
enabling mail address issuance in an environment with existing claims, the
operator must audit the reserved names against the directory and resolve any
collisions explicitly with the claimant. New claims of those names receive
`reserved-username`; they never become user mailboxes.
