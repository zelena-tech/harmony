# Build, test and deploy

## Toolchain

| Tool | Version |
|---|---|
| Rust | 1.93.1 (pinned in `contracts/rust-toolchain.toml`, same as the reference deployment) |
| Target | `wasm32-unknown-unknown`, built with `-C target-feature=-reference-types` (`contracts/.cargo/config.toml`) |
| soroban-sdk | 21.7.7 (locked in `contracts/Cargo.lock`) |
| Stellar CLI | ≥ 22 (`stellar contract optimize`, `deploy`, `invoke`) |
| Node.js | ≥ 20 |

## Contracts

```bash
(cd contracts && cargo test)                           # 31 tests, includes one test per finding

scripts/build-wasm.sh --check                          # reproducible build, compared with contracts/wasm.sha256
stellar contract optimize --wasm contracts/target/reproducible/wasm32-unknown-unknown/release/harmony_organization.wasm
stellar --version                                      # record it next to the optimized hash
```

Deploy only the output of `scripts/build-wasm.sh`. A native
`cargo build --release` embeds the absolute path of the local Cargo registry
in the wasm, so its hash depends on the machine and cannot be matched by a
third party. If the source changes, update `contracts/wasm.sha256` in the same
commit; CI fails otherwise.

On Windows with the GNU toolchain, use `cargo test --lib` (the `cdylib`
artifact of the host build needs a MinGW linker). Run `scripts/build-wasm.sh`
from WSL.

## Deploying a tenant (testnet)

The safe order avoids the initialization front-running window (HMY-16):
submit `deploy` and `initialize` back to back and check the owner right after.

```bash
stellar keys generate tenant-admin --network testnet --fund

ORG=$(stellar contract deploy --wasm harmony_organization.optimized.wasm --source tenant-admin --network testnet)
stellar contract invoke --id $ORG --source tenant-admin --network testnet -- \
  initialize --owner $(stellar keys address tenant-admin) --reward_asset <USDC SAC id>
stellar contract invoke --id $ORG --source tenant-admin --network testnet -- get_owner   # must be tenant-admin

# Register the tenant in the platform factory (factory admin signs)
stellar contract invoke --id $FACTORY --source platform-admin --network testnet -- register_org --org_address $ORG
```

Testnet USDC Stellar Asset Contract: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`.

## Before any mainnet deployment

1. Fix or explicitly accept every open finding in [audit/findings.md](audit/findings.md),
   at least HMY-01, HMY-10 and HMY-16.
2. Upgrade soroban-sdk (HMY-11) and use a constructor for initialization.
3. Build from a tagged commit with `scripts/build-wasm.sh`, record the
   Stellar CLI version used to optimize, and publish both hashes (reproducible
   and optimized) before deploying.
4. Keep the Owner key in a multisig or hardware wallet; the Owner can pause
   claims and sweep unclaimed funds.
5. After deploying, verify on-chain: `stellar contract fetch --id <id>` and
   compare the hash with the published one.

## Off-chain engine

```bash
cd packages/core
npm ci
npm test          # node --test, 80 tests, no network access
```
