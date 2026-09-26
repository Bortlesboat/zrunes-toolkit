# API guide

Node.js 22+ and ECMAScript modules are required. Import from
`@bortlesboat/zrunes-toolkit`, or from `./index.mjs` inside this checkout.
The 0.x API may change. Pin a release and test your integration.

## Decode and encode

`decode(outputs)` accepts the decoded transparent output array:

```js
const outputs = [
  { n: 0, valueZat: '0', scriptPubKey: { hex: '6a5e03180700' } },
];
```

Each output needs its actual contiguous `n`, exact nonnegative `valueZat`
(a decimal integer string or safe integer), and lowercase script hex.
The result contains:

| Property | Meaning |
| --- | --- |
| `kind` | `absent`, `valid` or `malformed` carrier |
| `fields` | `Map<BigInt, BigInt[]>` of parsed fields |
| `edicts` | Allocations with BigInt `block`, `tx`, `amount`, `output` |
| `dataOutput` | Carrier output index, or null |
| `errors` | Detected format errors |
| `ambiguity` | Cases where this implementation cannot establish reference behavior |

`encode(fields, edicts = [])` returns script hex and enforces the relay-size limit.
Validate the resulting script with `decode(actualOutputs)` before using it: the
encoder does not know your transaction's output count. This is not a transaction
builder or signer.

`encodeName(text)` and `decodeName(value)` convert normalized A–Z names.
`commitmentHash(nameValue)` returns a Node Buffer containing the etch commitment
digest. Token amounts remain BigInt internally; never convert balances to Number.
Map and BigInt values need explicit conversion for JSON.

## Replay an archive

Supply your own archive file as `my-archive.json`:

```js
import { readArchive, replay } from '@bortlesboat/zrunes-toolkit';

const archive = readArchive('my-archive.json');
const ledger = replay(archive);
const snapshot = ledger.snapshot();
console.log(snapshot.coverage);
console.log(snapshot.assets);
```

For a runnable example using the included historical sample, run
`node examples/replay-sample.mjs` from a full repository checkout. The installed
package does not include sample fixtures or examples.

The input schema is `zrunes-block-archive-v1`:

```text
{
  schema, network, mode, startHeight, previousHash,
  blocks: [{ height, hash, previousblockhash, tx }]
}
```

`network` is `regtest`, `testnet` or `mainnet`. `mode` is `complete` or `sample`.
Complete replay begins at or before the configured protocol activation and
requires contiguous blocks and the complete transaction arrays. Sample mode
allows gaps and optional `txIndexes` containing the original transaction positions.
Never relabel a sampled archive as complete to suppress a coverage warning.

Transactions use `{txid, vin, vout}`. Non-coinbase inputs contain
`{txid, vout, scriptSig: {hex}}`; coinbase inputs contain `coinbase`.
Outputs have the shape above. Hashes and transaction IDs are lowercase
64-character hex strings. Imported commitment context is an explicit trust input:
`commitmentPrevouts` entries contain `txid`, `vout`, confirmed `height` and
`scriptPubKey: {hex}`. Complete scans accept those imports only for pre-scan history.

The snapshot serializes token amounts as decimal strings. Its schema identifier
`zec-market-zrunes-ledger-v1` is retained for compatibility with the original
recorded fixtures; it does not imply a connection to a hosted service.

## Apply blocks incrementally

```js
import { Ledger } from '@bortlesboat/zrunes-toolkit';

// archive must have the same verified network, anchor and coverage contract.
const ledger = new Ledger(archive);
for (const block of archive.blocks) ledger.applyBlock(block);
const quantity = ledger.balance('transaction-id:output-index', 'etch-height:tx-index');
```

`balance(outpoint, tokenId)` returns BigInt, including zero when no tracked balance
exists. Zero is meaningful only within the replay's coverage. `rollback()` undoes
one applied block. The default undo window is 128 blocks; deeper recovery requires
replaying an archive. Failed block application restores its prior ledger state.

All transactions must be supplied, including those without a ZRunes carrier:
ordinary spending can move or burn tokens. Invalid chain ordering, missing required
commitment context, ambiguous interpretation and broken accounting stop replay.

## Read from your node

```sh
node replay.mjs sync --rpc http://127.0.0.1:30000 --network regtest --state local.checkpoint.json --from 1
node replay.mjs replay local.checkpoint.json
```

This example requires your own running node. Sync performs read-only RPC calls;
it never signs or broadcasts. Repeating it resumes the checkpoint and handles a
changed branch. Use `--to HEIGHT` to bound the target. The node must support full
decoded `getblock` and archival transaction access for older commitments.

`rpcClient(url)`, `sync(rpc, options)`, `readArchive(file)`,
`writeCheckpoint(file, archive)` and `withCheckpointLock(file, operation)` are
also exported. The CLI combines them and excludes concurrent checkpoint writers.
Library callers must likewise hold `withCheckpointLock` around read/sync/write;
`writeCheckpoint` alone is not a concurrent-writer lock. After a crash, inspect
the lock's recorded PID and confirm that owner is gone before removing it.

RPC authentication is not implemented in this preview; credential-bearing URLs
are rejected. Responses and archives have explicit size/time limits. Consult
[integration boundaries](integration.md) before attaching this research client to
an operational node.
