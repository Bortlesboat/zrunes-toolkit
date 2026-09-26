# Attribution and provenance

Original toolkit code and documentation are licensed under [MIT](LICENSE).
This is an independent implementation, with no affiliation or endorsement from
Bitcoin Universe, the ZRunes authors, or the Zcash projects.

## Protocol source

The implementation follows Bitcoin Universe's [published ZRunes v1 specification](https://github.com/bitcoinuniverseio/docs-zerdinals-and-zrunes/blob/de03cd1850cace694320ba3cc44789c2036daa7a/src/content/docs/protocols/zrunes-v1.md),
pinned at `de03cd1850cace694320ba3cc44789c2036daa7a`.
The upstream documentation and code examples are offered under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The independent implementation changes language and structure and adds explicit
ambiguity stops, archive replay, and verification tooling. Source notices are
retained in the codec and ledger. The upstream documentation's license is not
replaced by this project's MIT license. No upstream product implementation is
bundled, and access to its authoritative private conformance vectors has not
been established.

## Evidence

Mainnet fixtures contain public blockchain facts captured through
[CipherScan](https://cipherscan.app/docs) and comparison snapshots from
[zrunes.io](https://zrunes.io/). URLs, observation times and response digests are
retained. They describe historical observations, not current balances. Source
attribution does not imply endorsement or change any third-party rights.
Only the normalized replay inputs, comparison data, provenance manifest and
three supporting transaction-detail responses are distributed here; see
[mainnet evidence](https://github.com/Bortlesboat/zrunes-toolkit/blob/v0.1.0/docs/mainnet-evidence.md).

The native regtest artifacts were generated locally with public disposable
fixture keys. The recorded September 25, 2026 run predates this standalone
repository. Original receipt bytes and hashes are retained; changed paths or
line endings in this release do not retroactively change the recorded run.

## Dependencies

The JavaScript library uses Node.js built-ins and has no runtime npm dependencies.
The separate browser demo bundles `@noble/hashes`, `buffer`, `base64-js` and
`ieee754`, and self-hosts Barlow Semi Condensed and IBM Plex Sans fonts. Their
notices are included in the site's `licenses.txt`; see [website attribution](https://github.com/Bortlesboat/zrunes-toolkit/blob/main/website/README.md#attribution).
The optional Rust settlement experiment uses dependencies pinned in its
`Cargo.lock`, including the Zcash libraries and secp256k1. These dependencies
retain their own licenses; their source or binaries are not vendored here.
The Zebra node downloaded by the optional runner is distributed by the Zcash
Foundation under its own release terms. The runner pins and verifies its archive.
