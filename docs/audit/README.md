# Audit guide

This page is the entry point for reviewers from the Stellar ecosystem.

## Scope

| Component | Path | Size | Language |
|---|---|---|---|
| Organization contract | `contracts/organization/src/lib.rs` | ~1 060 lines of contract code + tests | Rust, soroban-sdk 21.7.7 |
| Factory contract | `contracts/factory/src/lib.rs` | ~150 lines + tests | Rust, soroban-sdk 21.7.7 |
| Off-chain engine | `packages/core/src` | ~1 300 lines including comments | JavaScript (Node ≥ 20), @stellar/stellar-sdk 14 |

Priorities, in order:

1. Fund safety of the Organization contract: `fund_period`, `claim_reward`,
   `recover_undistributed`, `sweep_expired_claims`, `distribute_rewards`.
2. Access control: the role matrix in `add_member` and the Owner functions.
3. Direct-payment construction and validation:
   `packages/core/src/payouts/transactions.js`.
4. Payout arithmetic: `packages/core/src/payouts/plan.js`, `packages/core/src/period.js`.

Out of scope: see [threat-model.md](threat-model.md#out-of-scope).

## Build and test

```bash
# contracts — toolchain pinned to Rust 1.93.1 (same as the testnet deployment)
(cd contracts && cargo test)                           # 31 tests

# reproducible release build (Docker; Linux, macOS or WSL)
scripts/build-wasm.sh --check                          # compares with contracts/wasm.sha256

# off-chain engine
cd packages/core
npm ci
npm test                                               # 80 tests, no network
```

Expected release hashes (Rust 1.93.1, before optimization), also in
[`contracts/wasm.sha256`](../../contracts/wasm.sha256) and checked by CI on
every push:

```
84986a8dc22dd97070c41ceac5b93d5053c70f9af2639e6248ef9c1c1ff86ec7  harmony_organization.wasm
067820032e0aca19fc0aff311bd488d21655bfa81fd3bffb126e7887cbde0954  harmony_factory.wasm
```

A native `cargo build` gives a different hash: the wasm embeds the absolute
path of the local Cargo registry in the panic messages of soroban-sdk. The
script builds in a pinned image (`rust:1.93.1-slim-bookworm`, fixed by digest)
where that path is always `/usr/local/cargo`.

## Documents

| Document | Content |
|---|---|
| [../architecture.md](../architecture.md) | layers, payout rails, period lifecycle, roles |
| [../multi-tenant.md](../multi-tenant.md) | isolation on-chain and off-chain, configuration |
| [../contracts/organization.md](../contracts/organization.md) | every entry point: auth, role, preconditions, effects, events, errors |
| [../contracts/factory.md](../contracts/factory.md) | registry contract |
| [../scoring.md](../scoring.md) | every formula used to compute points and shares |
| [../payouts.md](../payouts.md) | direct-payment rail and contract rail |
| [threat-model.md](threat-model.md) | actors, trust, assets, invariants, attack surface |
| [findings.md](findings.md) | 18 self-review findings, each with a reproducing test |
| [deployments.md](deployments.md) | testnet deployment and source equivalence evidence |

## Known issues

Read [findings.md](findings.md) first: the most relevant are HMY-01 (the
Owner can lock itself out), HMY-16 (initialization front-running), HMY-10
(TTL) and HMY-04/HMY-05/HMY-17 (centralization and trust in Supervisors).
None of them lets an unprivileged actor take funds.

## Conventions

- Contract source comments are in Spanish and were kept unchanged, because
  doc comments are part of the contract spec embedded in the wasm.
- Every finding has a test named `finding_hmy<NN>_*` (Rust) or a test that
  references its id (Node). A fix must change that test deliberately.
- Report vulnerabilities through GitHub private vulnerability reporting
  ([SECURITY.md](../../SECURITY.md)).
