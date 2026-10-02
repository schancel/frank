#!/usr/bin/env python3
"""Independent second implementation of section 9 stages 1-7 and the T1 content hash, used to
cross-check the committed manifest against the TypeScript codec.

It shares no code with packages/frank-codec/src. It checks:
  * the manifest against docs/protocol/cbor/vectors.schema.json (jsonschema, draft 2020-12);
  * for every case, stages 1-7 of the root frame (framing, both CBOR passes, envelope, V6
    retention): whenever this implementation fails there the manifest must expect that exact
    category, and for `frame`/`generic` cases an implementation success must be an accept;
  * for every `typed` accept case, the T1 content hash;
  * the README T3b encoding rules for type-5 fields 6-8 and the type-4 field-8 presence rule
    (stage 8.2), over the `stamp-t5-` and `stamp-t4-schema` vectors;
  * the complete account-registration corpus of README section 11 (stages 1-9 for the
    type-2/type-4 shapes, stage 10.6 with a pure-Python strict-DER low-S secp256k1 ECDSA
    verification of the T2 digest), with every recorded category, stage and content hash;
  * the pure-value vectors of account-registration-values.json (M2, M3, M6), including a
    pure-Python Keccak-256.
The rest of stages 8 and 9 of the main corpus is NOT re-implemented here.

Usage: python3 scripts/crosscheck.py            (exit 0 on agreement)
"""
import hashlib
from importlib.metadata import version
import json
import os
import re
import struct
import sys

import jsonschema

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'docs', 'protocol', 'cbor'))
MAX_FRAME, MAX_DEPTH, MAX_CONT, MAX_ITEMS = 8388617, 32, 16384, 131072
MAX_MAP, MAX_ARR, MAX_BSTR, MAX_TSTR = 256, 8192, 8388608, 262144
KNOWN = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17}


class Fail(Exception):
    def __init__(self, cat, stage):
        self.cat, self.stage = cat, stage


class Counters:
    def __init__(self):
        self.cont = 0
        self.items = 0


def head(b, i):
    if i >= len(b):
        raise Fail('malformed', 5)
    ib = b[i]
    major, ai = ib >> 5, ib & 31
    if ai < 24:
        return major, ai, ai, False, 1
    if 28 <= ai <= 30:
        raise Fail('malformed', 5)
    if ai == 31:
        if major in (0, 1, 6):
            raise Fail('malformed', 5)
        return major, ai, 0, True, 1
    n = {24: 1, 25: 2, 26: 4, 27: 8}[ai]
    if i + 1 + n > len(b):
        raise Fail('malformed', 5)
    return major, ai, int.from_bytes(b[i + 1:i + 1 + n], 'big'), False, 1 + n


def valid_utf8(bs):
    try:
        bs.decode('utf-8', errors='strict')
        return True
    except UnicodeDecodeError:
        return False


def scan(b, i, depth, c):
    """Pass A. Returns the offset after the item."""
    while True:
        major, ai, arg, indef, size = head(b, i)
        if major == 7 and indef:
            raise Fail('malformed', 5)
        c.items += 1
        if c.items > MAX_ITEMS:
            raise Fail('resource', 5)
        i += size
        if major in (0, 1):
            return i
        if major in (2, 3):
            limit = MAX_BSTR if major == 2 else MAX_TSTR
            if indef:
                total = 0
                while True:
                    if i >= len(b):
                        raise Fail('malformed', 5)
                    if b[i] == 0xff:
                        return i + 1
                    m2, _, a2, ind2, s2 = head(b, i)
                    if m2 != major or ind2:
                        raise Fail('malformed', 5)
                    i += s2
                    if a2 > limit - total:
                        raise Fail('resource', 5)
                    total += a2
                    if i + a2 > len(b):
                        raise Fail('malformed', 5)
                    if major == 3 and not valid_utf8(b[i:i + a2]):
                        raise Fail('malformed', 5)
                    i += a2
            if arg > limit:
                raise Fail('resource', 5)
            if i + arg > len(b):
                raise Fail('malformed', 5)
            if major == 3 and not valid_utf8(b[i:i + arg]):
                raise Fail('malformed', 5)
            return i + arg
        if major in (4, 5):
            c.cont += 1
            if c.cont > MAX_CONT or depth + 1 > MAX_DEPTH:
                raise Fail('resource', 5)
            d = depth + 1
            lim = MAX_ARR if major == 4 else MAX_MAP
            per = 1 if major == 4 else 2
            if indef:
                n = 0
                while True:
                    if i >= len(b):
                        raise Fail('malformed', 5)
                    if b[i] == 0xff:
                        return i + 1
                    n += 1
                    if n > lim:
                        raise Fail('resource', 5)
                    for k in range(per):
                        if k == 1 and (i >= len(b) or b[i] == 0xff):
                            raise Fail('malformed', 5)
                        i = scan(b, i, d, c)
            if arg > lim:
                raise Fail('resource', 5)
            for _ in range(arg * per):
                i = scan(b, i, d, c)
            return i
        if major == 6:
            continue
        if ai == 24 and arg < 32:
            raise Fail('malformed', 5)
        return i


