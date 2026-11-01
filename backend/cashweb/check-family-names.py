#!/usr/bin/env python3
"""Check implementation ownership names; network/wire/persistence identifiers stay intact.

Run: python3 backend/cashweb/check-family-names.py
Source: relay src/*.rs and cashweb-config/src/lib.rs. No generated output.
"""
import argparse
from pathlib import Path
import re
import sys
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
root = parser.parse_args().root.resolve()
source = root / 'backend/cashweb/cashweb-registry/src'
errors = []
for path in sorted(source.rglob('*.rs')):
    relative = path.relative_to(root)
    if 'monad' in path.stem.lower():
        errors.append(f'{relative}: implementation file must name its family or neutral owner')
    text = path.read_text()
    for match in re.finditer(r'\b(?:struct|enum|trait|type)\s+(\w*Monad\w*)\b', text):
        errors.append(f'{relative}: implementation type {match.group(1)} is not network configuration')
    for match in re.finditer(r'\b(?:use|mod)\s+[^;\n]*\bmonad_\w+', text):
        errors.append(f'{relative}: imports a retired implementation owner')
config = (root / 'backend/cashweb/cashweb-config/src/lib.rs').read_text()
for old in ['pub monad_mailbox:', 'pub monad_rpc_url:', 'struct MonadMailboxConf']:
    if old in config:
        errors.append(f'cashweb-config: retired implementation/config owner {old}')
# Inspect all tracked config writers, including .in templates; suffix lists missed a live
# HA producer previously. Negative Rust tests construct retired names inside expressions.
retired = subprocess.run(
    ['git', 'grep', '-n', '-I', '-E',
     r'^[[:space:]]*(\[registry\.monad_mailbox\]|monad_rpc_url[[:space:]]*=)'],
    cwd=root, text=True, capture_output=True,
)
if retired.returncode not in (0, 1):
    errors.append('could not inspect tracked configuration producers')
elif retired.returncode == 0:
    errors.append('retired configuration field in tracked producer:\n' + retired.stdout.rstrip())
# The shared frame owner may inspect opaque bytes, never chain or transport behavior.
framing = (source / 'canonical_dm_request.rs').read_text()
for forbidden in ['crate::evm_', 'crate::http', 'crate::store', 'axum::', 'reqwest::', 'tokio::']:
    if forbidden in framing:
        errors.append(f'canonical_dm_request: forbidden dependency {forbidden}')
for relative in ['evm_dm_payment.rs', 'evm_mailbox.rs', 'store/evm_direct_messages.rs']:
    text = (source / relative).read_text()
    if re.search(r'(?:crate::http::|(?<![:\w])http::evm_direct_messages)', text):
        errors.append(f'{relative}: data/family owner depends on HTTP implementation')
http = (source / 'http/evm_direct_messages.rs').read_text()
for forbidden in ['decode_signed_transaction', 'send_raw_transaction', 'get_transaction_count',
                  'get_balance', 'get_transaction_by_hash', 'EvmHttpClient', 'Keccak256']:
    if forbidden in http:
        errors.append(f'http/evm_direct_messages.rs: EVM payment behavior belongs to family owner ({forbidden})')
# Historical protobuf DTOs (proto::MonadProfile and response names), signed domains,
# persistent namespace/format bytes, public URL paths and canonical monad-* network IDs
# are deliberately outside this source-ownership rule. No protocol migration is implied.
if errors:
    print('\n'.join(errors), file=sys.stderr)
    sys.exit(1)
print('Backend family ownership names: PASS')
