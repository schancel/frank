"""Independent stdlib reference for the proposed local IDs; synthetic inputs only.
Run from this directory: python3 generate-negotiation-id-vectors.py
Writes negotiation-id-vectors.json beside this script. No runtime application imports.
"""
import hashlib
import hmac
import json
from pathlib import Path


def head(major, length):
    if length < 24:
        return bytes([(major << 5) | length])
    for tag, size in [(24, 1), (25, 2), (26, 4), (27, 8)]:
        if length < 1 << (size * 8):
            return bytes([(major << 5) | tag]) + length.to_bytes(size, 'big')
    raise ValueError('uint64 overflow')


def cbor(value):
    if isinstance(value, int) and value >= 0:
        return head(0, value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        raw = value.encode('utf8')
        return head(3, len(raw)) + raw
    if isinstance(value, list):
        return head(4, len(value)) + b''.join(map(cbor, value))
    raise ValueError('unsupported reference input')


def uuid5(namespace, name):
    raw = bytearray(hashlib.sha1(namespace + name.encode('utf8')).digest()[:16])
    raw[6] = (raw[6] & 15) | 80
    raw[8] = (raw[8] & 63) | 128
    value = raw.hex()
    return '-'.join([value[:8], value[8:12], value[12:16], value[16:20], value[20:]])


rows = []
for label, chain, event_byte, salt_byte in [
    ('decision-one', 'monad-testnet', 0x33, None),
    ('conflicting-decision', 'monad-testnet', 0x44, None),
    ('changed-transport-conflicts-with-claim', 'monad-mainnet', 0x33, None),
    ('other-account', 'monad-testnet', 0x33, 0x99),
]:
    salt = bytes(range(16)) if salt_byte is None else bytes([salt_byte]) * 16
    swap = bytes(range(32))
    sender = bytes([0x22]) * 32
    conversation = bytes(range(16))
    recipient = bytes.fromhex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
    event = bytes([event_byte]) * 32
    slot = cbor(['frank/swap-negotiation-intent-key/v1', swap, 0, sender, 0])
    message = cbor(['frank/swap-negotiation-message/v1', chain, conversation, recipient, event])
    rows.append(dict(label=label, saltHex=salt.hex(), swapIdHex=swap.hex(), senderKeyIdHex=sender.hex(),
                     messagingChainIdentifier=chain, conversationIdHex=conversation.hex(),
                     recipientPublicKeyHex=recipient.hex(), eventIdHex=event.hex(),
                     slotTranscriptHex=slot.hex(), intentKey=hmac.new(salt, slot, hashlib.sha256).hexdigest(),
                     messageTranscriptHex=message.hex(), messageId=uuid5(salt, message.hex())))
Path(__file__).with_name('negotiation-id-vectors.json').write_text(json.dumps(rows, indent=2) + '\n')
