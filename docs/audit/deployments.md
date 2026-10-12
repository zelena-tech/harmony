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
| Unoptimized build of this source (Rust 1.93.1) | `de8b32f4e70a7d060a2985ea58d4f56fe8f79402c92a88692953903670dc0150`, 49 760 bytes |
| Optimized with Stellar CLI 25.2.0 | `17e8821a9a42f7885612d37a042a580981de35833133f19ad0487b7573455dd0`, 36 975 bytes |
| Byte-identical to the deployed wasm | **No**. The deployed wasm was optimized with a tool version that was not recorded (37 360 bytes). Byte-level reproducibility is therefore not established for this deployment. |

The spec embeds every public type, function signature and doc comment of the
source, so an identical spec plus identical toolchain metadata is strong
evidence that the deployed contract was built from this source. For any
future deployment we will publish the exact toolchain, CLI version and wasm
hash before deploying (see [deployment.md](../deployment.md)).

Test-only changes made in this repository (`#[cfg(test)]` code, not part of
the wasm): the missing `testutils::Ledger` import, a distinct funder in 6
tests, and one test per finding. The release wasm built before and after these
changes has the same hash (`de8b32f4…` above).

### Reproduce the check

```bash
# deployed wasm
stellar contract fetch --id CCPJRCF3T3HUAH5SR2Q52R3PAGBU5HUB4SNNG2MNSN3HA7TSLAP23PAV --network testnet -o deployed.wasm
sha256sum deployed.wasm

# local build (toolchain pinned by contracts/rust-toolchain.toml)
cd contracts && cargo build --target wasm32-unknown-unknown --release && cd ..

stellar contract info interface --wasm deployed.wasm --output json-formatted > spec-deployed.json
stellar contract info interface --wasm contracts/target/wasm32-unknown-unknown/release/harmony_organization.wasm --output json-formatted > spec-local.json
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
