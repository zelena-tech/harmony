# Self-review findings

Internal review done before requesting an external audit. Every contract
finding has a test named `finding_hmy<NN>_*` that pins the **current**
behavior, so a fix shows up as a deliberate change to that test.

Severity: **High** (funds can be stolen or locked by an unprivileged actor),
**Medium** (funds locked or control lost through a plausible privileged
mistake), **Low** (incorrect behavior with limited impact or requiring a
privileged actor), **Informational** (design choice, trust assumption or
hygiene).

| ID | Severity | Component | Title | Status |
|---|---|---|---|---|
| HMY-01 | Medium | organization | The Owner can demote itself and lose control of the contract for good | Open |
| HMY-16 | Low | organization, factory | Initialization can be front-run between deploy and `initialize` | Open |
| HMY-02 | Low | organization | `final_points` is narrowed with `as u32` and truncates silently | Open |
| HMY-03 | Low | organization | A deactivated member can still complete a task assigned before | Open |
| HMY-04 | Low | organization | Deactivating a worker after distribution blocks its claim | Open |
| HMY-06 | Low | organization | Tasks not reviewed before distribution are lost | Open |
| HMY-08 | Low | organization | `fund_period` requires auth twice when caller == funder | Open |
| HMY-10 | Low | organization, factory | TTL is extended only when entries are created | Open |
| HMY-17 | Low | organization | A Supervisor can review (and multiply) its own task | Open |
| HMY-05 | Informational | organization | `pause` also freezes claims | Acknowledged |
| HMY-07 | Informational | organization | Period start/end times are not enforced | Acknowledged |
| HMY-09 | Informational | factory | The factory registers any address, duplicates included | Acknowledged |
| HMY-11 | Informational | contracts | soroban-sdk 21.7.7 is several major versions behind | Open |
| HMY-18 | Informational | organization | Tokens sent directly to the contract cannot be recovered | Acknowledged |
| HMY-12 | Informational | packages/core | Signatures are not verified locally before submitting | Acknowledged |
| HMY-13 | Informational | integration | The testnet pilot recorded tasks with the organization as worker | Acknowledged |
| HMY-14 | Informational | packages/core | Period amounts are rounded independently | Acknowledged |
| HMY-15 | Informational | packages/core | The payment allowlist is the host's wallet registry | Acknowledged |

Not a finding but worth stating: in the source repository the test module of
the organization contract **did not compile** (missing `testutils::Ledger`
import) and 6 tests called `fund_period` with caller == funder under
`mock_all_auths`, which fails (see HMY-08). Both were fixed in test code only;
the release wasm is byte-identical before and after (see
[deployments.md](deployments.md)).

---

## HMY-01 — The Owner can demote itself and lose control of the contract for good

**Severity:** Medium · **Location:** `contracts/organization/src/lib.rs:300` (`add_member`)
· **Test:** `finding_hmy01_owner_can_demote_itself`

`add_member` forbids assigning the `Owner` role but does not forbid changing
the role of the current Owner. `add_member(owner, owner, Supervisor)` (or
`Worker`) succeeds: `Member(owner).role` becomes Supervisor while
`DataKey::Owner` still points to the same address. Every Owner-only function
checks the **member role**, so `pause`, `unpause`, `remove_member`,
`distribute_rewards`, `recover_undistributed`, `sweep_expired_claims` and
`transfer_ownership` fail from then on, and no function can restore the role.

**Impact:** funds deposited in periods that are not yet distributed can never
be distributed or recovered; the contract can no longer be paused. Requires a
mistake by the Owner, but it is irreversible.

**Recommendation:** in `add_member`, reject any change to an existing member
whose role is `Owner` (or `member == get_owner()`).

## HMY-16 — Initialization can be front-run between deploy and `initialize`

**Severity:** Low · **Location:** `organization/src/lib.rs:209`, `factory/src/lib.rs:55`
· **Tests:** `finding_hmy16_initialize_can_be_front_run` (both crates)

`initialize` only calls `require_auth` on the address passed as `owner`/`admin`,
so the first caller after the deploy chooses the Owner and the reward asset.
soroban-sdk 21 has no constructors and the documented flow deploys and
initializes in two transactions.

**Impact:** griefing: the legitimate deployer's `initialize` fails and it must
redeploy. If the deployer does not notice, members and funds would be under
the attacker's contract; the deployer could not fund it without being a member.

