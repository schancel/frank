"""Generate test/fixtures/lotus-v2/fee-vectors-keyhash.json from the Lotus reference.

Vectors for what the shared Lotus file (tools/lotus-v2-reference/vectors/
fee_vectors.json, copied as test/fixtures/lotus-v2/fee_vectors.json) lacks:
spends of Frank's 37-byte keyhash program. Every number
comes from the reference module; this script only maps a decoded transaction
to the reference's inputs and the wallet cu share ruled on 2026-11-19 to the
reference's primitives. It never writes inside the Lotus repository.

    npx tsx test/lotus-v2-fee-cases.ts --print > /tmp/cases.json
    PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=$LOTUS/tools/lotus-v2-reference \
      python3 -I scripts/lotus-v2-fee-vectors.py $LOTUS /tmp/cases.json \
      > test/fixtures/lotus-v2/fee-vectors-keyhash.json

`-I` ignores PYTHONPATH, so the script adds the reference path itself from
the first argument. Needs the `blake3` Python package (requirements.txt of the
reference) because the reference decoder imports it.
"""

import hashlib
import json
import subprocess
import sys

LOTUS = sys.argv[1]
REFERENCE = LOTUS + "/tools/lotus-v2-reference"
sys.path.insert(0, REFERENCE)

from lotus_v2_reference import monetary as m  # noqa: E402
from lotus_v2_reference import resources as r  # noqa: E402
from lotus_v2_reference import signing, vm, vm_cost  # noqa: E402
from lotus_v2_reference.encoding import encode_output  # noqa: E402

TX_PROFILE = signing.TxProfile(256, 256, 256, 10000, 65535, 8192, 64)
OUT_PROFILE = signing._OUTPUT_PROFILE

# The approved VM charges: recommended_opcodes() with DEFAULT_OP elsewhere,
# BIP340 210 for CHECKSIG/CHECKSIGVERIFY (resources.py SIG_BIP340).
_ops = r.recommended_opcodes()
_costs = {}
for _op in vm.ASSIGNED:
    if _op in (0xbb, 0xbc):
        _costs[_op] = r.SIG_BIP340
    elif _op == 0xbd:
        _costs[_op] = r.SIG_ED25519
    else:
        _c = _ops.get(_op, r.DEFAULT_OP)
        _costs[_op] = (lambda c: lambda o, res: c.charge(o, res))(_c)
VM_PROFILE = vm.VMProfile(10000, 65535, 8192, 1000, 1000, 1 << 24, 64,
                          r.INVOCATION_CAP, r.STRUCTURAL_BYTE, _costs,
                          r.ENFORCE_PER_OUTPUT)

# Launch anchors (C16) with the approved burn shifts (P05).
PROFILE = m.Profile(boot_shift=20, tx_knee_shift=18, ema_shift=10,
                    ema_min=1 << 34, linear_shift=32, quad_shift=32,
                    dust_limit=546, min_fee_per_kb=1000,
                    genesis_tail=378_000_000,
                    genesis_work=1_800_000_641_450_944)
T_G, W_G = PROFILE.genesis_tail, PROFILE.genesis_work
B_1 = (157_286_400_000 * 10**6) >> 20  # block 1's bootstrap payment

STATES = [
    {"name": "calibration point, quiet chain (I = 1, E below E_min)",
     "ema": 0, "byteFeeIndex": (T_G, W_G)},
    {"name": "block 1 of the bootstrap (I about 398)",
     "ema": 1 << 34, "byteFeeIndex": (B_1 + T_G, W_G)},
    {"name": "E = 2^36, I = 1, rest of block 2^20 cu",
     "ema": 1 << 36, "byteFeeIndex": (T_G, W_G), "blockCostCu": 1 << 20},
    {"name": "lagged I = 4, own I = 2, E = 2^35, block past E_min",
     "ema": 1 << 35, "byteFeeIndex": (4 * T_G, W_G), "cuIndex": (2 * T_G, W_G),
     "blockCostCu": (1 << 34) + (1 << 30)},
]


def ceil_sqrt(n):
    root = m.isqrt(n)
    return root + (root * root < n)


def cs(n):
    return r.cs(n)


def shape(tx, coins):
    """The reference TxShape of a decoded transaction and its spent coins."""
    inputs = []
    for inp, coin_hex in zip(tx.inputs, coins):
        core = len(signing._input_wire(inp, TX_PROFILE, True))
        full = len(signing._input_wire(inp, TX_PROFILE, False))
        witnesses = []
        for w in inp.witnesses:
            ast = vm.decode(w.script, VM_PROFILE)
            static = vm_cost.static_size_cost(
                ast, VM_PROFILE, initial_sizes=tuple(len(a) for a in w.arguments),
                script_length=len(w.script), input_count=len(tx.inputs),
                output_count=len(tx.outputs))
            invocation = r.STRUCTURAL_BYTE * len(w.script) + static.cost
            witnesses.append((w, invocation))
        coin = signing.decode_output(bytes.fromhex(coin_hex), OUT_PROFILE)
        inputs.append((inp, core, full, witnesses, coin))

    def out_shape(o):
        return OutputShapeOf(len(encode_output(o, OUT_PROFILE)), bool(o.flags & 2))

    shaped_inputs = tuple(
        ExactInput(core, full, tuple(
            r.WitnessShape(len(w.script), len(w.siblings),
                           tuple(len(a) for a in w.arguments), inv)
            for w, inv in witnesses),
            OutputShapeOf(len(encode_output(coin, OUT_PROFILE)), False))
        for inp, core, full, witnesses, coin in inputs)
    shaped = r.TxShape("decoded", shaped_inputs, tuple(out_shape(o) for o in tx.outputs))
    invocations = [[inv for _, inv in ws] for _, _, _, ws, _ in inputs]
    return shaped, invocations