def minimal(ai, arg):
    return ai < 24 or (ai == 24 and arg >= 24) or (ai == 25 and arg >= 256) or \
        (ai == 26 and arg >= 65536) or (ai == 27 and arg >= 2 ** 32)


def dec(b, i):
    """Pass B over an item already accepted by pass A. Returns (value, next)."""
    major, ai, arg, indef, size = head(b, i)
    if major not in (6, 7) and (indef or not minimal(ai, arg)):
        raise Fail('noncanonical', 5)
    i += size
    if major == 0:
        return arg, i
    if major == 1:
        return -1 - arg, i
    if major == 2:
        return bytes(b[i:i + arg]), i + arg
    if major == 3:
        return b[i:i + arg].decode(), i + arg
    if major == 4:
        out = []
        for _ in range(arg):
            v, i = dec(b, i)
            out.append(v)
        return out, i
    if major == 5:
        out, prev = {}, None
        for _ in range(arg):
            km, kai, karg, kind, ksz = head(b, i)
            if km != 0:
                if km not in (6, 7) and (kind or not minimal(kai, karg)):
                    raise Fail('noncanonical', 5)
                raise Fail('schema', 5)
            if not minimal(kai, karg):
                raise Fail('noncanonical', 5)
            if prev is not None and karg <= prev:
                raise Fail('noncanonical', 5)
            prev = karg
            v, i = dec(b, i + ksz)
            out[karg] = v
        return out, i
    if major == 6:
        raise Fail('schema', 5)
    if ai == 20:
        return False, i
    if ai == 21:
        return True, i
    if ai == 22:
        return None, i
    raise Fail('schema', 5)


def item(b, base_depth, c, stage):
    try:
        end = scan(b, 0, base_depth, c)
        if end != len(b):
            raise Fail('malformed', 5)
        return dec(b, 0)[0]
    except Fail as f:
        raise Fail(f.cat, stage)


def frame_stages(f, ctx, counters):
    """Stages 1-7 of one root frame. Returns ('frame'|'retain'|'ok', info)."""
    if len(f) > ctx['route_byte_limit'] or len(f) > MAX_FRAME:
        raise Fail('resource', 1)
    if len(f) < 9 or f[:4] != b'FRNK':
        raise Fail('frame', 2)
    if f[4] != 1:
        if ctx['opaque_retention_allowed']:
            return 'retain', None
        raise Fail('unsupported', 3)
    if struct.unpack('>I', f[5:9])[0] != len(f) - 9:
        raise Fail('frame', 4)
    if ctx['operation'] == 'frame':
        return 'ok', None
    env = item(f[9:], 0, counters, 5)
    if not isinstance(env, dict) or set(env) != {0, 1, 2, 3}:
        raise Fail('schema', 6)
    t, s, m, p = env[0], env[1], env[2], env[3]
    if not all(isinstance(x, int) and not isinstance(x, bool) for x in (t, s, m)) or \
            not (0 <= t <= 2 ** 32 - 1 and 1 <= s <= 2 ** 32 - 1 and 1 <= m <= 2 ** 32 - 1) or \
            not isinstance(p, bytes) or m > s:
        raise Fail('schema', 6)
    payload = item(p, 1, counters, 7)
    supported = {x['type_id']: x['schema_version'] for x in ctx['supported_schemas']}
    known = t in KNOWN and t in supported
    if (not known or m > ctx['reader_version']):
        if ctx['opaque_retention_allowed']:
            return 'retain', None
        raise Fail('unsupported', 7)
    return 'ok', {'type': t, 'schema': s, 'payload': payload}


def transcript(domain, network, frame):
    d, n = domain.encode(), network.encode()
    return struct.pack('>H', len(d)) + d + struct.pack('>H', len(n)) + n + struct.pack('>I', len(frame)) + frame


def t1(frame, info):
    t, payload = info['type'], info['payload']
    if t in (8, 16, 17):
        net = 'frank'
    elif t == 2:
        inner = payload[0]
        env = dec(inner[9:], 0)[0]
        net = dec(env[3], 0)[0][0]
    else:
        net = payload[0]
    return hashlib.sha256(transcript('frank/content-hash/v1', net, frame)).hexdigest()


def check_topic_commitments():
    """Recomputes T1 (type 9) and T7 (types 10, 11) from the frame bytes alone."""
    doc = json.load(open(os.path.join(ROOT, 'vectors', 'topic-commitments.json')))
    ctx = {'operation': 'typed', 'route_byte_limit': MAX_FRAME, 'reader_version': 1,
           'opaque_retention_allowed': False,
           'supported_schemas': [{'type_id': t, 'schema_version': 1} for t in (9, 10, 11)]}
    bad, n = [], 0
    for c in doc['cases']:
        f = bytes.fromhex(c['frame_hex'])
        kind, info = frame_stages(f, ctx, Counters())
        payload = info['payload']
        if info['type'] == 9:
            got = {'t1_hex': t1(f, info)}
        else:
            if info['type'] == 10:
                inner = bytes(payload[1])
                target = hashlib.sha256(transcript(
                    'frank/content-hash/v1', payload[0], inner)).digest()
            else:
                target = bytes(payload[1])
            pre = (b'frank:topic-vote:v1' + struct.pack('>H', len(payload[0].encode()))
                   + payload[0].encode() + target)
            got = {'target_hash_hex': target.hex(), 't7_preimage_hex': pre.hex(),
                   't7_hex': hashlib.sha256(pre).hexdigest()}
        for k, v in got.items():
            n += 1
            if c[k] != v:
                bad.append('%s: %s differs' % (c['id'], k))
    print('topic-commitments.json: %d values recomputed independently, %d differ' % (n, len(bad)))
    return bad


