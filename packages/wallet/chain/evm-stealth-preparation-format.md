# EVM preparation format 2

The native operation journal owns all transaction bytes, nonce claims and chain observations.
The preparation record owns intent, the frozen quoted source allocation, fee authorization,
the journal link, and the host exposure digest. A quote allocates no spend reservation.
An approved preparation never reselects sources or amounts after a restart.

Format 2 adds an explicit version and the complete quoted allocation. Unsupported development
records fail wallet activation; there is no migration, inferred allocation, or automatic reset.
For development, use a fresh isolated test wallet profile and retain the previous profile intact.
Do not delete keys, the native operation journal, received coin inventory, or unrelated app data.
If an old profile contains authorized or possibly exposed operations, finish/reconcile those
original operations with its matching frozen build before reviewing any reset of its preparation
namespace. This change supplies no destructive reset command.

One payment supports at most 16 independent native or configured ERC20 transfers to one
recipient destination. Source amounts sum to the intended amount; native transaction fees are
one separately approved total ceiling. ERC20 sources each supply their own native gas.
No consolidation, gas funding, new wire schema, or production feature enable is included.
