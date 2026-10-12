#!/usr/bin/env python3
"""Public synthetic sender-nonce oracle. Never import into custody."""
import hashlib
import hmac
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'solana-stealth-vectors'))
import generate as g


def derive(intent, seed):
    asset = [bytes(x) if isinstance(x, list) else x for x in intent['asset']]
    j = g.cbor(['frank:solana-stealth:edwards-add:v1', intent['chainIdentifier'], asset,
                bytes(intent['recipient']), bytes(intent['operationId']), intent['memberIndex'],
                bytes(intent['messageContext']), int(intent['recipientAmount'])])
    prefix = g.sha(seed)[32:]
    for counter in range(4096):
        raw = hmac.new(prefix, g.cbor(['frank:solana-stealth:sender-ephemeral:v1', j, counter]), hashlib.sha512).digest()[:32]
        r = int.from_bytes(raw, 'little')
        if not 0 < r < g.ORDER:
            continue
        R = g.encoded(g.multiply(g.BASE, r))
        D = g.encoded(g.multiply(g.decode(bytes(intent['recipient'])), r))
        q = g.cbor(['frank:solana-stealth:edwards-add:v1', intent['chainIdentifier'], asset,
                    bytes(intent['recipient']), R, bytes(intent['operationId']), intent['memberIndex'],
                    bytes(intent['messageContext']), int(intent['recipientAmount'])])
        t = g.hs(g.cbor(['frank:solana-stealth:tweak:v1', q, D]))
        P = g.add(g.decode(bytes(intent['recipient'])), g.multiply(g.BASE, t))
        if t == 0 or P == g.IDENTITY:
            continue
        return {'J': j.hex(), 'counter': counter, 'r': raw.hex(), 'R': R.hex(), 'P': g.encoded(P).hex()}
    raise ValueError('nonce exhausted')


def generate():
    original = json.loads((Path(__file__).parent.parent / 'solana-stealth-vectors/vectors.json').read_text())
    output = []
    for v in original['vectors']:
        # All fixed reference intents use devnet; synthetic SPL gets the actual classic program.
        asset = [0] if v['asset'][0] == 0 else [1, list(bytes.fromhex(v['asset'][1])), list(bytes.fromhex('06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9'))]
        intent = dict(chainIdentifier=v['chainIdentifier'], asset=asset, recipient=list(bytes.fromhex(v['B'])),
                      operationId=list(bytes.fromhex(v['operationId'])), memberIndex=v['memberIndex'],
                      messageContext=list(bytes.fromhex(v['messageContext'])), recipientAmount=v['amount'])
        seed = bytes([99]) * 32
        output.append({'intent': intent, 'senderSeed': seed.hex(), **derive(intent, seed)})
    # Add the configured devnet USDC identity for the ATA construction predecessor.
    configured = json.loads(json.dumps(output[-2]['intent']))
    configured['asset'] = [1, list(bytes.fromhex('9aeb37e1b4f58b58ff36f2fcec83a98008eb1675f900d3a6ab908af8b8d85087')),
                           list(bytes.fromhex('06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9'))]
    output.append({'intent': configured, 'senderSeed': seed.hex(), **derive(configured, seed)})
    assert any(v['counter'] > 0 for v in output)
    return json.dumps(output, indent=2) + '\n'


if __name__ == '__main__':
    path = Path(__file__).with_name('sender-vectors.json')
    output = generate()
    if '--check' in sys.argv:
        assert path.read_text() == output
        print('PASS independent Python sender-nonce vectors')
    else:
        path.write_text(output)
