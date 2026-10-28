# Working personas

These three fictional profiles are design and usability testing aids. They are working
hypotheses, not researched people, established audience segments, or evidence of demand.

The owner reports roughly 600 people actively interested in Stamp in 2021–2022. Asking people
did not establish why they were interested. That observation does not validate any particular
motivation, including ideology, anonymity, payments, or privacy.

The tentative starting audience is privacy-minded, crypto-minded people who are **not
technical**. Even their motivations remain uncertain. The longer-term ambition includes the
broader range of people who already use Telegram, Signal, or email; these profiles do not
establish that those people will want Frank.

| Fictional profile             | A situation to test                                        |
| ----------------------------- | ---------------------------------------------------------- |
| [Maya](maya-community.md)     | Keeping up with people, invitations, and communities       |
| [Sam](sam-everyday-sender.md) | Private everyday messages and occasional small payments    |
| [Alex](alex-new-device.md)    | Trying Frank, using a second device, and recovering access |

The common question is concrete: can an interested Stamp user try, understand, and use Frank
without technical help, on both mobile and desktop? Run the same task on each layout, ask the
person to explain what happened, and record where help was needed. Revise these hypotheses
from observed behavior rather than treating a fictional biography as validation.

Use ordinary language in the interface. Someone may recognize a wallet or an address without
understanding how a payment works underneath. No normal task should require an explanation of
relays, RPC, nonces, or coin pools. Explain any required payment, amount, and cost before consent;
show pending, partial, failed, and completed outcomes honestly.

The profiles describe observable expectations for existing intended flows; they do not approve
new features, protocols, or privacy guarantees. Use disposable accounts for recovery exercises.
Keep pass/fail evidence separate: the tracked [local HA test record](../plans/relay-ha-cluster-local-test.md)
describes implementation checks and their scope. These profiles are not proof that those checks
or a mobile, desktop, payment, or recovery scenario have passed.
