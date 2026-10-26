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

## How it works

```
Payer (company)                                Workers
     │  1. deploy: verifier (6 pinned VKs) ─▶ auditor registry ─▶ confidential token (wraps USDC SAC)
     │  2. register  (UltraHonk proof, binds the encryption key to the account) ◀──── each worker registers too
     │  3. deposit   PUBLIC: total USDC enters the token  (the only amount visible on-chain)
     │  4. merge     incoming balance → spendable balance
     │  5. confidential_transfer × N  (proof + Pedersen commitment + encrypted amount)
     │                                   └──▶ worker decrypts ONLY their own amount
     │                                   └──▶ auditor key decrypts every amount
     ▼  6. withdraw  (proof) → back to plain USDC whenever needed
```

What an explorer shows for step 5: a `confidential_transfer` contract call with the sender,
the recipient and an opaque payload of about 15 KB. There is no amount and no balance
change. We checked a 4 USDC transfer: the value 4 (or 40000000 in stroops) does not appear
in the stellar.expert record or anywhere in the payload.

## Verified transactions (Stellar testnet)

The audited OpenZeppelin v0.8.0 stack was deployed from the wasms in `oz-v0.8.0/` and run
with `RED=testnet MONTOS="4,3,3"`. Every hash below links to stellar.expert.

**Contracts**