class OutputShapeOf:
    """An output of a known serialized length (what linear_cost reads)."""

    def __init__(self, length, burn):
        self.length = length
        self.burn = burn
        self.coin_length = r.OutputShape.coin_length.fget(self)


class ExactInput:
    """A spend input whose core/full lengths are read from the wire."""

    kind = 1

    def __init__(self, core, full, witnesses, coin):
        self.core = core
        self.full = full
        self.witnesses = witnesses
        self.coin = coin


def cu_share(c_tx, state):
    """lotus-86 ruling 2026-11-19 (P05 wallet fee estimation), from monetary.py primitives."""
    price = max(state["ema"], PROFILE.ema_min)
    index = m.FeeIndex(*state.get("cuIndex", state["byteFeeIndex"]))
    linear = -(-(c_tx * price) // (1 << PROFILE.linear_shift))
    indexed = ceil_sqrt(m._index_radicand(linear, index, PROFILE))
    base = state.get("blockCostCu", 0)
    after = base + c_tx
    excess = max(0, after - PROFILE.ema_min)
    q_up = max(-(-(after * after) // (1 << PROFILE.quad_shift)),
               -(-(index.subsidy * excess * excess) // (PROFILE.ema_min ** 2)))
    q = q_up - m.concentration(base, index.subsidy, PROFILE)
    return 2 * indexed, 2 * q


def file_digest(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    cases = json.load(open(sys.argv[2]))
    head = subprocess.run(["git", "-C", LOTUS, "rev-parse", "HEAD"],
                          capture_output=True, text=True, check=True).stdout.strip()
    sources = {name: file_digest(f"{REFERENCE}/lotus_v2_reference/{name}")
               for name in ("monetary.py", "resources.py", "vm.py", "vm_cost.py",
                            "signing.py")}
    out = []
    for case in cases:
        frame = bytes.fromhex(case["tx"])
        tx = signing.decode_transaction(frame, TX_PROFILE)
        shaped, invocations = shape(tx, case["coins"])
        if shaped.wire != len(frame):
            raise SystemExit(f"{case['name']}: shape wire {shaped.wire} != {len(frame)}")
        linear = r.linear_cost(shaped, r.APPROVED)
        c_tx = m.transaction_cost(linear, PROFILE)
        tokens = sum(1 for o in tx.outputs if o.flags & 1)
        token_burn = 2 * PROFILE.dust_limit * tokens
        byte_fee = m.byte_fee(len(frame), PROFILE)
        priced = []
        for state in STATES:
            lagged = m.FeeIndex(*state["byteFeeIndex"])
            indexed_byte = m.indexed_byte_fee(len(frame), lagged, PROFILE)
            share, q = cu_share(c_tx, state)
            consensus = max(indexed_byte, token_burn)
            priced.append({
                "state": state["name"],
                "indexedByteFee": str(indexed_byte),
                "cuShare": str(share),
                "qShare": str(q),
                "total": str(max(consensus, token_burn + share + q)),
            })
        out.append({
            "name": case["name"], "tx": case["tx"], "coins": case["coins"],
            "size": len(frame),
            "invocationCosts": [[str(v) for v in ws] for ws in invocations],
            "linearCost": str(linear), "transactionCost": str(c_tx),
            "byteFee": str(byte_fee), "tokenOutputs": tokens,
            "tokenBurn": str(token_burn), "priced": priced,
        })
    states = []
    for s in STATES:
        row = {"name": s["name"], "ema": str(s["ema"]),
               "byteFeeIndex": {"subsidy": str(s["byteFeeIndex"][0]),
                                "work": str(s["byteFeeIndex"][1])}}
        if "cuIndex" in s:
            row["cuIndex"] = {"subsidy": str(s["cuIndex"][0]), "work": str(s["cuIndex"][1])}
        if "blockCostCu" in s:
            row["blockCostCu"] = str(s["blockCostCu"])
        states.append(row)
    json.dump({
        "schema": "frank/lotus-v2-fee-vectors/1",
        "generator": "packages/nakamoto/scripts/lotus-v2-fee-vectors.py",
        "reference": {"repository": "Lotus", "head": head,
                      "note": "working tree as read, uncommitted docs; sha256 of the files used",
                      "files": sources},
        "anchors": {"genesisTail": str(T_G), "genesisWork": str(W_G)},
        "rulings": "lotus-86 2026-11-19: C_tx by the reference size pass; cuShare = "
                   "2*ceil(ceil(C_tx*M/2^32)*sqrt(I_n)) + 2*(Q_up(base+C_tx) - Q_floor(base)); "
                   "total = max(IndexedByteFee, tokenBurn + cuShare + qShare); margin 0",
        "states": states, "cases": out,
    }, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
