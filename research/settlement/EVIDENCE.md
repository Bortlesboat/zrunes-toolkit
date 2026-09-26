# Native settlement evidence — 2026-09-25

[Final combined run](evidence/20260925T191044Z-16d6497e/receipt.json) used the pinned Zebra 6.4.0 archive in a fresh regtest and completed with exit 0 after both confirmed review findings were fixed. The owned node was stopped after PID/executable/configuration verification; root separately verified its PID no longer existed. No other node was used or controlled.

[Independent verification](evidence/20260925T191044Z-16d6497e/independent-replay.json) reconstructs the complete 110-block history twice: once from native exported transactions, once through the live Zebra RPC adapter. The resulting assets, supply and outpoints agree exactly. It separately checks ownership before the sale, the buyer's token quantity, seller's price plus carrier refund, the 30,000-zatoshi fee, identical recovered bytes, and all three specific consensus rejections. The complete JavaScript suite passes 81 tests, including deliberately corrupted evidence.

| Confirmed operation | Height:index | Transaction ID |
| --- | --- | --- |
| P2SH etch commitment and buyer funding | 102:1 | `7812e89b94b69ba4a6ecde28bf9befd14e15acfa86cc7bf9f6e2d6cd7dab3b0f` |
| Etch premine | 108:1 | `8115e249079b5ed0873f9dc9def2a426e254454a7d83f0145ac9f4ce169e4b2a` |
| Cancel first signed offer | 109:1 | `cf969443558a24d8eaee74a88da693e89479a93b71934558b976b4673695d06c` |
| Separately signed atomic sale | 110:1 | `d1cb4dc082ecf30a606b95fa6fe250ab216c6edc6dcc54a8c993233adf9c951f` |

The sale pays seller output 0 exactly `100140000` zatoshis: `100000000` price plus `140000` refunded asset-carrier value. Its zero-amount full-lot edict names `108:1` and assigns the entire `1000000000000000001` token balance to buyer output 1. The buyer pays a `30000`-zatoshi fee. The unsigned seller offer has only its asset input and matched payment output; the final accepted transaction adds buyer funding, buyer change and the transfer edict.

The [raw RPC receipts](evidence/20260925T191044Z-16d6497e/receipt.json) record three node failures with code `-25`: the altered payment ends in `ScriptInvalid`; the canceled offer and competing spend report `could not find transparent input UTXO in the best chain or mempool`. Both rejected purchases use buyer funding output 2, while the accepted sale uses output 1. Recorded `gettxout` results prove output 2 is live before and after the rejected submissions, while their token inputs are spent. The independent checker confirms these inputs against the complete archive, verifies the cancellation and sale ancestry, and rejects missing or contradictory evidence. The buyer process also independently rejects the altered payment and stale outpoint before signing.

The second buyer signing process restores only persisted proposal/policy/signature files and recreates identical sale bytes. A later fresh recovery process confirms raw-byte equality and transaction membership at 110:1. This demonstrates signer restart and confirmed-transaction recovery, not a node crash or storage-failure campaign.

The [replay bundle](evidence/20260925T191044Z-16d6497e/replay.json) includes complete blocks 1–110 with the genesis anchor. [Raw transactions](evidence/20260925T191044Z-16d6497e/raw-transactions.json) include every transaction in those blocks. Native acceptance and independent token accounting are both required and both passed; the Rust node acceptance check alone does not establish token ownership.

Focused Rust checks completed:

- `cargo test --locked`: 3 passed, covering ZIP 244 offer extension and payment mutation, economic/layout tampering, v5 serialization round trips and the commitment shape.
- `cargo clippy --locked --all-targets -- -D warnings`: passed.
- `cargo fmt`: applied before the successful native build.

During development, the node returned real rejection classes that differed from the harness's initial guessed message fragments. Those runs stopped rather than accepting an arbitrary error. Assertions were corrected to the observed exact classes, followed by the completed fresh run linked above. Incomplete debugging artifacts are retained only under ignored `.local/`.

Earlier development runs predated the live RPC hook and the behavior-preserving single-serialization cleanup. A diagnostic run reached native success but the RPC adapter stopped because Zebra reports regtest with BIP70's generic `test` label. The adapter now disambiguates using the exact regtest genesis and rejects a foreign genesis. Those superseded runs are not distributed in this standalone release.

The pre-review combined run proved the accepted sale and matching replay, but its canceled-offer rejection also had spent buyer funding. It could not attribute the failure solely to cancellation. The current checker intentionally rejects evidence without funding isolation. The final run linked above replaces that proof. Review also fixed native commitment push decoding and added malformed-etch and evidence-mutation tests.

These September 25 receipts record the original executed source bytes. The standalone release relocates the files, adds package license metadata, normalizes text line endings and makes the offline verification commands read-only; it preserves the codec, ledger, native signer and recorded transaction data. Original receipts are retained as historical evidence, not rewritten to claim a new native run.

Remaining coverage limits: the JavaScript verifier checks decoded confirmed blocks and saved proposal inputs, not an independent parse of every rejected raw transaction. The native fixture validates those variants. Generalized signer-provenance refusal cases and authoritative private protocol vectors remain unverified. Separate signer processes and this disposable chain do not establish production wallet security.
