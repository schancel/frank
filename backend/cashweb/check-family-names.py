#!/usr/bin/env python3
"""Check implementation ownership names; network/wire/persistence identifiers stay intact.

Run: python3 backend/cashweb/check-family-names.py
Source: relay src/*.rs and cashweb-config/src/lib.rs. No generated output.
"""
import argparse
from pathlib import Path
import re
import sys

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
# Historical protobuf DTOs (proto::MonadProfile and response names), signed domains,
# persistent namespace/format bytes, public URL paths and canonical monad-* network IDs
# are deliberately outside this source-ownership rule. No protocol migration is implied.
if errors:
    print('\n'.join(errors), file=sys.stderr)
    sys.exit(1)
print('Backend family ownership names: PASS')
