#!/usr/bin/env python3
"""Independent second implementation of section 9 stages 1-7 and the T1 content hash, used to
cross-check the committed manifest against the TypeScript codec.

It shares no code with packages/frank-codec/src. It checks:
  * the manifest against docs/protocol/cbor/vectors.schema.json (jsonschema, draft 2020-12);
  * for every case, stages 1-7 of the root frame (framing, both CBOR passes, envelope, V6
    retention): whenever this implementation fails there the manifest must expect that exact
    category, and for `frame`/`generic` cases an implementation success must be an accept;
  * for every `typed` accept case, the T1 content hash.
Stages 8 and 9 are NOT re-implemented here.

Usage: python3 scripts/crosscheck.py            (exit 0 on agreement)
"""
import hashlib
from importlib.metadata import version
import json
import os
import struct
import sys

import jsonschema

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'docs', 'protocol', 'cbor'))
MAX_FRAME, MAX_DEPTH, MAX_CONT, MAX_ITEMS = 8388617, 32, 16384, 131072
MAX_MAP, MAX_ARR, MAX_BSTR, MAX_TSTR = 256, 8192, 8388608, 262144
KNOWN = {1, 2, 3, 4, 5, 6, 7, 8, 16, 17}


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


def main():
    schema = json.load(open(os.path.join(ROOT, 'vectors.schema.json')))
    manifest = json.load(open(os.path.join(ROOT, 'vectors', 'manifest.json')))
    jsonschema.Draft202012Validator(schema).validate(manifest)
    print('manifest conforms to vectors.schema.json (jsonschema %s)' % version('jsonschema'))
    problems, hashes, agreed = [], 0, 0
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
            if exp != 'reject' or cat != failure.cat:
                problems.append('%s: python fails %s@%d, manifest expects %s %s' % (c['id'], failure.cat, failure.stage, exp, cat))
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
                agreed += 1
    print('cases: %d, agreeing: %d, T1 hashes matched: %d' % (len(manifest['cases']), agreed, hashes))
    for p in problems:
        print('DISAGREEMENT', p)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
