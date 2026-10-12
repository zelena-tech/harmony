# Organization contract — reference

Source: [`contracts/organization/src/lib.rs`](../../contracts/organization/src/lib.rs)
(soroban-sdk 21.7.7). One instance per tenant. Inline comments in the source
are in Spanish; they are kept unchanged because doc comments are embedded in
the contract spec and changing them would change the deployed wasm.

## Constants

| Name | Value | Meaning |
|---|---|---|
| `DAY_IN_LEDGERS` | 17 280 | ~5 s per ledger |
| `INSTANCE_TTL` | 30 days | instance TTL set on writes |
| `MAX_TTL` | 365 days | persistent entry TTL set at creation |
| `CLAIM_EXPIRY_SECS` | 365 days | claim window after distribution |
| `BP_BASE` | 10 000 | 100 % in basis points |
| `MAX_MULTIPLIER` | 20 000 | review multiplier ceiling (200 %) |

## Storage

| Key | Storage | Value |
|---|---|---|
| `Owner`, `RewardAsset`, `Paused`, `TaskCount`, `TemplateCount`, `PeriodCount` | instance | |
| `Member(Address)` | persistent | `MemberInfo { role, active, joined_at }` |
| `Template(u32)` | persistent | `ActivityTemplate { name, base_points, active }` |
| `Task(u32)` | persistent | `TaskInfo { worker, template_id, period_id, state, base_points, final_points, evidence_url, created_at, completed_at }` |
| `Period(u32)` | persistent | `PeriodInfo { state, start_time, end_time, fund_amount, total_points, claimed_amount, distributed_at }` |
| `WorkerStats(u32 period, Address)` | persistent | `WorkerStats { tasks_assigned, tasks_completed, tasks_approved, tasks_rejected, tasks_skipped, total_points, claimed }` |

Ids start at 1 and are `count + 1` with checked addition.

## Entry points

Legend — **Auth**: addresses on which `require_auth()` is called.
**Role**: role checked through `Member(addr)` (the member must exist and be
active). **P**: `check_not_paused`.

| Function | Auth | Role | P | Preconditions | Effects | Event |
|---|---|---|---|---|---|---|
| `initialize(owner, reward_asset)` | owner | — | — | not initialized | sets Owner, RewardAsset, Paused=false, counters=0; Member(owner)=Owner | `org_init` |
| `pause(caller)` | caller | Owner | — | | Paused=true | `emergency_pause` |
| `unpause(caller)` | caller | Owner | — | | Paused=false | `emergency_unpause` |
| `transfer_ownership(current_owner, new_owner)` | both | Owner (current) | ✓ | | current → Supervisor; new → Owner; Owner key = new | `ownership_transferred` |
| `add_member(caller, member, role)` | caller | Owner or Supervisor | ✓ | role ≠ Owner; a Supervisor may only add Workers and may not modify a non-Worker or an inactive member | Member(member) = {role, active=true, joined_at kept} | `member_added` |
| `remove_member(caller, member)` | caller | Owner | ✓ | member exists; member is not Owner | active=false | `member_removed` |
| `create_template(caller, name, base_points)` | caller | Supervisor+ | ✓ | base_points > 0 | new Template | `template_created` |
| `deactivate_template(caller, template_id)` | caller | Supervisor+ | ✓ | template exists | active=false | `template_deactivated` |
| `open_period(caller, start_time, end_time)` | caller | Supervisor+ | ✓ | end > start | new Period (Open) | `period_opened` |
| `close_period(caller, period_id)` | caller | Supervisor+ | ✓ | period Open | Closed | `period_closed` |
| `create_task(caller, worker, template_id, period_id)` | caller | Supervisor+ | ✓ | period Open; template active; worker is an active member (any role) | new Task (Assigned, base_points snapshot); stats.tasks_assigned++ | `task_created` |
| `complete_task(worker, task_id, evidence_url)` | worker | — | ✓ | task.worker == worker; task Assigned; period Open | Completed; evidence; completed_at | `task_completed` |
| `review_task(caller, task_id, approved, point_multiplier_bp)` | caller | Supervisor+ | ✓ | task Completed; period ≠ Distributed | approved: final = base × min(bp, 20000) / 10000; Approved; worker and period total_points += final. Rejected otherwise | `task_reviewed` |
| `skip_task(caller, task_id)` | caller | Supervisor+ | ✓ | task Assigned | Skipped | `task_skipped` |
| `fund_period(caller, funder, period_id, amount)` | caller, funder | Supervisor+ (caller) | ✓ | amount > 0; period ≠ Distributed | token transfer funder → contract; fund_amount += amount | `period_funded` |
| `distribute_rewards(caller, period_id)` | caller | Owner | ✓ | period Closed; fund_amount > 0 | Distributed; distributed_at = max(now, 1) | `rewards_distributed` |
| `claim_reward(worker, period_id)` | worker | active member | ✓ | period Distributed; fund > 0; total_points > 0; now ≤ distributed_at + 1 year; stats exist, not claimed, points > 0; reward > 0 | claimed=true; claimed_amount += reward; **then** transfer contract → worker | `reward_claimed` |
| `recover_undistributed(caller, period_id, to)` | caller | Owner | ✓ | period Distributed; total_points == 0; fund > 0 | fund=0, claimed=0; **then** transfer contract → to | `fund_recovered` |
| `sweep_expired_claims(caller, period_id, to)` | caller | Owner | ✓ | period Distributed; now > distributed_at + 1 year; fund − claimed > 0 | fund = claimed; **then** transfer the remainder → to | `dust_swept` |

