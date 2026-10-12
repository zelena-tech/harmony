# Threat model and invariants

## Actors and trust

| Actor | Trust | Holds | Can |
|---|---|---|---|
| Owner (one per tenant contract) | **Trusted** | Owner key | pause, distribute, sweep unclaimed funds after 1 year, recover funds of periods without points, remove members |
| Supervisor | Semi-trusted | Supervisor key | issue points (create, review with multiplier ≤ 200 %), fund periods, add Workers |
| Worker | Untrusted | own key | complete own tasks, claim own reward |
| Funder | Untrusted | any account | deposit into a non-distributed period (needs a Supervisor as caller) |
| Factory admin (platform) | Trusted for the registry only | admin key | register organization addresses; **no** authority over organizations |
| Host system (FMS) | Trusted for inputs | no keys in the reference setup | compute activity, plan payouts, build unsigned XDR, submit signed XDR |
| Payer (tenant treasury) | Trusted | payer key in its own wallet | sign direct payments |
| External attacker | Untrusted | — | call any public function, submit any transaction |

Centralization is explicit: the Owner can freeze claims (HMY-05), withhold the
reward of a worker it deactivates (HMY-04) and sweep what is not claimed after
one year. Supervisors control point issuance (HMY-17).

## Assets

1. Reward tokens held by each Organization contract.
2. Funds of the tenant's payer wallet (direct-payment rail).
3. Integrity of points and ranking (decides who gets paid how much).
4. The wallet registry of each tenant (decides where money goes).

## Invariants (Organization contract)

| # | Invariant | Where it is enforced |
|---|---|---|
| I1 | Period state only moves `Open → Closed → Distributed` | `close_period`, `distribute_rewards` |
| I2 | Task state only moves `Assigned → Completed → Approved/Rejected` or `Assigned → Skipped` | `complete_task`, `review_task`, `skip_task` |
| I3 | After `Distributed`, `total_points` never changes and `fund_amount` only changes through `recover_undistributed` (only when `total_points == 0`) or `sweep_expired_claims` | `review_task`, `fund_period` reject Distributed periods |
| I4 | `claimed_amount ≤ fund_amount` for every period | Σ floor(fund × pᵢ / P) ≤ fund; sweep sets fund = claimed |
| I5 | A worker claims at most once per period | `WorkerStats.claimed` written before the transfer |
| I6 | Contract balance ≥ Σ over periods (fund_amount − claimed_amount) | only `claim_reward`, `recover_undistributed`, `sweep_expired_claims` transfer out, each after updating the accounting |
| I7 | Only a member with role Owner can call Owner functions; the Owner role is only granted by `initialize` and `transfer_ownership` | role checks; **broken in spirit by HMY-01** (the Owner can lose its own role) |
| I8 | A Supervisor cannot create or modify Supervisors/Owner, nor reactivate inactive members | `add_member` |
| I9 | Every state change requires the authorization of the acting address | `require_auth` on every entry point |

Re-entrancy: Soroban does not allow a contract to be re-entered during its own
invocation; the checks-effects-interactions order in the transfer paths is an
extra safeguard. The reward asset is chosen by the Owner at `initialize` and is
expected to be a Stellar Asset Contract (e.g. USDC).

## Attack surface

| Surface | Threat | Mitigation |
|---|---|---|
| `initialize` | front-running after deploy | check owner after deploy; constructor recommended (HMY-16) |
| `add_member` | role escalation by Supervisor | role matrix enforced; Owner self-demotion possible (HMY-01) |
| `review_task` | inflated points | multiplier ≤ 200 %; self-review possible (HMY-17) |
| `claim_reward` | double claim, overflow | claimed flag before transfer; u128 intermediate |
| `fund_period` | locking third-party funds | funder must authorize; caller must be Supervisor+ |
| Direct payment XDR | tampered or foreign destination | `validateSignedTransaction`: only payments of the tenant asset to registered wallets, expected payer on mainnet |
| Wallet registry (host) | wallet substitution | change log, 72 h alert, "different from last payment" alert, caps (HMY-15) |
| Payout amounts | typos, double payment | per-person and per-batch caps, anti double payment, idempotent recording by (tx_hash, wallet) |

## Out of scope

The host warehouse system, its database and API; wallet software; the Stellar
Asset Contract, Horizon and Soroban RPC; DeFi integrations that some hosts use
around the fund (e.g. lending the idle fund), which are not part of this repository.
