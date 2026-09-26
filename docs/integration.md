# Integration boundaries

Use this release to experiment, compare interpretations and reproduce results.
A wallet or product must add the guarantees below before relying on it for funds.

## Node validity and token interpretation are separate

A validating Zcash node establishes the underlying transactions and chain.
This toolkit interprets their decoded transparent inputs and outputs according
to the pinned public ZRunes rules. It does not verify consensus, signatures,
transaction hashes or Merkle proofs. A dishonest or incomplete provider can give
the library a misleading history.

`coverage.complete` reports contiguous decoded replay within the supplied
contract. It is not independent proof that a node or archive is honest. The
included mainnet fixture is deliberately incomplete and historical.

## A wallet must understand token-bearing outputs

Do not treat this library's zero balance as permission to spend unless history
is complete and current for the exact network and protocol. Coin selection must
protect outputs carrying tokens; an ordinary ZEC payment can accidentally move
or burn them. Shielding ZEC does not shield or preserve a ZRunes balance.

Recheck ownership and funding when preparing and signing a purchase. Model
unconfirmed transactions, stale offers, cancellation, fees and reorganizations.
This toolkit reconstructs confirmed state; it supplies no mempool reservation,
order service, custody, seed recovery or general transaction-signing API.

## Compare implementations before serving balances

The published specification references authoritative Rust code and conformance
vectors that were not publicly accessible during this work. Sample agreement
does not establish full compatibility. This implementation stops on certain
unresolved malformed-message cases; callers must surface that unavailable state
instead of displaying zero or quietly selecting another provider's answer.

Useful next evidence includes complete activation-to-tip replay, independently
obtained vectors, documented resolution of ambiguous cases, and comparison with
another operator at the same block hash. This release does not claim any of those
gates is complete.

## Plan a durable service separately

The current archive is limited to 128 MiB and replayed on restart. The in-memory
undo history is bounded. A public service needs appropriate storage, backpressure,
monitoring, RPC authentication and operational recovery. A browser wallet needs
an adapter or another implementation; the package depends on Node.js APIs.

## Settlement research

The optional Rust experiment proves a narrow full-lot sale on disposable regtest,
with separately invoked seller and buyer signers. The signers share a host and
use public deterministic keys. They are not secure wallet isolation, a general
provenance verifier or an implementation of the entire ZMarket order envelope.
No real funds should be sent to those keys.
