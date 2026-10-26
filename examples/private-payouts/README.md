# Private payouts with Confidential Tokens

Harmony pays performance bonuses in USDC on Stellar. A normal payment shows the amount to
anyone who opens the transaction in an explorer. This example pays each worker through an
**OpenZeppelin Confidential Token** instead, so the transaction runs on-chain but the
amount travels encrypted.

**Who sees what:**

| Who | What they see |
|---|---|
| Anyone with the transaction hash (Stellar Expert, Horizon) | That a `confidential_transfer` happened, when, and between which addresses. The amount does not appear: there is no plain value and no balance change. |
| Each worker | Only their own amount, decrypted with their own key. |
| The company (auditor key) | Every amount. |
| Public batch deposit | The batch total (the USDC wrapped into the token). |

## Status

- **Tested end to end on Stellar testnet** against a fresh deployment of the audited
  OpenZeppelin `stellar-contracts` **v0.8.0** confidential stack, compiled from source.
  The test covered:
  - registration;
  - a 10 USDC batch deposit;
  - confidential transfers of 4, 3 and 3;
  - per-worker decrypt checks (each worker reads only their own amount, others cannot);
  - auditor reads;
  - a withdraw back to plain USDC.
- **Mainnet:** `desplegar-y-pagar-mainnet.mjs` runs the same code path on mainnet. Only the
  account owner runs it, with their own key. It stops after a preflight summary unless
  `CONFIRMO_MAINNET=si`.

## Files

| File | What it does |
|---|---|
| `desplegar-y-pagar-mainnet.mjs` | Deploys the v0.8.0 stack (verifier with the pinned verification keys, auditor registry, compliant confidential token wrapping a SEP-41 SAC). It then registers the workers, deposits, makes the confidential transfers, checks the decrypts and prints explorer links. `ACCION=retirar` withdraws back to plain USDC. |
| `prover-oz-v080.mjs` | UltraHonk prover for the v0.8.0 circuits (noir_js + bb.js). It adds the `r_tilde_aud_s` public input introduced in v0.8.0. |
| `pago-privado.mjs` | An earlier demo against the SDK's reference testnet deployment, before v0.8.0. Kept for reference. |
| `oz-v0.8.0/` | Compiled circuits, the 6 pinned verification keys and the example contract wasms. Includes `manifiesto.json` with sha256 hashes, and `compilar-circuitos.cjs` to reproduce the circuits. The VKs are byte-identical to the ones pinned by OpenZeppelin. |

## Run

Start with a testnet rehearsal. Accounts are funded with friendbot.

```bash
cd examples/private-payouts && npm install && RED=testnet MONTOS="4,3,3" node desplegar-y-pagar-mainnet.mjs
```

For mainnet you need:
- a funded account with a USDC (Circle) trustline;
- at least 40 XLM, the buffer the script requires;
- about 15–18 XLM spent on the first run: contract deployment fees plus 2 XLM for each generated worker account.

Run the preflight first (sends nothing):

```bash
RED=mainnet MONTOS="1,1,1" FIRMANTE_SECRETO=S... node desplegar-y-pagar-mainnet.mjs
```

Then add `CONFIRMO_MAINNET=si` to execute.

**Environment variables:**

| Variable | What it does |
|---|---|
| `RED` | `testnet` or `mainnet`. |
| `MONTOS` | One USDC amount per worker, comma-separated. |
| `FIRMANTE_SECRETO` | The payer's secret key. Read from the environment only; never written to disk. |
| `OPERARIOS_SECRETOS` | Optional. The workers' own accounts. |
| `OPERARIO_XLM` | XLM to fund each generated worker account. |
| `RPC_URL` | RPC endpoint. |
| `ACCION=retirar QUIEN=empleador\|operario1..3` | Withdraw back to plain USDC. |

**Files the script creates:**

| File | Contents |
|---|---|
| `mainnet-contratos.json` | Public contract ids, reused on later runs. |
| `.mainnet-llaves.json` | **Secret**, gitignored. It holds the auditor key and the generated worker keys. Back it up offline: if it is lost, those balances cannot be spent. |

## Risks — read before using real funds

1. **Amounts are not cryptographically private yet.** The v0.8.0 verifier accepts
   non-zero-knowledge UltraHonk proofs, so a proof can leak information about the witness.
   - Explorers do not show the amounts.
   - A determined analyst could recover them.
   - OpenZeppelin will switch to ZK verification, which will require a redeploy or migration.
2. **One key controls the stack.** The deploying account is admin of the verifier, the auditor
   registry and the token. Whoever holds that key can change a verification key and drain the
   wrapped USDC. Move these roles to a multisig with a timelock, or renounce them, before
   scaling.
3. **Example contracts.** These are OpenZeppelin's `examples/confidential` contracts, thin
   wrappers over the audited library. The script checks the wasm, circuit and VK hashes
   against `oz-v0.8.0/manifiesto.json`.
4. **Unofficial client toolchain.** The client is the third-party `stellar-confidential-token-sdk`
   plus the v0.8.0 patch in `prover-oz-v080.mjs`, and the circuits were compiled with
   `noir_wasm`. This is mitigated because the VKs are byte-identical to OpenZeppelin's and
   the full flow passes against the real v0.8.0 verifier on testnet.

## Attribution

- The circuits, verification keys and contract wasms in `oz-v0.8.0/` are built from
  [OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts)
  v0.8.0 (MIT License, © OpenZeppelin).
- The client uses [stellar-confidential-token-sdk](https://github.com/aguilar1x/stellar-confidential-token-sdk)
  (npm `0.1.9`).
- Background:
  - [Privacy on Stellar](https://developers.stellar.org/docs/build/apps/privacy#confidential-tokens)
  - [Practical Confidential Stablecoins](https://stellar.org/blog/developers/practical-confidential-stablecoins-an-issuer-controlled-architecture)