| Contract | Id |
|---|---|
| Verifier (6 pinned VKs) | [`CAOMU37L…YZQMGI`](https://stellar.expert/explorer/testnet/contract/CAOMU37L7GQUO6JSO3O4RVRCTFDTIFYFHZJI77ZNTAD7TJ4LE7YZQMGI) |
| Auditor registry | [`CB5BPQ6O…YMJKWM`](https://stellar.expert/explorer/testnet/contract/CB5BPQ6OV2RCZF3LL4P5RL7ZRRYJWCU4ZKPA5TMRB4WMY6LBJUYMJKWM) |
| Confidential token (compliant, wraps the test USDC) | [`CB6GSGKB…KJ3Z2A`](https://stellar.expert/explorer/testnet/contract/CB6GSGKBSATKJQUC5JWO7J3VN5DNWXFNK7UN62ETFZDP6BUYZKKJ3Z2A) |
| Test USDC SAC (underlying) | [`CDJFJJPT…H7XVUS`](https://stellar.expert/explorer/testnet/contract/CDJFJJPTBEMO6TMK37QWB2R63WB5ZWF76Y3JKYUPL4NTJSKQZZH7XVUS) |

**Setup**

| Step | Transaction |
|---|---|
| Token deployment | [`edd9e8d68a…0003c0`](https://stellar.expert/explorer/testnet/tx/edd9e8d68a4e04d121f46aba0d260bcf8b43c99ee57c4748a994d6dc4f0003c0) |
| VK: verifier | [`c4498b0bc5…046d75`](https://stellar.expert/explorer/testnet/tx/c4498b0bc5211e828849130c71201eff65b99c12acc1dfd713ff3a0f59046d75) |
| VK: register | [`fbb0e51dc2…56a02c`](https://stellar.expert/explorer/testnet/tx/fbb0e51dc27f50d4a854156b9840e0be2e94c6364d2619ce4e6a88eeb756a02c) |
| VK: transfer | [`ff7ddbe762…180d37`](https://stellar.expert/explorer/testnet/tx/ff7ddbe7620e3f76fb9cf146dfbbecf842b0d1a6e2f658b7b651e3bb93180d37) |
| VK: withdraw | [`8c4a07b035…837253`](https://stellar.expert/explorer/testnet/tx/8c4a07b0355bd97d9fffa0aef677f4a67155a72dc2dee42864a3a0a4df837253) |
| VK: spender_transfer | [`230f3131e3…760938`](https://stellar.expert/explorer/testnet/tx/230f3131e3178f60964870c752d01952f2fb945153bf3dea196f75c671760938) |
| VK: set_spender | [`501a859f66…35351b`](https://stellar.expert/explorer/testnet/tx/501a859f6636d78c68ab53b67cc119df0c3ba1463db2d5285e6573680535351b) |
| VK: clawback | [`d6f8319a4c…7b94b2`](https://stellar.expert/explorer/testnet/tx/d6f8319a4cdbc9d7095bfe7aa125689981af0b2c3056e9906c4f54c0007b94b2) |
| Auditor key | [`45ec6ff3d2…d779f6`](https://stellar.expert/explorer/testnet/tx/45ec6ff3d2901fbfadde07f6aac2e74b7783857b54dca2603dd52472d6d779f6) |

**Run 1: 10 USDC batch, paid 4 / 3 / 3**

| Step | Transaction | Amount visible on-chain? |
|---|---|---|
| Register: payer | [`52fe583657…6ed95c`](https://stellar.expert/explorer/testnet/tx/52fe5836579a091e6da3636035df97663e23b3ae92d612f1199a233e826ed95c) | — |
| Register: worker 01 | [`36661c58d0…7f72ca`](https://stellar.expert/explorer/testnet/tx/36661c58d06de5347d3010a2745b6f82ca6a09b13fb36c034c374b5b707f72ca) | — |
| Register: worker 02 | [`f0aceef6b5…06abe7`](https://stellar.expert/explorer/testnet/tx/f0aceef6b54962e906966231467b8111d654ea83d5b400c2df4dd5925c06abe7) | — |
| Register: worker 03 | [`88dac55ff5…dc2350`](https://stellar.expert/explorer/testnet/tx/88dac55ff5efed53704e3fabb52629336285825442481b2fd5c17869cadc2350) | — |
| Deposit: batch | [`c2f0653c69…de4d06`](https://stellar.expert/explorer/testnet/tx/c2f0653c69240ae0f6ffffda2741f6485a0a1a4c490048f32bdce23eb6de4d06) | Yes, 10 (public by design) |
| Merge | [`ffbe1e575c…955764`](https://stellar.expert/explorer/testnet/tx/ffbe1e575ced86ef89807140d69fc76e70cb7d14a96c9d7c541d5dde70955764) | No |
| Confidential transfer: worker 01 (4) | [`bb458160a4…a34ed5`](https://stellar.expert/explorer/testnet/tx/bb458160a4e8ac10d15e23e3333754c49c0d3a45170d38d279359ffe18a34ed5) | **No** |
| Confidential transfer: worker 02 (3) | [`9e85ef7202…8adbef`](https://stellar.expert/explorer/testnet/tx/9e85ef720201544b007c11ffb44b8d3a82a607507be528439f521e61478adbef) | **No** |
| Confidential transfer: worker 03 (3) | [`38d111b2d6…b5af95`](https://stellar.expert/explorer/testnet/tx/38d111b2d6251bb7061b1e6f79441e9a6cff5ee4b5e65aedbab93b681bb5af95) | **No** |

Checks: each worker decrypts only their own amount, the next worker cannot open it, and the
auditor reads 4 / 3 / 3. Fees: 7.66 XLM for the whole first run (24 transactions, mostly the
wasm uploads and VK registration).

**Run 2: withdraw back to plain USDC (worker 01)**

| Step | Transaction |
|---|---|
| Trustline | [`e7a44459bf…3265f9`](https://stellar.expert/explorer/testnet/tx/e7a44459bf840a83297d4cf98359471ff7097501e1930cbc08c1c81c103265f9) |
| Merge | [`2f8ea98153…14e86f`](https://stellar.expert/explorer/testnet/tx/2f8ea9815375cc387265eb68ae01bb66f01a183dc1fae574a54523c63f14e86f) |
| Withdraw (with proof) | [`47bb48163e…129584`](https://stellar.expert/explorer/testnet/tx/47bb48163e5904bd24b100ca1a71cbc0721c0be41b0bfd44639944a13d129584) |

Worker 01 ended with 4.00 public USDC. Cost: 0.011 XLM.

**Run 3: reuse the deployed stack, paid 1 / 1 / 1**

| Step | Transaction |
|---|---|
| Deposit | [`aa801a0a7a…4f5a73`](https://stellar.expert/explorer/testnet/tx/aa801a0a7a81b4a7f13bc7cea6421fac7bf993508a00e00ca48c8476604f5a73) |
| Merge | [`726d2ec7a0…13d169`](https://stellar.expert/explorer/testnet/tx/726d2ec7a0e3181a716f92a044bfb5092821fb4a4590a4e966c07e33e913d169) |
| Transfer: worker 01 | [`606bacff07…4c3200`](https://stellar.expert/explorer/testnet/tx/606bacff07c05e7b31123bca439b9d354f0f9191c6160c0687f860dcfa4c3200) |
| Transfer: worker 02 | [`157ea5ed52…c6baf4`](https://stellar.expert/explorer/testnet/tx/157ea5ed52cb67de4f28547bee27acdcdbb66e3e8d54dbdee976858becc6baf4) |
| Transfer: worker 03 | [`11d9ce380c…119f2d`](https://stellar.expert/explorer/testnet/tx/11d9ce380ca69d8b3f985eb9e0a1b61a88a8dc6c2aa6fb6e94a03bf352119f2d) |

Cost: 0.033 XLM. Later batches on an existing stack cost about 0.03–0.1 XLM.

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
