# Mainnet sample — September 25, 2026

The independent ledger reproduces seven captured token records and three final
token-bearing outputs, with **96 comparisons and zero mismatches**. These are
historical, sampled observations. They are not a complete mainnet index or a list
of everything in the ecosystem.

## Inputs and provenance

- [Sample bundle](../fixtures/mainnet/sample-bundle.json): 88 decoded transactions
  across 52 blocks, with sparse original transaction positions and seven commitment
  prevouts. It explicitly declares `mode: "sample"`.
- [Block inventories](../fixtures/mainnet/block-inventories.json): 1,619 transaction
  IDs covering those blocks, including transactions omitted from the sample.
- [Two complete blocks](../fixtures/mainnet/full-decoded-blocks.json): separately
  recorded and noncontiguous; they do not make the entire sample complete.
- [Comparison snapshot](../fixtures/mainnet/operator-expected.json): separately
  observed operator token and holder records. They are comparison results, never
  inputs to the state engine.
- [Original receipt](../fixtures/mainnet/recorded-replay.json): decoder/ledger/bundle
  hashes, classifications, reconstructed balances and the 96 checks.
- [Source manifest](../fixtures/mainnet/source-manifest.json): URLs, times and hashes
  from the original 159-response collection. Most raw responses are not distributed
  here. The six files in `fixtures/mainnet/raw/` retain only three transaction-detail
  responses and their provenance sidecars needed for the unspent-output comparison.

Observations were captured between 18:23:02 and 18:27:34 UTC. The decoded inputs
come from [CipherScan's documented API](https://cipherscan.app/docs), independently
of the ZRunes operator's token interpretation. They still trust that explorer's
chain data. Operator snapshots come from [zrunes.io](https://zrunes.io/).

The 88 transactions classify as 23 valid carriers, five malformed carriers and
60 ordinary transactions. No ordinary transaction in this mainnet sample spends
a positive tracked token balance; unit tests and the separate regtest experiment
cover ordinary token-bearing spends.

## Results and limits

| Token | Issued base units | Burned | Circulating |
| --- | ---: | ---: | ---: |
| GLASSTESTONE | 1000 | 298 | 702 |
| ZRUNES | 1000000000000000000000 | 0 | 1000000000000000000000 |
| ZEBRA, ZKZKGOOSE, ACCIDENTALLYZEC, ZECCATCAMEHOME, TENYEARSNOOVERSHARING | 0 each | 0 | 0 |

The token snapshot is at height 3,495,996, holder snapshots at 3,496,004, and the
latest decoded transaction at 3,495,855. The observations are asynchronous;
unspent checks have their own timestamps. Agreement does not establish global
state at a shared tip. Blocks and transactions elsewhere could change the result.

The sample starts after activation and omits most chain history. Its commitment
and balance dependencies close for the discovered records under the captured
observations, but undiscovered activity cannot be excluded. The original source
collection was not a full scan and no authoritative golden-vector parity was
established.

Run the comparison without network access:

```sh
npm run verify:sample
node examples/replay-sample.mjs
```

Both commands leave the recorded evidence unchanged. The comparison prints counts
and exits nonzero on mismatch. The original response digests describe the initial
collection, not a guarantee that those remote URLs return the same bytes today.
