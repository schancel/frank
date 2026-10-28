# Sam — everyday messages and occasional payments

Fictional working hypothesis; this is not a validated payment-use segment.

Sam has used a crypto wallet a few times and understands that payments can cost money.
He wants to send personal messages and occasionally attach a modest payment to someone he
knows. He does not think in network internals or want to maintain accounts manually.

His possible motivation is handling a conversation and its payment together with clear consent.
The trial must establish whether he wants this at all and what he expects “private” to mean;
the profile makes no anonymity or confidentiality claim about a particular feature.

## Normal tasks

- Start or reopen a conversation with the intended person.
- Read the amount, recipient, and costs before approving a payment.
- Send an ordinary message while an earlier payment is still pending.
- Check what the recipient has actually received and what remains unresolved.

## Observable acceptance on mobile and desktop

- Sam can explain the recipient amount separately from fees and message costs before consent.
- Cancelling the review does not authorize a payment; the completed action matches his review.
- A displayed balance does not lead him to believe reserved or unsettled funds are ready to use.
- Message delivery alone does not claim that its attached payment is fully received.
- An interruption leaves a clear pending or failure explanation. Retrying an authorized action
  does not invite an accidental second payment or require Sam to interpret transaction nonces.
- A minimum amount or unavailable payment is explained with an actionable choice, without
  requiring RPC, relay, gas, or coin-pool knowledge.
