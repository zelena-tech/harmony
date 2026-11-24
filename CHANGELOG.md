# Changelog

## 0.2.0 — unreleased

Stellar Harmony: a general layer on top of the engine. No contract changes:
the contracts and their wasm hashes (`contracts/wasm.sha256`) are unchanged.

### packages/kit (new, `@zelena/harmony-kit`)

- Programs: metrics that give points, levels that multiply them with lifetime
  points, a payout model (`proportional`, `topN` or `rate` with a budget) and
  pockets.
- Pockets split each person's reward: `instant` (a payment), `expires` (a
  claimable balance the person must claim before a date, or it returns to the
  payer) and `unlocks` (claimable only from a date, never reclaimable by the
  payer).
- People who cannot receive yet (no account or no trustline) are not skipped:
  their money waits as a claimable balance and they claim it with one
  signature that also adds the trustline.
- Non-custodial: the kit builds unsigned XDR. `submit` accepts only
  transactions whose hash matches what `build` produced and that pass a
  structural validation.
- Harmony Card per person (JSON and SVG) with level, points, pockets and the
  transaction hashes as proof.
- 14 industry templates in `packages/kit/templates/`, including
  `carrier-proof-of-delivery`, `supplier-deliveries` and `collections-team`.
- Tested offline and on testnet. Not audited.

### packages/connectors (new, `@zelena/harmony-connectors`)

- Input connectors for GitHub (merged pull requests, reviews, commits,
  milestones) and Azure Boards (closed items with effort, bugs), and
  `mergeEvents` to unify identities. No dependencies.
- `csvEvents`: a CSV export (RFC 4180, any delimiter, declared date and number
  formats) mapped to events by rules, with every unusable row reported in
  `skipped`. For companies that can export a spreadsheet but cannot give API
  access.
- A CSV export for the Stellar Disbursement Platform is in progress in this
  release.
- Tested offline. Not audited.

### packages/core

- `sdk` is now exported: the exact `@stellar/stellar-sdk` instance the engine
  uses, so packages built on top never mix two copies. This is the only change
  to `packages/core`; there is no logic change.

### Documentation and examples

- New docs: `docs/kit.md`, `docs/use-cases.md`, `docs/adoption-levels.md` and
  `docs/hackathon.md`. The README is rewritten for the new layer.
- New examples: `examples/quickstart-offline.js`,
  `examples/quickstart-testnet/run.js` and
  `examples/software-team/github-to-plan.js`.
- `examples/use-cases/run.js`: three runnable cases from a CSV (`carriers`,
  `suppliers`, `collections`) that stop at the payout plan.

## 0.1.1 — 2026-10-12

No contract or engine code changes.

- Fixed: the release hashes published in 0.1.0 came from a native Windows
  build. The wasm embeds the absolute path of the local Cargo registry in
  soroban-sdk panic messages, so those hashes could not be reproduced on
  another machine.
- New `scripts/build-wasm.sh`: builds the contracts in a pinned image
  (`rust:1.93.1-slim-bookworm`, fixed by digest). The expected hashes are in
  `contracts/wasm.sha256`, and CI checks them on every push.
- CI: `cargo test --locked`, Node 20, 22 and 24, and actions on Node 24
  runtimes.

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