**Recommendation:** use a constructor (`__constructor`, soroban-sdk ≥ 22), or
deploy and initialize atomically from a deployer contract; always check
`get_owner()` after deploying.

## HMY-02 — `final_points` is narrowed with `as u32` and truncates silently

**Severity:** Low · **Location:** `organization/src/lib.rs:679` · **Test:** `finding_hmy02_final_points_truncate_above_u32_max`

`final_pts` is computed in `u64` with checked operations and then cast with
`as u32`, which truncates. With `base_points = 3 000 000 000` and a 200 %
multiplier, the task records 1 705 032 704 points instead of 6 000 000 000.
`overflow-checks = true` does not cover casts.

**Impact:** wrong points for templates with very large `base_points`
(Supervisor-controlled input).

**Recommendation:** `u32::try_from(final_pts)` and fail with
`ArithmeticOverflow`, and/or bound `base_points` in `create_template`.

## HMY-03 — A deactivated member can still complete a task assigned before

**Severity:** Low · **Location:** `organization/src/lib.rs:585` · **Test:** `finding_hmy03_inactive_worker_can_complete_assigned_task`

`complete_task` checks that the caller is the task's worker but not that the
member is still active.

**Impact:** a person removed by the Owner can keep completing pending tasks;
a Supervisor can still approve them, adding points to the period total
(the removed worker cannot claim, see HMY-04, so its share ends as dust).

**Recommendation:** require an active member in `complete_task`, or skip
open tasks in `remove_member`.

## HMY-04 — Deactivating a worker after distribution blocks its claim

**Severity:** Low (centralization) · **Location:** `organization/src/lib.rs:824` · **Test:** `finding_hmy04_deactivated_worker_cannot_claim`

`claim_reward` requires an active member. A worker who earned points and is
removed after `distribute_rewards` can no longer claim; its share stays in the
contract and the Owner can sweep it one year later.

**Impact:** the Owner can withhold earned rewards of a specific worker.

**Recommendation:** let anybody with `WorkerStats.total_points > 0` in a
distributed period claim regardless of `active`, or snapshot eligibility at
distribution. Document the policy for workers who leave the company.

## HMY-05 — `pause` also freezes claims

**Severity:** Informational (centralization) · **Test:** `finding_hmy05_pause_blocks_claims`

`claim_reward` calls `check_not_paused`, so the Owner can freeze payouts of
periods that were already distributed. This is the intended emergency stop;
workers should know it exists.

## HMY-06 — Tasks not reviewed before distribution are lost

**Severity:** Low · **Location:** `organization/src/lib.rs:782` · **Test:** `finding_hmy06_unreviewed_task_is_lost_after_distribution`

`distribute_rewards` does not check for tasks still in `Completed`. Once the
period is `Distributed`, `review_task` is rejected (correctly, to keep shares
stable), so those tasks can never add points.

**Recommendation:** count pending reviews per period and require zero before
distributing, or let the Owner reject them in bulk; at least expose the count.

## HMY-08 — `fund_period` requires auth twice when caller == funder

**Severity:** Low · **Location:** `organization/src/lib.rs:751-752` · **Test:** `finding_hmy08_same_caller_and_funder_double_auth`

