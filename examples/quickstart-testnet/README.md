# Quickstart on the real Stellar testnet

One script, real transactions. It runs a whole Harmony program on the public
Stellar testnet: accounts, a test asset, a payout with several pockets, a
one-signature claim and a time lock enforced by the network.

```bash
# from the repository root (Node 20+; run `npm install` once in packages/kit)
node examples/quickstart-testnet/run.js                      # last-mile-delivery
node examples/quickstart-testnet/run.js software-delivery    # any template id works
```

It takes about 1 to 1.5 minutes and needs internet access to
`horizon-testnet.stellar.org` and `friendbot.stellar.org`. If a request fails
it is retried a few times; if the testnet is unreachable it says so and stops.

## What it proves

- A payout built by the kit and signed by the payer lands on the ledger:
  instant pockets as payments, the other pockets as claimable balances.
- Somebody with no trustline, and somebody with no account at all, are not left
  out: their instant pocket is held for them as a claimable balance, and their
  `unlocks` pocket also carries a payer claimant, so it cannot stay locked
  forever for somebody who never opens the account.
- The same plan cannot be paid twice: `build` finds the payout on the ledger,
  through the plan id carried as the transaction memo, and refuses
  (`PLAN_ALREADY_SUBMITTED`).
- A person with nothing set up claims with **one** transaction that adds the
  trustline and claims the balances, signed with their own key.
- A locked pocket cannot be claimed early: the network itself refuses it
  (`op_cannot_claim`), and accepts the same claim once its time has passed.
- The numbers the kit predicts match the network: the balance ids returned by
  `build`, and the XLM reserve (one base reserve per claimant, counted by the
  payer's `num_sponsoring`).

## Safety

- The tenant is hard-coded to `testnet`; there is no option to change it.
- The script plays every role (the issuer of the `TESTUSD` test asset, the
  payer and each person's wallet) and says so on screen.
- Every key is generated in memory at run time. No secret key is written to
  disk or printed; only public keys and transaction hashes appear.
- `out/` (cards and `summary.json`, public data only) is git-ignored.

## What each stage does

1. Creates and funds an issuer, a payer and people A, B, C with friendbot;
   person D gets a keypair but no account. The payer and A and B add the
   `TESTUSD` trustline; C does not. The payer receives 10000 `TESTUSD`.
2. Creates the program from the template with short time rules: every
   `unlocks` pocket after 45 s, every `expires` pocket after 7200 s.
3. Generates made-up work for four made-up people, scores it and plans the payout.
4. Builds, signs (as the payer) and submits. A and B get a payment plus their
   claimable pockets; C and D get their instant pocket as a hold.
5. Builds the same plan again. `build` reads the payer's latest transactions on
   Horizon, finds the payout by its memo and refuses with
   `PLAN_ALREADY_SUBMITTED` (the expected outcome), listing the payout hash.
6. C claims everything that is claimable now with one transaction.
7. A tries the locked pocket at once (refused by the network, the expected
   outcome), waits for the network clock to pass the unlock time and claims.
8. D: lists the money that waits for an account that does not exist yet, and
   checks on the network that D's `unlocks` pocket has a payer claimant.
9. Writes one Harmony Card per person and `out/summary.json`.

## Evidence

Run of **2026-11-24** (testnet), template `last-mile-delivery`. Public keys:
issuer `GAHQ6BGQJ56JETFPV7A5NRHZSKU7ZRAFXQYPUH6FHZTBVG5IOBTEF6RN`, payer
`GA2AYXOCUJ5P7ZQVYRHXG65EQCI3EW4RKHNIVR5K4FXWT6MW6H27LKD2`, A (Ana)
`GARFCE4UFDES5UBBVLRALLOLTV7ASOCSFW7YOJUGZUBZSW4IH4GKLIN4`, B (Luis)
`GCFYNDPTYJ4MFU7CUPWYNVI3KVIAA7OC2SJ7QOHP4PMIFX4NK5SOLGVC`, C (Sofia)
`GBGUTXNXYL645FY5PVEREX2YN524QVSP7PVM7CNLFUVRSW5D52Z72B7U`, D (Mateo, never
created) `GDD6U6IP2EZA4BSNIIO6A3NQ4SQQDVYRGCWFIWO4HS5MFD5F7BTGPPIH`.
Plan id `25e4db2c3d6c41934418441753f6e2ababcc37b986eb3de7e8545326897e1865`.

| Stage | What | Transaction |
| --- | --- | --- |
| 1 | Trustline of the payer | [e3452473...](https://stellar.expert/explorer/testnet/tx/e3452473ed1947e8d8d29d4649e1386cce091c2458aaf59390cf4dbbb7512f5b) |
| 1 | Trustline of A | [c481b3b2...](https://stellar.expert/explorer/testnet/tx/c481b3b25a689c3bf2f259a53ded8abbfdecacaf458b5ed1a3da6ff0f9bbc253) |
| 1 | Trustline of B | [9ac658ed...](https://stellar.expert/explorer/testnet/tx/9ac658ed1c9d9b6269f44dcf35bfddc01a1baa4341c47b75e20f3d4898346d28) |
| 1 | Issuer pays 10000 TESTUSD to the payer | [2f585764...](https://stellar.expert/explorer/testnet/tx/2f5857647dc6f393712e33454c5973ec31a4dba9bfad848cb6684bdceef4890b) |
| 4 | Payout: 12 operations (2 payments, 4 expires, 4 unlocks, 2 holds), 45.96 TESTUSD | [f01a7719...](https://stellar.expert/explorer/testnet/tx/f01a77192c9b9f3457fcf9e856303eb730347f8e0e61cc80f196fff8577f314b) |
| 5 | Second `build` of the same plan **refused** (`PLAN_ALREADY_SUBMITTED`, HTTP 409): it found the payout above by its memo | [f01a7719...](https://stellar.expert/explorer/testnet/tx/f01a77192c9b9f3457fcf9e856303eb730347f8e0e61cc80f196fff8577f314b) |
| 6 | C: trustline + 2 claims in one transaction (7.038 TESTUSD) | [687328bb...](https://stellar.expert/explorer/testnet/tx/687328bbc29e5a90e3478949a9395b20eda267966eaf630f9b24263e5b661bc0) |
| 7 | A: early claim of the locked pocket, **refused** (`tx_failed` / `op_cannot_claim`) | [92034b5f...](https://stellar.expert/explorer/testnet/tx/92034b5fc449cd9e85408b05181a8fe603646cd7a002658947401c6f0af4975f) |
| 7 | A: same claim after the unlock time, accepted | [cc4e9b2d...](https://stellar.expert/explorer/testnet/tx/cc4e9b2d626a8468051f12b540e53a55af5aa21afe65043cd39cf142856766e2) |
| 8 | D: nothing to submit. Three claimable balances (9.21, 1.842 and 1.228 TESTUSD) wait for an account that does not exist; the 1.842 `unlocks` balance has two claimants on the network (D and the payer, from 2026-12-24) | (listed from the payout transaction above) |

Network checks printed in stage 4: the payer sponsors 18 entries, exactly the
18 claimants the kit counted (9 XLM of reserve: C and D each have a payer
claimant on their `unlocks` pocket too); the 10 claimable balance ids predicted
by `build` all exist on the network; the network charged 0.00012 XLM in fees
against a bid of 0.0012 XLM.

Testnet is reset periodically, so these links stop resolving after a reset.
Run the script again to produce fresh evidence.