Read-only: `get_member`, `get_template`, `get_task`, `get_period`,
`get_worker_stats` (zeros when absent), `get_reward_asset`, `get_owner`,
`is_paused`.

### Reward formula

```
reward = floor(fund_amount × worker.total_points / period.total_points)    (u128 intermediate)
```

The sum of all claims is at most `fund_amount`; the rounding remainder (dust)
plus the shares of workers who never claim can be swept by the Owner one year
after distribution.

## Errors

| Code | Name | Code | Name |
|---|---|---|---|
| 1 | AlreadyInitialized | 12 | PeriodNotFound |
| 2 | NotInitialized | 13 | InvalidPeriodState |
| 3 | Unauthorized | 14 | AlreadyClaimed |
| 4 | ContractPaused | 15 | NoRewardsToClaim |
| 5 | MemberNotFound | 16 | InvalidAmount |
| 6 | MemberInactive | 17 | ArithmeticOverflow |
| 7 | CannotRemoveOwner | 18 | WorkerNotMember |
| 8 | TemplateNotFound | 19 | PeriodEndBeforeStart |
| 9 | TemplateInactive | 20 | ClaimsExpired |
| 10 | TaskNotFound | 21 | ClaimsNotExpired |
| 11 | InvalidTaskState | | |

## Security properties claimed by the source

The header of `lib.rs` lists 16 properties. Their status after the self-review:

| # | Property | Status |
|---|---|---|
| 1 | `require_auth()` on every state change | Holds |
| 2 | Re-initialization impossible | Holds. Initialization itself can be front-run between deploy and `initialize` (HMY-16) |
| 3 | Strict state machine Open → Closed → Distributed | Holds |
| 4 | Checks-effects-interactions in `claim_reward` | Holds (Soroban also forbids re-entry into the same contract) |
| 5 | Checked arithmetic | Holds, except the `as u32` narrowing in `review_task` (HMY-02) |
| 6 | Multiplier bounded to [0 %, 200 %] | Holds |
| 7 | Emergency pause | Holds; it also blocks claims (HMY-05) |
| 8 | TTL extended so data does not expire within a year | Partially: only at creation (HMY-10) |
| 9 | A worker can only complete its own tasks | Holds; inactive members still can (HMY-03) |
| 10 | Double claim impossible | Holds |
| 11 | No approvals on Distributed periods | Holds; unreviewed tasks are then lost (HMY-06) |
| 12 | A Supervisor cannot promote/demote Supervisors | Holds |
| 13 | `recover_undistributed` zeroes the fund | Holds |
| 14 | `claimed_amount` tracked per period | Holds |
| 15 | Owner sweeps dust after one year | Holds |
| 16 | A Supervisor cannot reactivate a Worker deactivated by the Owner | Holds |

The Owner can, however, demote itself and lose control of the contract (HMY-01).