`caller.require_auth()` and `funder.require_auth()` are both called. When both
are the same address, a second authorization in the same frame fails with
`Error(Auth, ExistingValue)` unless the address authorizes as the
**transaction source account**. We verified on testnet that the common case
(source account = caller = funder) succeeds
([tx 166f27bf…](https://stellar.expert/explorer/testnet/tx/166f27bff31998832ff76c550cbea72b1b6cac7002ee8ee04404a877a817a742)),
while unit tests with `mock_all_auths` and address-credential flows
(relayers, smart wallets, multisig signing auth entries) fail.

**Recommendation:** `if funder != caller { funder.require_auth(); }`.

## HMY-10 — TTL is extended only when entries are created

**Severity:** Low (operational) · **Location:** `organization/src/lib.rs:39-40, 401, 470, 563`; `factory/src/lib.rs:90`

Persistent entries (`Period`, `Task`, `Template`, `WorkerStats`, `Org`) get a
365-day TTL when created and are never extended on later writes or reads
(`Member` is extended on every `set_member`). The instance gets 30 days and is
extended only by some writes. The claim window is 365 days **from
distribution**, so a period opened months before distribution can be archived
before its claim window ends.

**Impact:** no loss (archived persistent entries can be restored), but claims
fail until someone submits a `RestoreFootprint` operation; an idle contract
needs its instance restored after 30 days.

**Recommendation:** extend the TTL of every entry touched by a write
(`Period`, `Task`, `WorkerStats`) and in `claim_reward`; document the restore
procedure.

## HMY-17 — A Supervisor can review (and multiply) its own task

**Severity:** Low (trust assumption) · **Location:** `organization/src/lib.rs:512, 636` · **Test:** `finding_hmy17_supervisor_can_review_its_own_task`

`create_task` accepts any active member as worker, including Supervisors and
the Owner, and `review_task` does not check `caller != task.worker`. A
Supervisor can therefore assign itself a task, complete it and approve it at
200 %, taking a share of the fund.

**Recommendation:** reject `caller == task.worker` in `review_task`, and
optionally restrict task workers to the `Worker` role. Monitor
`task_reviewed` events off-chain.

## HMY-07 — Period start/end times are not enforced

**Severity:** Informational · **Test:** `finding_hmy07_period_time_bounds_not_enforced`

`start_time`/`end_time` are only validated as `end > start`; tasks can be
created and completed while the period is `Open` regardless of the ledger time.
Closing a period is a manual Supervisor action.

## HMY-09 — The factory registers any address, duplicates included

**Severity:** Informational · **Location:** `factory/src/lib.rs:77` · **Test:** `finding_hmy09_register_org_accepts_duplicates`

`register_org` is admin-only but does not check that the address is an
initialized organization contract with the expected wasm, and the same address
can be registered several times. There is no deregistration. Consumers of the
registry must verify the wasm hash of each entry.

## HMY-11 — soroban-sdk 21.7.7 is several major versions behind

**Severity:** Informational

The contracts use soroban-sdk 21.7.7 and deprecated test helpers
(`register_contract`, `register_stellar_asset_contract`). Upgrading also
enables constructors (HMY-16). Recommended before any mainnet deployment.

## HMY-18 — Tokens sent directly to the contract cannot be recovered

**Severity:** Informational

Only `fund_period` updates the accounting (`fund_amount`). Tokens transferred
to the contract address by any other means are never assigned to a period and
there is no function to withdraw them.

## HMY-12 — Signatures are not verified locally before submitting

**Severity:** Informational · **Location:** `packages/core/src/payouts/transactions.js` (`validateSignedTransaction`)
· **Test:** `submit: signatures are NOT verified locally (the network does it)`

The validator checks operations, destinations, asset and source, and that at
least one signature exists, but does not verify signatures against the
network passphrase. A transaction signed for another network passes local
validation and is rejected by the network (`tx_bad_auth`). No funds at risk;
the error message is just less precise.

## HMY-13 — The testnet pilot recorded tasks with the organization as worker

**Severity:** Informational (integration) · **See:** [architecture.md](../architecture.md#pilot-integration-notes)

`complete_task` needs the worker's signature. In the pilot, the host created,
completed and approved each task with the organization's own address as the
worker, so on-chain `WorkerStats` of the pilot do not attribute work per person.
Production bonuses used the direct-payment rail, where shares come from
`computePeriod`. A per-worker on-chain flow needs either worker-signed
completion (e.g. from a mobile wallet) or a contract change where the
Supervisor attests completion.

## HMY-14 — Period amounts are rounded independently

**Severity:** Informational · **Location:** `packages/core/src/period.js`

`assignedAmount` is rounded to 7 decimals per worker, so the sum can differ
from `fundTotal` by a few stroops. The payout planner, which is what actually
pays, corrects the residue so the plan never exceeds the pool (tested).

## HMY-15 — The payment allowlist is the host's wallet registry

**Severity:** Informational (trust assumption)

`submitSignedTransactions` only pays registered wallets, but the registry is
maintained by the host. Someone able to change a worker's wallet in the host
could redirect that worker's payment. Mitigations in the reference host:
every change is logged, wallets changed in the last 72 h are flagged in the
plan, payments to a wallet different from the previous payment are flagged,
caps per person and per batch, and on mainnet only the registered payer can sign.
