#!/usr/bin/env python3
"""Offline synthetic vectors ONLY. Variable-time reference arithmetic; never import in custody."""
import argparse
import hashlib
import hmac
import json
from pathlib import Path

FIELD = 2**255 - 19
ORDER = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, -1, FIELD) % FIELD
IDENTITY = (0, 1)


def recover_x(y):
    xx = (y * y - 1) * pow(D * y * y + 1, -1, FIELD) % FIELD
    x = pow(xx, (FIELD + 3) // 8, FIELD)
    if (x * x - xx) % FIELD:
        x = x * pow(2, (FIELD - 1) // 4, FIELD) % FIELD
    if (x * x - xx) % FIELD:
        raise ValueError("not on Edwards curve")
    return FIELD - x if x & 1 else x


Y = 4 * pow(5, -1, FIELD) % FIELD
BASE = (recover_x(Y), Y)


def add(a, b):
    x, y = a
    u, v = b
    product = D * x * u * y * v % FIELD
    return ((x * v + y * u) * pow(1 + product, -1, FIELD) % FIELD,
            (y * v + x * u) * pow(1 - product, -1, FIELD) % FIELD)


def multiply(point, scalar):
    result = IDENTITY
    while scalar:
        if scalar & 1:
            result = add(result, point)
        point = add(point, point)
        scalar >>= 1
    return result


def encoded(point):
    x, y = point
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def decode(data):
    if len(data) != 32:
        raise ValueError("length")
    packed = int.from_bytes(data, "little")
    y = packed & (2**255 - 1)
    if y >= FIELD:
        raise ValueError("noncanonical y")
    x = recover_x(y)
    if x & 1 != packed >> 255:
        x = (-x) % FIELD
    point = (x, y)
    if encoded(point) != data:
        raise ValueError("noncanonical point")
    if point == IDENTITY or multiply(point, ORDER) != IDENTITY:
        raise ValueError("not nonidentity prime subgroup")
    return point


def head(major, n):
    if n < 24:
        return bytes([major * 32 + n])
    for size, marker in [(1, 24), (2, 25), (4, 26), (8, 27)]:
        if n < 2**(size * 8):
            return bytes([major * 32 + marker]) + n.to_bytes(size, "big")
    raise ValueError("outside uint64")


def cbor(value):
    if isinstance(value, int):
        if value < 0:
            raise ValueError("negative")
        return head(0, value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        raw = value.encode("utf8")
        return head(3, len(raw)) + raw
    if isinstance(value, list):
        return head(4, len(value)) + b"".join(map(cbor, value))
    raise TypeError(value)


def sha(data):
    return hashlib.sha512(data).digest()


def hs(data):
    return int.from_bytes(sha(data), "little") % ORDER


def le(scalar):
    return scalar.to_bytes(32, "little")


def native_message(owner):
    # Exact v0 message: signer owner pays one lamport to a fixed public account.
    # Parsed independently by web3.js; this is not a production transaction builder.
    destination = bytes(range(96, 128))
    instruction = bytes([2, 2, 0, 1, 12]) + (2).to_bytes(4, "little") + (1).to_bytes(8, "little")
    return bytes([128, 1, 0, 1, 3]) + owner + destination + bytes(32) + bytes([85]) * 32 + bytes([1]) + instruction + bytes([0])


def vector(name, seed, ephemeral_scalar, asset, index, amount):
    digest = sha(seed)
    pruned = bytearray(digest[:32])
    pruned[0] &= 248
    pruned[31] &= 63
    pruned[31] |= 64
    b = int.from_bytes(pruned, "little") % ORDER
    z = digest[32:]
    B = multiply(BASE, b)
    R = multiply(BASE, ephemeral_scalar)
    sender_d = multiply(B, ephemeral_scalar)
    recipient_d = multiply(R, b)
    assert sender_d == recipient_d
    for point in (B, R, sender_d):
        assert decode(encoded(point)) == point
    operation = bytes(range(32, 64))
    context = bytes(range(64, 96))
    q = cbor(["frank:solana-stealth:edwards-add:v1", "solana-devnet", asset,
              encoded(B), encoded(R), operation, index, context, amount])
    tweak_input = cbor(["frank:solana-stealth:tweak:v1", q, encoded(sender_d)])
    t = hs(tweak_input)
    P = add(B, multiply(BASE, t))
    p = (b + t) % ORDER
    assert t and p and P == multiply(BASE, p)
    assert decode(encoded(P)) == P
    nonce_input = cbor(["frank:solana-stealth:nonce-prefix:v1", q, encoded(P)])
    zp = hmac.new(z, nonce_input, hashlib.sha512).digest()[:32]
    signatures = []
    for kind, message in [("empty", b""), ("ascii", b"synthetic Solana stealth vector"),
                          ("solana-v0-native", native_message(encoded(P)))]:
        k = hs(zp + message)
        U = encoded(multiply(BASE, k))
        challenge = hs(U + encoded(P) + message)
        S = (k + challenge * p) % ORDER
        signatures.append(dict(kind=kind, message=message.hex(), k=le(k).hex(),
                               U=U.hex(), challenge=le(challenge).hex(), S=le(S).hex(),
                               signature=(U + le(S)).hex()))
    return dict(name=name, seed=seed.hex(), h=digest.hex(), pruned=bytes(pruned).hex(),
                b=le(b).hex(), z=z.hex(), B=encoded(B).hex(), r=le(ephemeral_scalar).hex(),
                R=encoded(R).hex(), senderD=encoded(sender_d).hex(), recipientD=encoded(recipient_d).hex(),
                chainIdentifier="solana-devnet", asset=[x.hex() if isinstance(x, bytes) else x for x in asset],
                operationId=operation.hex(), memberIndex=index, messageContext=context.hex(),
                amount=str(amount), Q=q.hex(), tweakHash=sha(tweak_input).hex(), t=le(t).hex(),
                P=encoded(P).hex(), p=le(p).hex(), nonceInput=nonce_input.hex(), zP=zp.hex(), signatures=signatures)


def generate():
    seeds = [bytes(range(32)), bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")]
    vectors = []
    for si, seed in enumerate(seeds):
        for ri, scalar in enumerate([1, 2, ORDER - 1]):
            vectors.append(vector(f"native-{si}-{ri}", seed, scalar, [0], ri, [1, 1000000000, 2**64 - 1][ri]))
    vectors.append(vector("spl-synthetic", seeds[0], 2, [1, bytes([17]) * 32, bytes([34]) * 32], 1, 2**53 + 1))
    # Matching message signed under related keys must have different private prefixes/nonces.
    vectors.append(vector("native-changed-context-index", seeds[0], 1, [0], 1, 1))
    mixed = add(BASE, (0, FIELD - 1))
    invalid = {"short": bytes(31), "long": bytes(33), "identity": encoded(IDENTITY),
               "order-two": encoded((0, FIELD - 1)), "mixed-order": encoded(mixed),
               "noncanonical-y": FIELD.to_bytes(32, "little"),
               "negative-zero-x": (1 | 2**255).to_bytes(32, "little")}
    for raw in invalid.values():
        try:
            decode(raw)
        except ValueError:
            continue
        raise AssertionError("invalid point accepted")
    return dict(status="UNALLOCATED NONPRODUCTION PROPOSAL; NOT CRYPTOGRAPHIC APPROVAL",
                syntheticSecrets=True, vectors=vectors, invalidPoints={k: v.hex() for k, v in invalid.items()})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = Path(__file__).with_name("vectors.json")
    output = json.dumps(generate(), indent=2) + "\n"
    if args.check:
        assert path.read_text() == output, "vectors differ; review before regenerating"
        print("PASS: independent Python reference reproduces all fixtures and rejects invalid points")
    else:
        path.write_text(output)
        print(f"Wrote {path}")
