# Contributing

Small, reproducible improvements are welcome. This is an experimental independent
implementation; preserving deterministic interpretation matters more than adding
product features quickly.

Start with `npm test`, `npm run example`, `npm run verify:sample` and
`npm run verify:settlement`. They need Node.js 22+ and no runtime npm dependencies.
Rust changes also need `cargo test --locked` and
`cargo clippy --locked --all-targets -- -D warnings` from `research/settlement`.

For a protocol disagreement, include the pinned specification passage, network,
block hash, transaction and expected versus observed interpretation. Add a focused
regression and preserve exact integer amounts. Do not resolve an ambiguity by
silently borrowing a reported balance from an operator.

Keep unrelated cleanup separate. Preserve recorded fixture bytes and provenance;
new observations belong in a dated dataset. Identify sample gaps and the source's
trust boundary. Do not claim a complete chain scan from a token event list.

Wallet examples must not solicit or embed real seeds, keys or credentials. The
native research keys are intentionally public. For possible security defects,
follow [SECURITY.md](SECURITY.md) before sharing a reproducer publicly.

Pull requests should explain the change and the checks run. Contributions are
accepted under the repository's MIT license, with existing third-party notices
preserved. No response-time or support guarantee is offered for this preview.
