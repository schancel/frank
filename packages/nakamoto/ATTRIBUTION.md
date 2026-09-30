# Attribution

`@frank/nakamoto` is a new TypeScript library. Consensus behavior that later modules implement (transaction and block serialization, sighash, script results, address encodings, WIF, signature bytes) is derived from `packages/bitcore-lib-xpi`, a Lotus-flavored fork of BitPay's bitcore-lib.

BitPay's MIT license and the other copyright notices in `LICENSE` cover those derived parts:

- Copyright (c) 2013-2019 BitPay, Inc.
- Parts based on Bitcoin Core, copyright (c) 2009-2015 The Bitcoin Core developers
- Parts based on fullnode, copyright (c) 2014 Ryan X. Charles and copyright (c) 2014 reddit, Inc.
- Parts based on BitcoinJS, copyright (c) 2011 Stefan Thomas
- Parts based on BitcoinJ, copyright (c) 2011 Google Inc.

Public names in this package do not use "bitcore". That name appears in this file and in dev-only tests that compare bytes against the old package. The old package's API, global network, and error strings are not part of this library.

`src/convert-bits.ts` and `src/base32.ts` are derived from the cashaddr bit converter and 5-bit charset. Those files keep their copyright notices:

- Copyright (c) 2018 Matias Alejo Garcia
- Copyright (c) 2017 Emilio Almansi
- Copyright (c) 2017 Pieter Wuille

Base58check appends the first four bytes of SHA-256d, which is the Bitcoin checksum. The alphabet and the compact-size rules follow Bitcoin Core. SHA-256d is `@noble/hashes` 1.8.0, not a copy of the old hash wrapper.

`src/bech32.ts` implements the BIP173 and BIP350 checksums. `src/cashaddr.ts` implements the polymod in Bitcoin Cash Node `src/cashaddr.cpp`, which matches Bitcoin ABC `src/cashaddr.cpp`. Both are new code over those specifications, not a copy of the old `lib/address.js` routine. XPI address strings are not produced here.
