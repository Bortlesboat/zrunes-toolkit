# Transparent ZRunes full-lot settlement experiment

This isolated regtest harness creates a real Zcash v5 transaction that pays the seller and moves an entire ZRune balance to the buyer. It tests a settlement primitive, not the ZMarket offer envelope, a production wallet, or mainnet interoperability. The separate JavaScript ledger at the repository root interprets the exported confirmed chain independently. All keys in this experiment are public disposable fixtures; never fund them with real ZEC.

Run from this directory with native Rust, PowerShell 7.4+, and an existing `Ubuntu-24.04` WSL distribution:

```powershell
cargo test --locked
./run-regtest.ps1
# Or verify the independent live RPC adapter before the owned node shuts down:
./run-regtest.ps1 -ReplayCli ../../replay.mjs
```

The runner downloads Zebra 6.4.0 or accepts `-ArchivePath` pointing to a previously downloaded archive. It verifies SHA-256 `e395623bd7dcb56024c14eecd622f6d747f4df2bb08363db1448406d7bd1811d`, starts a fresh isolated node with NU6.3 active at height 1, and checks the regtest genesis. RPC listens on a random loopback port. The WSL helper starts hidden. Before stopping its own node, the runner verifies the recorded PID's executable and unique configuration path. No existing node, wallet, or service is changed.

The confirmed sequence is:

1. Mine 101 blocks to a public disposable fixture key. Split matured coinbase funding into the etch P2SH commitment and two buyer funding outputs at height 102.
2. Etch `REGTESTATOMICLOT` at height 108, using the exact P2SH redeem script and six-block commitment gap required by the pinned specification. Premine is `1000000000000000001`, intentionally above JavaScript's exact integer range. Identity is `108:1`.
3. Invoke the seller signer on a one-input, one-output offer; invoke the buyer signer in another process to append funding, change and an edict transferring the full lot. Reserve buyer funding output 2 for this first offer. Confirm cancellation at 109 before submitting it, then require both a buyer stale refusal and a node rejection.
4. Produce a fresh offer for the cancellation successor. Reject a one-zatoshi seller-payment reduction in the buyer signer, and have the node reject a deliberately constructed attack transaction carrying a valid buyer signature but the original seller signature.
5. Run the buyer signer twice from serialized policy/offer/signature artifacts after the first process has exited. Require byte-identical recovered transactions. The accepted sale uses buyer funding output 1. Prepare a competing purchase using output 2, confirm the accepted sale at 110, and require rejection of both the canceled offer and competing spend. Check and record that output 2 remains unspent before and after those submissions, so spent buyer funding cannot explain either rejection.
6. Start a fresh recovery process that checks the known sale transaction against confirmed RPC data. Export all confirmed transactions in every block from 1 through tip, including coinbases and ordinary transactions.

Zebra resolves already-spent transparent inputs as missing UTXOs after its internal wait. The two independent negative submissions run concurrently and can add several minutes. The harness requires the specific structured `-25` consensus rejection; transport failures are failures, not evidence of rejection.

## Signature and economics contract

`seller-sign PORT POLICY OFFER OUTPUT` signs input 0 with ZIP 244 `SINGLE|ANYONECANPAY` (`0x83`). The seller verifies the exact asset outpoint and provenance, input/output position, expiry, and payment script. Output 0 must pay the fixed one-ZEC price plus refund the asset output's zatoshi carrier value. This signature intentionally lets the buyer append inputs and outputs; it commits to the seller's matched output and the v5 header.

`buyer-sign PORT POLICY PROPOSAL SELLER_SIGNATURE OUTPUT` checks confirmed issuance and a bounded full-lot provenance chain, the live asset and funding outpoints, the exact agreed price, 30,000-zatoshi fee, refund, buyer change, and edict allocating the full lot to buyer output 1. It verifies the seller signature before signing its funding input with `SIGHASH_ALL`. It permits exactly two inputs and three outputs. The buyer's funding must descend directly from a coinbase through a token-free split.

Seller and buyer policy files are fixture-local economic approvals; the signer commands also enforce the experiment's fixed price, fee, quantity and expiry. This is a narrow fixture verifier rather than a general token-aware wallet. Its lineage verifier recognizes this one issuance and the cancellation successor; the independent ledger performs the general block interpretation.

The coordinator uses public-key constants and never instantiates secret keys or signs. Setup, cancellation, and deliberate attack construction use separate `fixture-sign` child processes. All commands share one binary and operating-system account; process separation is an execution boundary, not a security boundary. The keys are public deterministic fixtures, generated only inside signer execution. There are no wallet imports, private key files, real funds, shielded claims, or remote-RPC parameters.

## Evidence

Each successful invocation creates an `evidence/<run>/` directory containing:

- `receipt.json`: node version/archive identity, source hashes, economic assertions, confirmed transaction locations, exact rejection RPC responses, and signer subprocess exit/output records.
- `blocks.json`: complete canonical decoded blocks, with `valueZat` derived from integer Rust transaction values.
- `replay.json`: the same blocks wrapped as a complete regtest replay bundle with the genesis anchor.
- `raw-transactions.json`: complete serialized bytes of every confirmed transaction, keyed by independently computed transaction ID.
- Policy, proposal, signature and raw transaction artifacts, plus `recovery.json`.

Node acceptance establishes Zcash consensus validity, not token interpretation. Use the independent ledger to establish token issuance, transfer and conservation. Decoded blocks are a trust boundary: this harness checks RPC membership and raw transaction round trips but does not independently validate block proof of work or Merkle roots.

Recovery covers signer process exit/restart and discovery of an already-confirmed transaction. It does not demonstrate node-database crash recovery, key custody, reorg handling, or an online order service. Cancellation and competing-spend tests show rejection after the first spend is confirmed; they do not establish which simultaneous mempool submission wins.

## Primary sources

- [Pinned ZRunes v1 specification](https://github.com/bitcoinuniverseio/docs-zerdinals-and-zrunes/blob/de03cd1850cace694320ba3cc44789c2036daa7a/src/content/docs/protocols/zrunes-v1.md): etch commitment, activation, premine and full-lot edict semantics.
- [ZIP 244](https://zips.z.cash/zip-0244): v5 signatures, `SINGLE|ANYONECANPAY`, input amounts, locking scripts, and matched outputs.
- [zcash_primitives 0.30.0 transaction API](https://docs.rs/zcash_primitives/0.30.0/zcash_primitives/transaction/index.html) and [zcash_transparent 0.10.0 sighash API](https://docs.rs/zcash_transparent/0.10.0/zcash_transparent/sighash/index.html): pinned serialization and signature-hash implementations. `Cargo.lock` pins the full dependency graph.
- [Zebra 6.4.0 release](https://github.com/ZcashFoundation/zebra/releases/tag/v6.4.0): isolated consensus node.

The runner owns a unique state directory and verifies its node process before cleanup. Linux/macOS users can run the Rust unit tests, but the supplied live-node orchestration script requires Windows, PowerShell and WSL as stated above.
