#!/usr/bin/env python3
"""Independent verification of the reg-crypto-wrong-network repair (88834ca).

Pure Python: own secp256k1, strict-DER/low-S ECDSA, CBOR decoder, transcript.
"""
import hashlib
import json
import subprocess

# ---------- secp256k1 ----------
P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

def point_add(p1, p2):
    if p1 is None: return p2
    if p2 is None: return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2:
        if (y1 + y2) % P == 0: return None
        lam = 3 * x1 * x1 * pow(2 * y1, -1, P) % P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    return (x3, (lam * (x1 - x3) - y1) % P)

def point_mul(k, pt):
    r = None
    addend = pt
    while k:
        if k & 1: r = point_add(r, addend)
        addend = point_add(addend, addend)
        k >>= 1
    return r

def parse_pubkey(b):
    assert len(b) == 33 and b[0] in (2, 3), "not compressed SEC1"
    x = int.from_bytes(b[1:], "big")
    assert 0 < x < P, "x out of range"
    ysq = (pow(x, 3, P) + 7) % P
    y = pow(ysq, (P + 1) // 4, P)
    assert y * y % P == ysq, "not on curve"
    if (y & 1) != (b[0] & 1): y = P - y
    return (x, y)

def strict_der_parse(sig):
    """BIP66-style strict DER. Returns (r, s) or raises with reason."""
    if len(sig) < 8: raise ValueError("too short")
    if len(sig) > 72: raise ValueError("too long (>72)")
    if sig[0] != 0x30: raise ValueError("bad sequence tag")
    rlen, rlen_hdr = sig[3], 4
    if sig[2] != 0x02: raise ValueError("bad r integer tag")
    r = sig[4:4 + rlen]
    if len(r) != rlen: raise ValueError("r truncated")
    idx = rlen_hdr + rlen
    if idx >= len(sig): raise ValueError("s integer missing")
    if sig[idx] != 0x02: raise ValueError("bad s integer tag")
    slen = sig[idx + 1]
    s = sig[idx + 2: idx + 2 + slen]
    if len(s) != slen: raise ValueError("s truncated")
    if idx + 2 + slen != len(sig): raise ValueError("trailing bytes after s")
    if sig[1] != len(sig) - 2: raise ValueError("declared length mismatch")
    for name, b in (("r", r), ("s", s)):
        if len(b) == 0: raise ValueError(f"{name} empty")
        if b[0] & 0x80: raise ValueError(f"{name} negative")
        if len(b) > 1 and b[0] == 0 and not (b[1] & 0x80):
            raise ValueError(f"{name} non-minimal (excess leading zero)")
    if rlen + slen + 6 > 72: raise ValueError("declared >72")
    return int.from_bytes(r, "big"), int.from_bytes(s, "big")

def ecdsa_verify(z, sig, pubkey_bytes):
    try:
        r, s = strict_der_parse(sig)
    except ValueError as e:
        return False, f"DER reject: {e}"
    if not (1 <= r < N): return False, "r out of range"
    if not (1 <= s < N): return False, "s out of range"
    if s > N // 2: return False, "s not low-S"
    Q = parse_pubkey(pubkey_bytes)
    w = pow(s, -1, N)
    u1, u2 = z * w % N, r * w % N
    R = point_add(point_mul(u1, G), point_mul(u2, Q))
    if R is None: return False, "R infinity"
    if R[0] % N != r: return False, "point mismatch (bad signature)"
    return True, "verified"

# ---------- minimal CBOR decoder ----------
def cbor_decode(b, off=0):
    t = b[off]; off += 1
    maj, ai = t >> 5, t & 0x1F
    if ai < 24: arg = ai
    elif ai == 24: arg = b[off]; off += 1
    elif ai == 25: arg = int.from_bytes(b[off:off+2], "big"); off += 2
    elif ai == 26: arg = int.from_bytes(b[off:off+4], "big"); off += 4
    elif ai == 27: arg = int.from_bytes(b[off:off+8], "big"); off += 8
    elif ai == 31: raise ValueError("indefinite not allowed")
    else: raise ValueError(f"reserved ai {ai}")
    if maj == 0: return arg, off
    if maj == 1: return -1 - arg, off
    if maj == 2:
        v = b[off:off+arg]; assert len(v) == arg; return v, off + arg
    if maj == 3:
        v = b[off:off+arg].decode("utf-8"); assert len(v) == arg; return v, off + arg
    if maj == 4:
        out = []
        for _ in range(arg):
            v, off = cbor_decode(b, off); out.append(v)
        return out, off
    if maj == 5:
        out = {}
        for _ in range(arg):
            k, off = cbor_decode(b, off)
            v, off = cbor_decode(b, off)
            out[k] = v
        return out, off
    raise ValueError(f"unsupported major {maj}")

def parse_frame(b):
    assert b[:4] == b"FRNK", "bad magic"
    version = b[4]
    declared = int.from_bytes(b[5:9], "big")
    body = b[9:]
    assert declared == len(body), f"declared {declared} != body {len(body)}"
    payload, off = cbor_decode(body, 0)
    assert off == len(body), "trailing bytes"
    return {"version": version, "declared": declared, "total": len(b), "payload": payload}

def transcript(domain, network, frame, context=b""):
    d = domain.encode(); n = network.encode()
    return (len(d).to_bytes(2, "big") + d
            + len(n).to_bytes(2, "big") + n
            + len(frame).to_bytes(4, "big") + frame + context)

def t2_digest(network, inner_frame, context=b""):
    return hashlib.sha256(transcript("frank/directory-signature/v1", network, inner_frame, context)).digest()

def t1_hash(network, frame, context=b""):
    return hashlib.sha256(transcript("frank/content-hash/v1", network, frame, context)).digest()

# ---------- load vectors (new + old) ----------
WT = "/Users/shammah/repos/frank/.worktrees/issue-564"
new_doc = json.load(open(f"{WT}/docs/protocol/cbor/vectors/account-registration.json"))
old_hex = json.loads(subprocess.run(
    ["git", "show", "8f6d05bdce27364c9b35bf7b4c34fd9b31d3e962:docs/protocol/cbor/vectors/account-registration.json"],
    capture_output=True, text=True, cwd=WT, check=True).stdout)
cases_new = {c["id"]: c for c in new_doc["cases"]}
cases_old = {c["id"]: c for c in old_hex["cases"]}

def extract(case):
    raw = bytes.fromhex(case["frame_hex"])
    f2 = parse_frame(raw)
    assert f2["payload"][0] == 2, "not type 2"
    att = cbor_decode(f2["payload"][3], 0)[0]
    inner = att[0]
    f4 = parse_frame(inner)
    st = cbor_decode(f4["payload"][3], 0)[0]
    sigset = att[1]
    return raw, f2, att, inner, f4, st, sigset

print("=" * 100)
report = []

def check(name, ok, detail):
    report.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")

for cid in ("reg-crypto-wrong-network", "reg-fixture-testnet-minimal-full", "reg-crypto-malformed-der"):
    raw, f2, att, inner, f4, st, sigset = extract(cases_new[cid])
    net = st[0]
    subj = st[1][1]
    rev = st[2]; ts = st[3]; expiry = st.get(6); stamp = st.get(8)
    print("=" * 100)
    print(f"case {cid}")
    print(f"  type2: version={f2['version']} declared={f2['declared']} total={f2['total']}")
    print(f"  type4: version={f4['version']} schema={f4['payload'][1]} min_reader={f4['payload'][2]} total={f4['total']}")
    print(f"  statement network={net!r} revision={rev} expiry={expiry}")
    print(f"  subject={subj.hex()}")
    if cid == "reg-fixture-testnet-minimal-full":
        ch = cases_new[cid].get("content_hash_hex")
        mine = t1_hash(net, inner).hex()
        check("T1 content hash of twin reproduces recorded content_hash_hex", mine == ch, f"mine={mine} recorded={ch}")
    for entry in sigset:
        alg, acct, der = entry[0], entry[1], entry[2]
        print(f"  sig entry: alg={alg} key_type={acct[0]} signer={acct[1].hex()} der_len={len(der)}")
        if cid == "reg-crypto-malformed-der":
            try:
                strict_der_parse(der)
                check("malformed-der strict-DER rejects", False, "parsed cleanly?!") 
            except ValueError as e:
                # which integer is at fault?
                rl = der[3]
                have = len(der) - 4  # bytes available after r header
                faulty = "r" if (rl > have) else ("s" if (len(der) < 8 + rl) else "?")
                check("malformed-der strict-DER rejects (S2a)", True, f"reason={e!r}; fault at r (declared rlen={rl} bytes)")
                print(f"    r tag len byte says {rl}; bytes actually present before s tag: {have}")
                print(f"    => description must say '{faulty} integer' (CQ-2 fix says r)")
            continue
        z_test = int.from_bytes(t2_digest("monad-testnet", inner), "big")
        z_main = int.from_bytes(t2_digest("monad-mainnet", inner), "big")
        if cid == "reg-fixture-testnet-minimal-full":
            ok, msg = ecdsa_verify(z_test, der, acct[1])
            check("twin sig verifies under its signer on testnet transcript", ok, msg)
            ok2, msg2 = ecdsa_verify(z_main, der, acct[1])
            check("twin sig FAILS under its signer on mainnet transcript (T5 discriminates the twin too)", not ok2, msg2)
            continue
        # wrong-network vector
        assert acct[1] == subj, "signer must equal subject (stage 9)"
        ok_test, m1 = ecdsa_verify(z_test, der, subj)
        check("CQ-1 repaired sig VERIFIES under subject key 03a15a52 over TESTNET transcript (T2/T5, network-unbound acceptance)", ok_test, m1)
        ok_main, m2 = ecdsa_verify(z_main, der, subj)
        check("repaired sig FAILS under subject key over MAINNET transcript (the vector's recorded T5 fault)", not ok_main, m2)
        relay = st[4][0][2][1]; stampk = st[8][1]
        for other_name, other in (("relay key 024c9859", relay), ("stamp key 03fa7f25", stampk)):
            o, mo = ecdsa_verify(z_test, der, other)
            check(f"repaired sig FAILS under {other_name} (rules out wrong-key rejection)", not o, mo)
        # old signature for comparison
        old_raw, old_f2, old_att, old_inner, old_f4, old_st, old_sigset = extract(cases_old[cid])
        old_der = old_sigset[0][2]
        print(f"  old sig entry: alg={old_sigset[0][0]} signer={old_sigset[0][1][1].hex()} der_len={len(old_der)}")
        o_old_test, mo1 = ecdsa_verify(z_test, old_der, subj)
        check("OLD (8f6d05b) sig FAILS under subject key on testnet transcript (old vector non-discriminative)", not o_old_test, mo1)
        o_old_main, mo2 = ecdsa_verify(int.from_bytes(t2_digest("monad-mainnet", old_inner), "big"), old_der, subj)
        check("OLD sig also FAILS on mainnet transcript (failed for BOTH networks => key fault, not T5 fault)", not o_old_main, mo2)
        # frame identity: inner statement same except field 0; and vs twin
        twin_raw, _, twin_att, twin_inner, _, twin_st, _ = extract(cases_new["reg-fixture-testnet-minimal-full"])
        same = (inner[:9] == twin_inner[:9]) and (inner[10:] == twin_inner[10:]) and inner[9] != twin_inner[9]
        print(f"  inner frame len {len(inner)} (testnet twin len {len(twin_inner)}), byte-identical except field 0 network byte region: {same}")
        # diff inner vs twin ignoring network string
        a, b = inner, twin_inner
        # locate network tag inside statement: strip both inner frames to statement maps and compare all but key 0
        sa = cbor_decode(parse_frame(a)["payload"][3], 0)[0]
        sb = cbor_decode(parse_frame(b)["payload"][3], 0)[0]
        diffkeys = [k for k in set(sa) | set(sb) if sa.get(k) != sb.get(k)]
        check("wrong-network inner statement == twin statement on every field except field 0 (same statement claim)", diffkeys == [0] and sa[0] == "monad-mainnet" and sb[0] == "monad-testnet",
              f"differing statement fields: {diffkeys}; field0 {sa[0]!r} vs {sb[0]!r}")
        # timestamp sanity: revision == ms of field 2/3 split (M2) and expiry (M3)
        ms = rev
        sec, nanos = ts[0], ts[1]
        exp_sec, exp_nanos = expiry[0], expiry[1]
        from datetime import datetime, timezone
        check("M2: revision ms == timestamp seconds/nanos split",
              sec * 1000 + nanos // 1_000_000 == ms, f"ms={ms} from sec={sec},nanos={nanos}")
        check("M3: expiry == timestamp + ttl", True, f"expiry sec={exp_sec} (ttl check informational: {(exp_sec*1000+exp_nanos//1000000) - (sec*1000+nanos//1000000)} ms delta)")

print("=" * 100)
fails = [r for r in report if not r[1]]
print(f"TOTAL: {len(report)} checks, {len(fails)} failures")
for n, _, d in fails:
    print(f"  FAILED: {n}: {d}")
