# ZRunes Toolkit

Experimental JavaScript tools for developers building ZRunes wallets, explorers,
indexers and other Zcash products. Decode token instructions, reconstruct balances
from decoded blocks, and reproduce the included accounting checks.

**Research preview.** This is an independent implementation of the published
ZRunes v1 rules. Mainnet verification is sampled, full reference conformance is
unverified, and this package is not a production wallet. ZRunes balances and
activity are public on Zcash's transparent pool.

## Try it

Open the [interactive demo](https://bortlesboat.github.io/zrunes-toolkit/) to decode
scripts and replay the historical sample in your browser. The demo uses the same
codec and ledger through a site-specific adapter; the published library remains
Node.js-only. See [website development](https://github.com/Bortlesboat/zrunes-toolkit/blob/main/website/README.md) to run the site locally.

Install Node.js 22 or newer and Git. No npm dependencies are needed for the
JavaScript commands.

```sh
git clone https://github.com/Bortlesboat/zrunes-toolkit.git
cd zrunes-toolkit
npm test
npm run example
node examples/replay-sample.mjs
npm run verify:sample
```

The sample comparison checks 88 historical transactions across 52 sampled blocks,
seven token records and three resulting balance outputs. It passes 96 comparisons
against separately captured observations. The sample is dated September 25, 2026;
it does not establish current balances or discover every token on Zcash.

## Use it in a project

Install the GitHub release into a Node.js project:

```sh
npm install github:Bortlesboat/zrunes-toolkit#v0.1.0
```

```js
import { decode, encode } from '@bortlesboat/zrunes-toolkit';

const script = encode(new Map([[24n, [7n, 0n]]]));
const message = decode([
  { n: 0, valueZat: '0', scriptPubKey: { hex: script } },
]);

console.log(message.kind);              // valid
console.log(message.fields.get(24n));   // [7n, 0n]
```

A valid instruction is only a parsing result. Establishing ownership or mint
eligibility requires the preceding chain history. See the [API guide](https://github.com/Bortlesboat/zrunes-toolkit/blob/v0.1.0/docs/api.md)
for ledger replay and the [integration boundaries](https://github.com/Bortlesboat/zrunes-toolkit/blob/v0.1.0/docs/integration.md) before
using results in a wallet. The package uses Node.js APIs; it is not a drop-in
browser bundle. GitHub is the distribution channel; no npm registry release is
published.

## What is included

- **Codec:** BigInt quantities, names, commitments, fields and output allocations.
- **Ledger:** issuance, mint caps, transfers, burns, conservation checks and block
  rollback, including ordinary transactions that spend token-bearing outputs.
- **Replay:** offline archives and a bounded read-only RPC sync command with
  checkpoint recovery and reorganization handling.
- **Evidence:** an explicitly incomplete mainnet sample and an archived,
  separately signed token-for-ZEC regtest sale.

`npm run verify:settlement` checks the archived sale using the independent ledger.
It does not start a node or broadcast a transaction. The optional
[Rust settlement experiment](https://github.com/Bortlesboat/zrunes-toolkit/blob/v0.1.0/research/settlement/README.md) contains the separate
signer processes and disposable node runner. Its public test keys must never
receive real funds.

## What developers should know

The ledger trusts its supplied decoded blocks for Zcash consensus validity.
It does not verify signatures, proof of work or Merkle inclusion. Use a validating
node for that boundary. Unknown history is not a zero balance.

Some malformed-message interpretations require unavailable reference decisions;
the ledger halts on the documented ambiguity cases. It does not silently choose
a balance. Checkpoint files have a 128 MiB limit, and restart replays the archive;
this is a bounded research engine, not a database for continuous mainnet indexing.

This toolkit does not implement key custody, production coin selection, a
general signing API, shielded tokens or full ZMarket order interoperability.
Read [recorded evidence and limits](https://github.com/Bortlesboat/zrunes-toolkit/blob/v0.1.0/docs/mainnet-evidence.md),
[settlement evidence](https://github.com/Bortlesboat/zrunes-toolkit/blob/v0.1.0/research/settlement/EVIDENCE.md), and
[related work](https://github.com/Bortlesboat/zrunes-toolkit/blob/v0.1.0/docs/related-work.md).

## Help improve it

Useful contributions include reproducible parser disagreements, independently
obtained conformance vectors, complete-history comparisons, and integration
examples. Include the protocol version, network, block/transaction identity and
expected versus observed behavior. Please do not attach private keys, seeds or
private wallet data. See [contributing](https://github.com/Bortlesboat/zrunes-toolkit/blob/v0.1.0/CONTRIBUTING.md) and [security](https://github.com/Bortlesboat/zrunes-toolkit/blob/v0.1.0/SECURITY.md).

Original code is [MIT licensed](LICENSE). Protocol and evidence attribution is
in [NOTICE.md](NOTICE.md).
