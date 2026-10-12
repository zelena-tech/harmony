# Deployments and source equivalence

## Reference deployment (testnet)

| Item | Value |
|---|---|
| Contract | Organization |
| Network | Stellar testnet |
| Contract id | `CCPJRCF3T3HUAH5SR2Q52R3PAGBU5HUB4SNNG2MNSN3HA7TSLAP23PAV` |
| Wasm hash (sha256 of the on-chain wasm) | `2d794ee7170b66f2f980c6e6c41882165172184b34ab6730fba422234e7b9ead` |
| Wasm size | 37 360 bytes |
| Contract meta | `rsver: 1.93.1`, `rssdkver: 21.7.7#5da789c50b18a4c2be53394138212fed56f0dfc4` |
| Checked on | 2026-10-12, testnet ledger 5 163 159 |

There is **no mainnet deployment** of these contracts referenced by this
repository. A Factory instance for the pilot is not identified here.

## Does the source match the deployed contract?

What we checked, and what we could not:

| Check | Result |
|---|---|
| Contract spec (all types, functions, errors and doc comments) of the deployed wasm vs a build of this source | **Identical**: `stellar contract info interface --output json-formatted` produces the same 21 973 bytes for both |
| Contract meta (Rust and SDK versions) | **Identical** |
| Reproducible build of this source (`scripts/build-wasm.sh`, unoptimized) | `84986a8dc22dd97070c41ceac5b93d5053c70f9af2639e6248ef9c1c1ff86ec7` |
| Byte-identical to the deployed wasm | **No**, for two reasons. The deployed wasm was built natively on Windows, so it embeds the absolute path of that machine's Cargo registry in soroban-sdk panic messages. It was also optimized with a tool version that was not recorded. A native Windows build of this source with a Cargo path of the same length, optimized with Stellar CLI 25.2.0, gives 36 975 bytes against 37 360 deployed, so the optimizer differs too. Byte-level reproducibility is therefore not established for this deployment. |

The spec embeds every public type, function signature and doc comment of the
source, so an identical spec plus identical toolchain metadata is strong
evidence that the deployed contract was built from this source. Future
deployments will use the reproducible build, and we will publish its hash and
the optimizer version before deploying (see [deployment.md](../deployment.md)).

Test-only changes made in this repository (`#[cfg(test)]` code, not part of
the wasm): the missing `testutils::Ledger` import, a distinct funder in 6
tests, and one test per finding. Building the release wasm before and after
these changes on the same machine gives the same hash.

### Reproduce the check

```bash
# deployed wasm
stellar contract fetch --id CCPJRCF3T3HUAH5SR2Q52R3PAGBU5HUB4SNNG2MNSN3HA7TSLAP23PAV --network testnet -o deployed.wasm
sha256sum deployed.wasm

# local build (any build works for the spec; the reproducible one also matches contracts/wasm.sha256)
scripts/build-wasm.sh

stellar contract info interface --wasm deployed.wasm --output json-formatted > spec-deployed.json
stellar contract info interface --wasm contracts/target/reproducible/wasm32-unknown-unknown/release/harmony_organization.wasm --output json-formatted > spec-local.json
diff spec-deployed.json spec-local.json && echo "same spec"
stellar contract info meta --wasm deployed.wasm
```

## Evidence for HMY-08 (testnet)

A throwaway copy of the organization contract was deployed on testnet with a
fresh account to check `fund_period` with caller == funder authorized as the
transaction source account. It succeeded:

| Item | Value |
|---|---|
| Contract | `CBKMBEPGZ7K4AGKBD6GKZCPBZYQMXKJY5LOOUF6Q3SHXEIT4VIZUPMJ4` (temporary) |
| Reward asset | a test asset issued by the same account |
| Transaction | [`166f27bff31998832ff76c550cbea72b1b6cac7002ee8ee04404a877a817a742`](https://stellar.expert/explorer/testnet/tx/166f27bff31998832ff76c550cbea72b1b6cac7002ee8ee04404a877a817a742) |
| Events | `mint` (SAC) and `period_funded(1)` |
