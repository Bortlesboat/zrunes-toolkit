# Related work

Checked September 26, 2026. This toolkit implements the public
[ZRunes v1 specification](https://github.com/bitcoinuniverseio/docs-zerdinals-and-zrunes/blob/de03cd1850cace694320ba3cc44789c2036daa7a/src/content/docs/protocols/zrunes-v1.md)
independently. It is not an official or reference implementation.

Public repository, source and package searches found the following relevant work.
They did not find a directly substitutable public ZRunes v1 library. That is a
bounded search result, not a claim that no other implementation exists.

| Project | Relationship to this toolkit |
| --- | --- |
| [Bitcoin Universe documentation](https://github.com/bitcoinuniverseio/docs-zerdinals-and-zrunes) | Publishes the protocol and API contract under CC BY 4.0. Describes a Rust codec and TypeScript implementations. The named [indexer](https://github.com/bitcoinuniverseio/index-zcash-metaprotocols) and [product](https://github.com/bitcoinuniverseio/zerdinals-and-zrunes) repositories returned public HTTP 404 on the check date; their implementation and reference vectors could not be inspected. |
| [Bitcoin Universe Mempool](https://github.com/bitcoinuniverseio/mempool) | Public explorer integration, licensed AGPL v3 under its stated terms. Its [coverage contract](https://github.com/bitcoinuniverseio/mempool/blob/cb37d7f32c9ce4928400ef7c4cbe7ceb5b9d288f/docs/protocols/PROTOCOL-COVERAGE.json) directs ZRunes requests to a separate indexer. Its inspected [Runestone decoder](https://github.com/bitcoinuniverseio/mempool/blob/cb37d7f32c9ce4928400ef7c4cbe7ceb5b9d288f/backend/src/api/intelligence/protocols/runestone.ts) recognizes Bitcoin's OP_13 carrier. |
| [Zordinals.fun](https://www.zordinals.fun/zrunes) | Advertises zRunes etching and minting. The inspected pages did not establish a reusable source license or compatibility with the OP_14 ZRunes v1 format. A shared name alone does not establish interoperability. |
| [ZX launchpad](https://github.com/nostalgicgarethdev/zxpad) | Public frontend prototype for Zcash runes. At inspected revision `5d23aaa`, [wallet](https://github.com/nostalgicgarethdev/zxpad/blob/5d23aaa158e92d9ac9000e4861976c373285fd19/src/lib/wallet.tsx) and [launch](https://github.com/nostalgicgarethdev/zxpad/blob/5d23aaa158e92d9ac9000e4861976c373285fd19/src/lib/store.ts) state use local browser data. No reusable codec/indexer or LICENSE file was found in that revision. |
| [Zordinals node tools](https://github.com/Zordtoshi/zordinals-node-tools-v2) | MIT-licensed node and inscription tooling. Its [decoder](https://github.com/Zordtoshi/zordinals-node-tools-v2/blob/c587f119003f7fdcb576bf5a36027ff05e98de13/decode.js) reconstructs `ord` scriptSig inscriptions, a different carrier and asset model. |
| [ZRC-20 indexer](https://github.com/vladimir-nocy/zrc20-indexer) | MIT-licensed Zcash indexer with node ingestion and persistent state. Its [parser](https://github.com/vladimir-nocy/zrc20-indexer/blob/7efd1c10b36ed4d0744405218e18858783a5bc1f/src/protocol.rs) processes transparent JSON ZRC-20 instructions, not binary ZRunes v1 messages. |
| [runelib](https://github.com/sCrypt-Inc/runelib) and [ord](https://github.com/ordinals/ord) | Reusable Bitcoin Runes implementations under MIT and CC0, respectively. Their Bitcoin rules and transaction assumptions are not drop-in Zcash support. |

The search included GitHub repository queries, direct inspection of candidate
source trees, public documentation, and npm/crates.io searches for `zrunes` and
`zordinals`. Those exact registry searches returned no packages. Global GitHub
code search was unavailable without authentication to that endpoint, and search
engines can miss repositories or packages with unrelated names. No candidate's
runtime correctness or deployed wallet behavior was tested in this search.

The contribution here is inspectable decoding and accounting code, examples, and
reproducible evidence. Upstream conformance and production wallet integration
remain work to do. No implementation code from the projects above was imported;
see [NOTICE.md](../NOTICE.md) for protocol and evidence attribution.
