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
5. Builds the same plan again. `build` pages back through the payer's
   transactions on Horizon until the time of the plan, finds the payout by its
   memo and refuses with `PLAN_ALREADY_SUBMITTED` (the expected outcome),
   listing the payout hash.
6. C claims everything that is claimable now with one transaction.
7. A tries the locked pocket at once (refused by the network, the expected
   outcome), waits for the network clock to pass the unlock time and claims.
8. D: lists the money that waits for an account that does not exist yet, and
   checks on the network that D's `unlocks` pocket has a payer claimant.
9. Writes one Harmony Card per person and `out/summary.json`.

## Evidence

Run of **2026-11-24** (testnet), template `last-mile-delivery`, with the second
round of fixes of the kit (exact split between people, paged already-submitted
lookup, payer claimant never at the same second as the person). Public keys:
issuer `GBEYJDR2UJKRAN33JXIQ4ZRJ3CI3DVK5U7GKQESATS54352557CXDMSE`, payer
`GAEHBAJBOX5XLX77PZSHORGL3FVV3NZLYIEKWM42QP327475F56KDQJJ`, A (Ana)
`GBBXXE6D7NGXKZDMN767SQZNO4QAWMHVXFKUHWODUT4WJ4GFWPRYDMEN`, B (Luis)
`GDCIH3KNQWGDTM6ZKOGDIC5M3NKXHFAVOUBWYMI6GQN53CW5YG4H7F3Z`, C (Sofia)
`GCEI7YKQSZT6BJCC3UNU3CCVTKQTOMIZC34OST5J5BW5UOKE7GUWECVL`, D (Mateo, never
created) `GDWOFKLRQOVQ4AEPPSJWOO4HKNPIOAS3RE7J3WSNE5JGV62WBPTO4DQF`.
Plan id `393a4fc3b969d26cb53b4163912ab050a9716326e2a491113e7bae9e6e645459`.

| Stage | What | Transaction |
| --- | --- | --- |
| 1 | Trustline of the payer | [0c5ae51b...](https://stellar.expert/explorer/testnet/tx/0c5ae51b7808d43d10512d923898455faa8302ba08a5f308e79c0e751f37e806) |
| 1 | Trustline of A | [b767b853...](https://stellar.expert/explorer/testnet/tx/b767b85379d9d8165e82dac576caf57bb770f2b8ae6956b12635a75cc6ac421e) |
| 1 | Trustline of B | [1baa2047...](https://stellar.expert/explorer/testnet/tx/1baa204728ee3c94296ee60cf6e67988f1adeda85210299048c28f227c87a34f) |
| 1 | Issuer pays 10000 TESTUSD to the payer | [2f036eaf...](https://stellar.expert/explorer/testnet/tx/2f036eaf56454c4092488085944073a8ebd54c690f714382ca5dc4a2a0d2b4f1) |
| 4 | Payout: 12 operations (2 payments, 4 expires, 4 unlocks, 2 holds), 45.96 TESTUSD | [18a1b9f9...](https://stellar.expert/explorer/testnet/tx/18a1b9f9e2c060ad3f27c22cd5d13eef8c4ce77896702e4c3198783b819d56eb) |
| 5 | Second `build` of the same plan **refused** (`PLAN_ALREADY_SUBMITTED`, HTTP 409): it found the payout above by its memo | [18a1b9f9...](https://stellar.expert/explorer/testnet/tx/18a1b9f9e2c060ad3f27c22cd5d13eef8c4ce77896702e4c3198783b819d56eb) |
| 6 | C: trustline + 2 claims in one transaction (7.038 TESTUSD) | [2a6376c1...](https://stellar.expert/explorer/testnet/tx/2a6376c16408662ea5cf1dc572407800235243fa812b3ce2b8be32d017bddd98) |
| 7 | A: early claim of the locked pocket, **refused** (`tx_failed` / `op_cannot_claim`) | [ddcd4b49...](https://stellar.expert/explorer/testnet/tx/ddcd4b49b5f7d86d6fe34bdeb8de908be5fbaf41fe8e82362b1f53c3f0a9bda7) |
| 7 | A: same claim after the unlock time, accepted | [58f74b20...](https://stellar.expert/explorer/testnet/tx/58f74b20c7923188ae2d29c823c2ff97a8b52d9ff3567e1b04eac8a8161bfafd) |
| 8 | D: nothing to submit. Three claimable balances (9.21, 1.842 and 1.228 TESTUSD) wait for an account that does not exist; the 1.842 `unlocks` balance has two claimants on the network (D and the payer, from 2026-12-24T06:25:17Z: the unlock time plus the 30 day reclaim window) | (listed from the payout transaction above) |

Network checks printed in stage 4: the payer sponsors 18 entries, exactly the
18 claimants the kit counted (9 XLM of reserve: C and D each have a payer
claimant on their `unlocks` pocket too); the 10 claimable balance ids predicted
by `build` all exist on the network; the network charged 0.00012 XLM in fees
against a bid of 0.0012 XLM.

Testnet is reset periodically, so these links stop resolving after a reset.
Run the script again to produce fresh evidence.
