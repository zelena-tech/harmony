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
  out: their instant pocket is held for them as a claimable balance.
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
5. C claims everything that is claimable now with one transaction.
6. A tries the locked pocket at once (refused by the network, the expected
   outcome), waits for the network clock to pass the unlock time and claims.
7. D: lists the money that waits for an account that does not exist yet.
8. Writes one Harmony Card per person and `out/summary.json`.

## Evidence

Run of **2026-11-24** (testnet), template `last-mile-delivery`. Public keys:
issuer `GAYTAFGVOBBN2QDBUQCHQ5POCJBZ2ARDWYM75SCSCMDARUXSSNI5BDNU`, payer
`GALQCL2IWJWH6W774TDRX2DXMMTGCTDMAGS7MO4YXY44GWJEHN7TE3OB`, A (Ana)
`GCD62RLBIVW56S254KXBMHCQ3Z2IKV3TSMLK62SXUISEQRQ2EBCDO2M3`, B (Luis)
`GBU723FDYUU26R4STSIXWDUZIVMJCNFX3ASI7VRYJAV3MUVD6BU6POBQ`, C (Sofia)
`GBOGD3ZV2D3LC7GB2Z5BAQBJ3ZEUGW2RZMOY44TMBHX4R4EQZ5CNOFMH`, D (Mateo, never
created) `GD467B3M2F47TCVNNM324ZBUFREN7GREEOZNGYKCUTX5O5J2AROXSYYF`.
Plan id `6028e542e687cb6106922ce785ff080a99862e041c4b51ce55c1b2aba20551f8`.

| Stage | What | Transaction |
| --- | --- | --- |
| 1 | Trustline of the payer | [98f3b7ef...](https://stellar.expert/explorer/testnet/tx/98f3b7ef745d43a1c7ea9333942f2b06edf3e59ab7c7518683c7719fc1ab422f) |
| 1 | Trustline of A | [d44105e0...](https://stellar.expert/explorer/testnet/tx/d44105e05be0ccc20954722d8f28988ee232b2b0b35e04a933153ff1bef7b90e) |
| 1 | Trustline of B | [54d5f3e9...](https://stellar.expert/explorer/testnet/tx/54d5f3e9b499c02ff4f36366c09a5cad1c6a5bcee2db0b0e493f722f19dc3337) |
| 1 | Issuer pays 10000 TESTUSD to the payer | [da460486...](https://stellar.expert/explorer/testnet/tx/da46048641bed2df676e42064a201cf16bfd31fa6d07c8c7650c41c6f44899db) |
| 4 | Payout: 12 operations (2 payments, 4 expires, 4 unlocks, 2 holds), 45.96 TESTUSD | [eb908a19...](https://stellar.expert/explorer/testnet/tx/eb908a1988330778deb8a2ebf55b23de4085523d2fb8b932c84405c090f95996) |
| 5 | C: trustline + 2 claims in one transaction (7.038 TESTUSD) | [120225e1...](https://stellar.expert/explorer/testnet/tx/120225e1cda11d11c16ffaa13b8fe690decb58dc44e6f852621c86f92bb6d682) |
| 6 | A: early claim of the locked pocket, **refused** (`tx_failed` / `op_cannot_claim`) | [37148dae...](https://stellar.expert/explorer/testnet/tx/37148daebaa022b53f23da4e6a67c92eaac7ed7841e1091c70a396a827859d83) |
| 6 | A: same claim after the unlock time, accepted | [f537bac7...](https://stellar.expert/explorer/testnet/tx/f537bac7200b962e69b47f26be4d3aac3aea1926287a3a7b5711774f20e25393) |
| 7 | D: nothing to submit. Three claimable balances (9.21, 1.842 and 1.228 TESTUSD) wait for an account that does not exist | (listed from the payout transaction above) |

Network checks printed in stage 4: the payer sponsors 16 entries, exactly the
16 claimants the kit counted (8 XLM of reserve); the 10 claimable balance ids
predicted by `build` all exist on the network; the network charged 0.00012 XLM
in fees against a bid of 0.0012 XLM.

Testnet is reset periodically, so these links stop resolving after a reset.
Run the script again to produce fresh evidence.
