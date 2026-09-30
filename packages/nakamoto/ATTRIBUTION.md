# Attribution

`@frank/nakamoto` is a new TypeScript library. Consensus behavior that later modules implement (transaction and block serialization, sighash, script results, address encodings, WIF, signature bytes) is derived from `packages/bitcore-lib-xpi`, a Lotus-flavored fork of BitPay's bitcore-lib.

BitPay's MIT license and the other copyright notices in `LICENSE` cover those derived parts:

- Copyright (c) 2013-2019 BitPay, Inc.
- Parts based on Bitcoin Core, copyright (c) 2009-2015 The Bitcoin Core developers
- Parts based on fullnode, copyright (c) 2014 Ryan X. Charles and copyright (c) 2014 reddit, Inc.
- Parts based on BitcoinJS, copyright (c) 2011 Stefan Thomas
- Parts based on BitcoinJ, copyright (c) 2011 Google Inc.

Public names in this package do not use "bitcore". That name appears in this file and in dev-only tests that compare bytes against the old package. The old package's API, global network, and error strings are not part of this library.

This scaffold does not yet copy algorithm code. The license is included now so later ports do not land without it.
