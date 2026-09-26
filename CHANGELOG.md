# Changelog

## 0.1.0 — 2026-09-26

Initial experimental developer release: independent ZRunes v1 codec, BigInt ledger,
rollback and archive/RPC replay, historical mainnet comparisons, and separately
signed regtest settlement evidence. Includes a small module import surface,
examples, licensing, integration boundaries and automated checks.

The codec, ledger and native signer preserve the reviewed research implementation.
This release changes packaging and documentation, relocates fixture paths, and
makes offline evidence verification read-only. Full mainnet scanning, authoritative
reference-vector parity and production wallet integration remain unverified.
