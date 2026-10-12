# Changelog

## 0.1.0 — 2026-10-12

First public release, prepared for an external audit.

### Contracts

- Organization and Factory contracts published unchanged from the version
  deployed on testnet (same contract spec and metadata; see
  `docs/audit/deployments.md`).
- Test module fixes (test code only, the release wasm is byte-identical):
  - added the missing `soroban_sdk::testutils::Ledger` import, without which
    the organization tests did not compile;
  - six tests now fund periods with a caller different from the funder
    (see HMY-08);
  - one test per self-review finding (`finding_hmy<NN>_*`).
- Toolchain pinned to Rust 1.93.1 (`rust-toolchain.toml`); machine-specific
  linker settings removed from `.cargo/config.toml`.

### packages/core

- New package `@zelena/harmony-core`: the scoring, payout planning and
  payment validation logic of the host system, extracted without database
  access or environment variables, organized per tenant (`defineTenant`,
  `createHarmony`).
- 80 tests with `node --test`; test data uses generated wallets and generic names.

### Documentation

- Architecture, multi-tenant model, contract reference, scoring, payouts,
  integration and deployment guides.
- Audit guide, threat model, 18 self-review findings and deployment evidence.