SECP_P = 2 ** 256 - 2 ** 32 - 977
SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141
SECP_GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
SECP_GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8


def point_ok(b):
    """T3b: 33 bytes, prefix 02/03, x < p, and y^2 = x^3 + 7 has a root (p = 3 mod 4)."""
    if not isinstance(b, bytes) or len(b) != 33 or b[0] not in (2, 3):
        return False
    x = int.from_bytes(b[1:], 'big')
    if x >= SECP_P:
        return False
    rhs = (pow(x, 3, SECP_P) + 7) % SECP_P
    return pow(rhs, (SECP_P - 1) // 2, SECP_P) == 1  # Euler's criterion, not the sqrt shortcut


def proof_ok(b):
    if not isinstance(b, bytes) or len(b) != 64:
        return False
    return all(1 <= int.from_bytes(b[i:i + 32], 'big') < SECP_N for i in (0, 32))


def check_stamp_fields(manifest):
    """Independent stage 8.2 verdict on the stamp vectors: the frame is well formed exactly when
    the manifest says accept, and a rejected one is a `schema` error at stage 8.2."""
    problems, n = [], 0
    for c in manifest['cases']:
        cid = c['id']
        if not (cid.startswith('stamp-t5-') or cid.startswith('stamp-t4-schema')):
            continue
        try:
            kind, info = frame_stages(bytes.fromhex(c['frame_hex']), c['validation_context'], Counters())
        except Fail:
            problems.append('%s: python could not reach stage 8' % cid)
            continue
        t, payload = info['type'], info['payload']
        if t == 5:
            ok = all(k in payload for k in (6, 7, 8)) and point_ok(payload[6]) and \
                point_ok(payload[7]) and proof_ok(payload[8])
        elif t == 4:
            highest = {x['type_id']: x['schema_version'] for x in c['validation_context']['supported_schemas']}[4]
            # V6.3: a newer frame is read through the reader's highest supported schema.
            ok = (8 in payload) == (min(info['schema'], highest) >= 2) or \
                (info['schema'] > highest and 8 in payload)
        else:
            problems.append('%s: unexpected root type %d' % (cid, t))
            continue
        want_ok = c['expectation'] == 'accept'
        if ok != want_ok or (not ok and (c.get('error_category'), c.get('error_stage')) != ('schema', '8.2')):
            problems.append('%s: python says %s, manifest expects %s %s@%s' % (
                cid, 'well formed' if ok else 'malformed', c['expectation'], c.get('error_category'), c.get('error_stage')))
        n += 1
    print('stamp fields (T3b encoding, type-4 field 8): %d vectors checked independently' % n)
    return problems


def main():
    schema = json.load(open(os.path.join(ROOT, 'vectors.schema.json')))
    manifest = json.load(open(os.path.join(ROOT, 'vectors', 'manifest.json')))
    jsonschema.Draft202012Validator(schema).validate(manifest)
    print('manifest conforms to vectors.schema.json (jsonschema %s)' % version('jsonschema'))
    problems, hashes, agreed, skipped = [], 0, 0, 0
    for c in manifest['cases']:
        ctx = c['validation_context']
        f = bytes.fromhex(c['frame_hex'])
        counters = Counters()
        try:
            kind, info = frame_stages(f, ctx, counters)
            failure = None
        except Fail as e:
            kind, info, failure = None, None, e
        exp, cat = c['expectation'], c.get('error_category')
        if failure is not None:
            if exp != 'reject' or cat != failure.cat or c.get('error_stage') != str(failure.stage):
                problems.append('%s: python fails %s@%d, manifest expects %s %s@%s' % (c['id'], failure.cat, failure.stage, exp, cat, c.get('error_stage')))
            else:
                agreed += 1
            continue
        if kind == 'retain':
            if exp != 'retain':
                problems.append('%s: python retains, manifest expects %s' % (c['id'], exp))
            else:
                agreed += 1
            continue
        # Reached the end of the stages implemented here.
        op = ctx['operation']
        if op in ('frame', 'generic'):
            if exp != 'accept':
                problems.append('%s: python accepts %s, manifest expects %s %s' % (c['id'], op, exp, cat))
            else:
                agreed += 1
        else:
            # A typed reject may come from stages 8-9, including recursively opened children
            # (which this script does not open), so only accepts are checked here.
            if exp == 'accept':
                if c.get('content_hash_hex') != t1(f, info):
                    problems.append('%s: content hash differs' % c['id'])
                else:
                    hashes += 1
                    agreed += 1
            else:
                skipped += 1  # typed reject/retain decided at stage 8-9 or in a child: not evaluated
    total = len(manifest['cases'])
    print('cases: %d; evaluated: %d (%d agree, %d disagree); NOT evaluated: %d '
          '(typed cases that pass stages 1-7 here and are rejected at stage 8-9 or in a child, '
          'which this script does not implement); T1 hashes matched: %d'
          % (total, agreed + len(problems), agreed, len(problems), skipped, hashes))
    for p in problems:
        print('DISAGREEMENT', p)
    topic_problems = check_topic_commitments() + check_stamp_fields(manifest)
    for p in topic_problems:
        print('DISAGREEMENT', p)
    reg_problems, values_problems = check_account_registration()
    for p in reg_problems + values_problems:
        print('DISAGREEMENT', p)
    return 1 if problems or topic_problems or reg_problems or values_problems else 0


# =============================================================================================
# Account-registration corpus (README section 11): an independent evaluation of every case at
# stages 1-10.6 over the type-2/type-4 shapes, plus the pure-value M2/M3/M6 vectors.
# =============================================================================================

I64_MIN, I64_MAX = -(2 ** 63), 2 ** 63 - 1


class RegFail(Exception):
    def __init__(self, cat, stage):
        self.cat, self.stage = cat, stage


def rfail(cat, stage):
    raise RegFail(cat, stage)


def keccak256(data):
    """Pure-Python Keccak-256 (original padding 0x01, rate 136), pinned by the values vectors."""
    RC = [
        0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
        0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
        0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
        0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
        0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
        0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
    ]
    ROT = [
        [0, 36, 3, 41, 18],
        [1, 44, 10, 45, 2],
        [62, 6, 43, 15, 61],
        [28, 55, 25, 21, 56],
        [27, 20, 39, 8, 14],
    ]
    M64 = (1 << 64) - 1

    def rol(x, n):
        return ((x << n) | (x >> (64 - n))) & M64

    lanes = [[0] * 5 for _ in range(5)]  # lanes[x][y]
    rate = 136
    padded = bytearray(data)
    padded.append(0x01)
    while len(padded) % rate:
        padded.append(0)
    padded[-1] |= 0x80
    for offset in range(0, len(padded), rate):
        block = padded[offset:offset + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            lanes[x][y] ^= int.from_bytes(block[8 * i:8 * i + 8], 'little')
        for rc in RC:
            c = [lanes[x][0] ^ lanes[x][1] ^ lanes[x][2] ^ lanes[x][3] ^ lanes[x][4] for x in range(5)]
            d = [c[(x - 1) % 5] ^ rol(c[(x + 1) % 5], 1) for x in range(5)]
            for x in range(5):
                for y in range(5):
                    lanes[x][y] ^= d[x]
            b = [[0] * 5 for _ in range(5)]
            for x in range(5):
                for y in range(5):
                    b[y][(2 * x + 3 * y) % 5] = rol(lanes[x][y], ROT[x][y])
            for x in range(5):
                for y in range(5):
                    lanes[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) & M64
            lanes[0][0] ^= rc
    out = bytearray()
    for i in range(4):
        x, y = i % 5, i // 5
        out += lanes[x][y].to_bytes(8, 'little')
    return bytes(out)


def ec_add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % SECP_P == 0:
        return None
    if p == q:
        lam = (3 * p[0] * p[0]) * pow(2 * p[1], -1, SECP_P) % SECP_P
    else:
        lam = (q[1] - p[1]) * pow(q[0] - p[0], -1, SECP_P) % SECP_P
    x = (lam * lam - p[0] - q[0]) % SECP_P
    return x, (lam * (p[0] - x) - p[1]) % SECP_P


def ec_mul(k, p):
    r = None
    while k:
        if k & 1:
            r = ec_add(r, p)
        p = ec_add(p, p)
        k >>= 1
    return r


def pubkey_decompress(pub33):
    """Returns (x, y) or None when the encoding is not a valid compressed point."""
    if len(pub33) != 33 or pub33[0] not in (2, 3):
        return None
    x = int.from_bytes(pub33[1:], 'big')
    if x >= SECP_P:
        return None
    rhs = (pow(x, 3, SECP_P) + 7) % SECP_P
    y = pow(rhs, (SECP_P + 1) // 4, SECP_P)
    if (y * y) % SECP_P != rhs:
        return None
    if y % 2 != pub33[0] % 2:
        y = SECP_P - y  # p is odd, so this flips the parity to the requested one
    return x, y


def ecdsa_verify(digest, r, s, pub33):
    """ECDSA over the 32-byte digest; the caller enforces low-S."""
    point = pubkey_decompress(pub33)
    if point is None:
        return False
    if not (1 <= r < SECP_N and 1 <= s < SECP_N):
        return False
    e = int.from_bytes(digest, 'big')
    w = pow(s, -1, SECP_N)
    u1, u2 = e * w % SECP_N, r * w % SECP_N
    point = ec_add(ec_mul(u1, (SECP_GX, SECP_GY)), ec_mul(u2, point))
    return point is not None and point[0] % SECP_N == r


def strict_der_parse(der):
    """Strict DER (S2a) plus the low-S rule; raises RegFail('cryptographic', '10.6')."""
    bad = lambda m: rfail('cryptographic', '10.6')

    def length(i):
        first = der[i]
        if first < 0x80:
            return first, i + 1
        if first == 0x80 or first > 0x82:
            bad('unsupported length encoding')
        n = first - 0x80
        v = int.from_bytes(der[i + 1:i + 1 + n], 'big')
        if v < 0x80:
            bad('non-minimal length')
        return v, i + 1 + n

    if len(der) < 8 or len(der) > 72:
        bad('length outside 8..72')
    if der[0] != 0x30:
        bad('missing SEQUENCE')
    seq_len, after = length(1)
    if after + seq_len != len(der):
        bad('SEQUENCE length mismatch')
    i = after
    if der[i] != 0x02:
        bad('r is not an INTEGER')
    r_len, i = length(i + 1)
    r_bytes = der[i:i + r_len]
    i += r_len
    if der[i] != 0x02:
        bad('s is not an INTEGER')
    s_len, i = length(i + 1)
    s_bytes = der[i:i + s_len]
    if i + s_len != len(der):
        bad('trailing bytes after s')

    def scalar(b, what):
        if not b:
            bad('empty ' + what)
        if b[0] & 0x80:
            bad('negative ' + what)
        if len(b) > 1 and b[0] == 0 and not (b[1] & 0x80):
            bad('non-minimal ' + what)
        v = int.from_bytes(b, 'big')
        if not 1 <= v < SECP_N:
            bad(what + ' outside 1..n-1')
        return v

    r, s = scalar(r_bytes, 'r'), scalar(s_bytes, 's')
    if s > SECP_N >> 1:
        bad('s above n/2 (low-S)')
    return r, s


def reg_signature_transcript(domain, network, statement_frame):
    d = domain.encode()
    n = network.encode()
    return struct.pack('>H', len(d)) + d + struct.pack('>H', len(n)) + n + \
        struct.pack('>I', len(statement_frame)) + statement_frame


def reg_t2_transcript(network, statement_frame):
    return reg_signature_transcript(
        'frank/directory-signature/v1', network, statement_frame)


def reg_t2a_transcript(network, transition_frame):
    return reg_signature_transcript(
        'frank/key-transition-signature/v1', network, transition_frame)


# ---- reg-corpus typed structure (stages 8.1-8.3) and semantics (stage 9) ----------------------

REG_MAX_SIGS, REG_MAX_RELAYS = 16, 32


def reg_map(v, path, required, optional, allow_unknown):
    if not isinstance(v, dict):
        rfail('schema', '8.2')
    for k in required:
        if k not in v:
            rfail('schema', '8.2')
    for k in v:
        if k not in required and k not in optional and not allow_unknown:
            rfail('schema', '8.2')
    return v


def reg_uint(v, path, lo, hi):
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        rfail('schema', '8.2')
    return v


def reg_bstr(v, path, lo, hi):
    if not isinstance(v, bytes) or not lo <= len(v) <= hi:
        rfail('schema', '8.2')
    return v


def reg_tstr(v, path, lo, hi):
    if not isinstance(v, str) or not lo <= len(v.encode()) <= hi:
        rfail('schema', '8.2')
    return v


def reg_network(v, path):
    s = reg_tstr(v, path, 1, 64)
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,63}', s):
        rfail('schema', '8.2')
    return s


def reg_account(v, path):
    m = reg_map(v, path, [0, 1], [], False)
    key_type = reg_uint(m[0], path, 0, 65535)
    key = reg_bstr(m[1], path, 1, 128)
    expected = {1: 33, 2: 32, 3: 32}.get(key_type)
    if expected is not None and len(key) != expected:
        rfail('schema', '8.2')
    return key_type, key


def reg_timestamp(v, path):
    m = reg_map(v, path, [0, 1], [], False)
    seconds = reg_uint(m[0], path, I64_MIN, I64_MAX)
    nanos = reg_uint(m[1], path, 0, 999_999_999)
    return seconds, nanos


def reg_endpoint(v, path):
    s = reg_tstr(v, path, 1, 2048)
    b = s.encode()
    i = 1
    if not b or not chr(b[0]).isalpha():
        rfail('schema', '8.2')
    while i < len(b) and (chr(b[i]).isalnum() or b[i] in b'+.-'):
        i += 1
    if i >= len(b) or b[i] != 0x3A:
        rfail('schema', '8.2')
    for c in b[i + 1:]:
        if not 0x21 <= c <= 0x7e or c in b'"<>\\^`{|}':
            rfail('schema', '8.2')
    return s


def reg_relay(v, path):
    m = reg_map(v, path, [0, 1, 2, 3], [], False)
    return {
        'relay_id': reg_bstr(m[0], path, 16, 64),
        'endpoint': reg_endpoint(m[1], path),
        'identity': reg_account(m[2], path),
        'expiry': reg_timestamp(m[3], path),
    }


def reg_signature_entry(v, path):
    m = reg_map(v, path, [0, 1, 2], [], False)
    return (
        reg_uint(m[0], path, 0, 65535),
        reg_account(m[1], path),
        reg_bstr(m[2], path, 1, 512),
    )


def reg_profile_entry(v, path):
    m = reg_map(v, path, [0, 1, 2], [], False)
    kind = reg_tstr(m[0], path, 0, MAX_TSTR)
    headers = reg_list(m[1], path, 0, 64)
    body = reg_bstr(m[2], path, 0, MAX_BSTR)
    parsed_headers = []
    for i, h in enumerate(headers):
        hm = reg_map(h, path + '[%d]' % i, [0, 1], [], False)
        parsed_headers.append((reg_tstr(hm[0], path, 0, MAX_TSTR),
                               reg_tstr(hm[1], path, 0, MAX_TSTR)))
    return kind, parsed_headers, body


def reg_list(v, path, lo, hi):
    if not isinstance(v, list) or not lo <= len(v) <= hi:
        rfail('schema', '8.2')
    return v


def reg_allocated(algorithm, signer, signature, path):
    key_type, _ = signer
    pairings = {1: (1, lambda n: 8 <= n <= 72), 2: (3, lambda n: n == 64),
                3: (1, lambda n: n == 64), 16: (2, lambda n: n == 64)}
    if algorithm not in pairings:
        rfail('unsupported', '8.3')
    want, length_ok = pairings[algorithm]
    if key_type != want or not length_ok(len(signature)):
        rfail('unsupported', '8.3')


def reg_statement(payload, schema_version, effective, allow_unknown):
    """Stages 8.1-8.3 and 9 of one type-4 statement payload (children except transitions opened)."""
    required = [0, 1, 2, 3, 4] + ([8] if effective >= 2 else [])
    optional = [5, 6, 7] + ([9] if effective >= 3 else [])
    m = reg_map(payload, 'stmt', required, optional, allow_unknown)
    relays_raw = m[4]
    if isinstance(relays_raw, list) and len(relays_raw) > REG_MAX_RELAYS:
        rfail('resource', '8.1')
    relays = [reg_relay(v, 'relay%d' % i) for i, v in enumerate(reg_list(relays_raw, 'stmt', 1, REG_MAX_RELAYS))]
    network = reg_network(m[0], 'stmt')
    subject = reg_account(m[1], 'stmt')
    revision = reg_uint(m[2], 'stmt', 0, 2 ** 64 - 1)
    reg_timestamp(m[3], 'stmt')
    stamp = reg_account(m[8], 'stmt') if 8 in m else None
    if stamp is not None and stamp[0] != 1:
        rfail('semantic', '9')
    transitions = None
    if 5 in m:
        items = reg_list(m[5], 'stmt', 1, 16)
        transitions = []
        for i, t in enumerate(items):
            tm = reg_map(t, 't%d' % i, [0, 1, 2, 3], [], False)
            reg_bstr(tm[0], 't', 9, MAX_FRAME)
            algorithm = reg_uint(tm[1], 't', 0, 65535)
            signer = reg_account(tm[2], 't')
            signature = reg_bstr(tm[3], 't', 1, 512)
            reg_allocated(algorithm, signer, signature, 't')
            transitions.append({
                'frame': tm[0],
                'algorithm': algorithm,
                'signer': signer,
                'signature': signature,
            })
    if 6 in m:
        reg_timestamp(m[6], 'stmt')
    if 7 in m:
        authorities = [reg_account(v, 'auth%d' % i) for i, v in enumerate(reg_list(m[7], 'stmt', 1, 8))]
        if sorted(authorities, key=lambda a: (a[0], a[1])) != authorities or \
                len(set(authorities)) != len(authorities):
            rfail('semantic', '9')
    if effective >= 3 and 9 in m:
        entries = [reg_profile_entry(v, 'p%d' % i) for i, v in enumerate(reg_list(m[9], 'stmt', 1, 64))]
        for _, headers, _ in entries:
            names = [n.encode() for n, _ in headers]
            if sorted(names) != names or len(set(names)) != len(names):
                rfail('semantic', '9')
    relays_sorted = sorted(relays, key=lambda r: (r['relay_id'], r['endpoint']))
    if relays_sorted != relays or len({r['relay_id'] for r in relays}) != len(relays):
        rfail('semantic', '9')
    return {'network': network, 'subject': subject, 'revision': revision,
            'schema_version': schema_version, 'stamp': stamp,
            'transitions': transitions, 'frame': None}


def reg_child_statement(frame_bytes, child_highest):
    """Stages 2-9 of the opened type-4 child (stage labels are the child's own)."""
    if len(frame_bytes) < 9 or frame_bytes[:4] != b'FRNK':
        rfail('frame', '2')
    if frame_bytes[4] != 1:
        rfail('unsupported', '3')
    if struct.unpack('>I', frame_bytes[5:9])[0] != len(frame_bytes) - 9:
        rfail('frame', '4')
    env = item(frame_bytes[9:], 0, Counters(), 5)
    if not isinstance(env, dict) or set(env) != {0, 1, 2, 3}:
        rfail('schema', '6')
    child_type, child_schema, child_min, child_payload = env[0], env[1], env[2], env[3]
    if child_type != 4:
        rfail('semantic', '8.4')
    if not (isinstance(child_schema, int) and isinstance(child_min, int)) or child_min > child_schema:
        rfail('schema', '6')
    payload = item(child_payload, 1, Counters(), 7)
    if child_min > 2:
        rfail('unsupported', '7')
    effective = min(child_schema, child_highest)
    st = reg_statement(payload, child_schema, effective, child_schema > child_highest)
    st['frame'] = frame_bytes
    return st


def reg_attestation(payload, child_highest, prior_ctx):
    """Stages 8.1-8.3, 8.4 (the type-4 child) and 9 of a type-2 attestation."""
    m = reg_map(payload, 'att', [0, 1], [], False)
    sigs_raw = m[1]
    if isinstance(sigs_raw, list) and len(sigs_raw) > REG_MAX_SIGS:
        rfail('resource', '8.1')
    sigs = [reg_signature_entry(v, 'sig%d' % i) for i, v in enumerate(reg_list(sigs_raw, 'att', 1, REG_MAX_SIGS))]
    for algorithm, signer, signature in sigs:
        reg_allocated(algorithm, signer, signature, 'sig')
    statement_frame = reg_bstr(m[0], 'att', 9, MAX_FRAME)
    st = reg_child_statement(statement_frame, child_highest)
    ordered = sorted(sigs, key=lambda s: (s[0], s[1][0], s[1][1]))
    if ordered != sigs:
        rfail('semantic', '9')
    if not any(s[1] == st['subject'] for s in sigs):
        rfail('semantic', '9')
    check_reg_s10(st, prior_ctx)
    return st, sigs


def check_reg_s10(st, prior_ctx):
    prior, transitions = prior_ctx, st['transitions']
    if prior is None:
        if transitions:
            rfail('semantic', '9')
        return
    if st['revision'] <= prior['revision']:
        rfail('semantic', '9')
    if st['network'] != prior['network']:
        rfail('semantic', '9')
    changed = st['subject'] != prior['subject']
    if not changed and st['schema_version'] < prior['schema_version']:
        rfail('semantic', '9')
    if not changed:
        if transitions:
            rfail('semantic', '9')
        return
    if not transitions or len(transitions) != 1:
        rfail('semantic', '9')
    t = transitions[0]
    tframe = t['frame']
    env = item(tframe[9:], 0, Counters(), 5)
    if not isinstance(env, dict) or set(env) != {0, 1, 2, 3}:
        rfail('schema', '6')
    t_payload = item(env[3], 1, Counters(), 7)
    if not isinstance(t_payload, dict) or not {0, 1, 2, 3, 4} <= set(t_payload):
        rfail('schema', '8.2')
    t_network = reg_network(t_payload[0], 't7')
    t_subject = reg_account(t_payload[1], 't7')
    t_prior = reg_account(t_payload[2], 't7')
    t_revision = reg_uint(t_payload[3], 't7', 1, 2 ** 64 - 1)
    t_new = reg_account(t_payload[4], 't7')
    if t_network != st['network'] or t_network != prior['network']:
        rfail('semantic', '9')
    if t_subject != prior['subject']:
        rfail('semantic', '9')
    if t_revision != st['revision'] or t_revision <= prior['revision']:
        rfail('semantic', '9')
    if t_new != st['subject']:
        rfail('semantic', '9')
    if t_prior != prior['subject'] and t_prior not in prior.get('recovery', []):
        rfail('semantic', '9')
    if t['signer'] != t_prior:
        rfail('semantic', '9')


def reg_prior_statement(frame_bytes, child_highest):
    """Stages 1-9 of a prior type-4 statement, as the corpus validity rule requires."""
    if len(frame_bytes) > MAX_FRAME or len(frame_bytes) < 9 or frame_bytes[:4] != b'FRNK':
        rfail('frame', '2')
    if frame_bytes[4] != 1:
        rfail('unsupported', '3')
    if struct.unpack('>I', frame_bytes[5:9])[0] != len(frame_bytes) - 9:
        rfail('frame', '4')
    env = item(frame_bytes[9:], 0, Counters(), 5)
    if not isinstance(env, dict) or set(env) != {0, 1, 2, 3}:
        rfail('schema', '6')
    if env[0] != 4 or env[2] > 2:
        rfail('schema', '6')
    payload = item(env[3], 1, Counters(), 7)
    st = reg_statement(payload, env[1], min(env[1], child_highest), env[1] > child_highest)
    if 7 in payload:
        st['recovery'] = [reg_account(v, 'auth%d' % i)
                          for i, v in enumerate(reg_list(payload[7], 'stmt', 1, 8))]
    return st


def reg_verify_stage10(sigs, st, run_10):
    """Stage 10.6: whole-attestation M7 preflight, then T2 and T2a verification."""
    if not run_10:
        return
    transitions = st['transitions'] or []
    entries = list(sigs) + [
        (t['algorithm'], t['signer'], t['signature']) for t in transitions]
    for algorithm, _, _ in entries:
        if algorithm in (2, 3, 16):
            rfail('unsupported', '10.6')
        if algorithm != 1:
            rfail('unsupported', '10.6')
    for _, (_, key), signature in sigs:
        digest = hashlib.sha256(reg_t2_transcript(st['network'], st['frame'])).digest()
        r, s = strict_der_parse(signature)
        if not ecdsa_verify(digest, r, s, key):
            rfail('cryptographic', '10.6')
    for transition in transitions:
        _, key = transition['signer']
        digest = hashlib.sha256(reg_t2a_transcript(
            st['network'], transition['frame'])).digest()
        r, s = strict_der_parse(transition['signature'])
        if not ecdsa_verify(digest, r, s, key):
            rfail('cryptographic', '10.6')


def check_account_registration():
    doc = json.load(open(os.path.join(ROOT, 'vectors', 'account-registration.json')))
    problems, n = [], 0
    values = json.load(open(os.path.join(ROOT, 'vectors', 'account-registration-values.json')))
    if [c['id'] for c in doc['cases']] != values.get('manifest_case_ids'):
        problems.append('account-registration: exact case inventory differs')
    jsonschema.Draft202012Validator(
        json.load(open(os.path.join(ROOT, 'vectors.schema.json')))).validate(doc)
    for c in doc['cases']:
        cid = c['id']
        ctx = c['validation_context']
        if ctx['operation'] not in ('typed', 'full'):
            problems.append('%s: unexpected operation' % cid)
            continue
        child_highest = {x['type_id']: x['schema_version']
                         for x in ctx['supported_schemas']}.get(4)
        f = bytes.fromhex(c['frame_hex'])
        counters = Counters()
        try:
            kind, info = frame_stages(f, ctx, counters)
            failure = None
        except Fail as e:
            kind, info, failure = None, None, e
        try:
            if failure is None and kind == 'ok':
                prior = None
                prior_hex = ctx.get('prior_directory_statement_frame_hex')
                if prior_hex:
                    prior = reg_prior_statement(bytes.fromhex(prior_hex), child_highest)
                st, sigs = reg_attestation(info['payload'], child_highest, prior)
                reg_verify_stage10(sigs, st, ctx['operation'] == 'full')
            outcome = 'accept'
        except RegFail as e:
            failure, outcome = e, 'reject'
        except Fail as e:
            failure, outcome = e, 'reject'
        want = c['expectation']
        if outcome != want:
            problems.append('%s: python says %s%s, manifest expects %s' % (
                cid, outcome,
                '' if outcome == 'accept' else ' %s@%s' % (failure.cat, failure.stage),
                want))
        elif outcome == 'reject':
            if c.get('error_category') != failure.cat or c.get('error_stage') != str(failure.stage):
                problems.append('%s: python fails %s@%s, manifest expects %s@%s' % (
                    cid, failure.cat, failure.stage,
                    c.get('error_category'), c.get('error_stage')))
        elif c.get('content_hash_hex') != t1(f, info):
            problems.append('%s: content hash differs' % cid)
        n += 1
    print('account-registration.json: %d cases evaluated at stages 1-10.6, %d disagree' % (n, len(problems)))
    values_problems = check_registration_values()
    return problems, values_problems


def check_registration_values():
    doc = json.load(open(os.path.join(ROOT, 'vectors', 'account-registration-values.json')))
    problems, n = [], 0
    vectors = doc.get('key_transition_authorizations', [])
    if [v.get('id') for v in vectors] != ['t2a-rust-secret-2']:
        problems.append('T2a: exact known-answer inventory differs')
    for v in vectors:
        transition = bytes.fromhex(v['transition_statement_frame_hex'])
        digest = hashlib.sha256(reg_t2a_transcript(v['network'], transition)).digest()
        if digest.hex() != v['digest_hex']:
            problems.append('T2a %s: digest differs' % v['id'])
        r, s = strict_der_parse(bytes.fromhex(v['signature_der_hex']))
        if not ecdsa_verify(digest, r, s, bytes.fromhex(v['signer_public_key_hex'])):
            problems.append('T2a %s: signature does not verify' % v['id'])
        n += 1
    for v in doc['timestamp_mappings']:
        ms = int(v['timestamp_ms'])
        seconds, remainder = divmod(ms, 1000)
        nanos = remainder * 1_000_000
        if str(ms) != v['revision'] or str(seconds) != v['seconds'] or str(nanos) != v['nanoseconds']:
            problems.append('M2 %s: python derives %d/%d/%d' % (v['timestamp_ms'], ms, seconds, nanos))
        n += 1
    for v in doc['timestamp_unencodable']:
        ms = int(v['timestamp_ms'])
        if ms >= 0 or ms < I64_MIN:
            problems.append('M2 unencodable %s: expected a negative i64 ms' % v['timestamp_ms'])
        n += 1
    for v in doc['expiry_mappings']:
        total = int(v['timestamp_ms']) + int(v['ttl_ms'])
        seconds, remainder = divmod(total, 1000)
        if str(seconds) != v['expiry_seconds'] or str(remainder * 1_000_000) != v['expiry_nanoseconds']:
            problems.append('M3 %s+%s: python derives %d/%d' % (
                v['timestamp_ms'], v['ttl_ms'], seconds, remainder * 1_000_000))
        n += 1
    for v in doc['address_derivations']:
        compressed = bytes.fromhex(v['compressed_pubkey_hex'])
        xy = pubkey_decompress(compressed)
        if xy is None:
            problems.append('M6 %s: python could not decompress' % v['label'])
            continue
        if (xy[0].to_bytes(32, 'big') + xy[1].to_bytes(32, 'big')).hex() != v['uncompressed_x_y_hex']:
            problems.append('M6 %s: uncompressed X||Y differs' % v['label'])
        addr = keccak256(xy[0].to_bytes(32, 'big') + xy[1].to_bytes(32, 'big'))[-20:].hex()
        if addr != v['address_hex']:
            problems.append('M6 %s: address differs' % v['label'])
        n += 1
    print('account-registration-values.json: %d values recomputed independently (Keccak-256, floor ms), %d differ'
          % (n, len(problems)))
    return problems


if __name__ == '__main__':
    sys.exit(main())
