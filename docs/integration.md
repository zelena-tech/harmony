# Integrating a host system

`packages/core` does not read any database. The host (typically a warehouse
management system) gathers the inputs, calls the engine and stores the results.

## Inputs the host provides

### Order campaigns — `activity` of `computePeriod`

One row per worker for the period `[start, end]`:

| Field | Meaning |
|---|---|
| `workerId` | the host's stable id |
| `picking` | orders whose picking the worker **completed** in the period |
| `packing` | orders whose packing the worker **completed** in the period |
| `started` | picking + packing tasks the worker **started** in the period |
| `completed` | picking + packing tasks completed (= picking + packing) |
| `activeSeconds` | sum of (end − start) of the completed tasks |

### Inventory campaigns

- `activity`: `[{ workerId, counts }]`, the counting records of the session.
  The host decides who participates; the reference policy excludes
  supervisors (people who coordinate the count) and voided records.
- `quality`: `scoreInventorySession(zones)`, where each zone is the
  cross-count result `[{ locations: [{ consensus, consensusValue, discarded, counters: [{ workerId, total, voided }] }] }]`.

### Optional components

- `evaluations` `{ [workerId]: { [criterionId]: grade } }` and `criteria` `[{ id, weight }]`.
- `attendance` `{ [workerId]: attendanceScore(...) }`, or `null` when attendance
  tracking is disabled.

### Payout planning

- `ranking`: every participant with `{ workerId, name, wallet, adjustedPoints }`,
  sorted by `adjustedPoints` descending.
- `previous`: `summarizePrevious(rows)` with the payments already made in the
  campaign.
- `walletChanges`: `Map(workerId → { hours })` for wallets changed in the last
  72 hours.

## What the host must enforce

| Concern | Reference implementation |
|---|---|
| Who can plan, build and submit payments | role-based access in the host API plus an explicit allowlist of people authorized to pay |
| Wallet registry | each person registers one Stellar address; every change is logged (who, when, old, new) and flagged for 72 h |
| Recording payments | one row per (tx_hash, wallet), inserted idempotently after submission |
| Recomputing a period | never delete the rows of a period that was already paid or distributed |
| Tenant scoping | every query filtered by tenant, or one database per tenant |
| Keys | the host never stores the payer's or workers' secret keys; signing happens in each person's wallet |

## Minimal example

```js
const { createHarmony, payouts } = require('@zelena/harmony-core');
const acme = createHarmony(await loadTenantConfig('acme-warehouse'));

const period = acme.computePeriod({
  kind: 'orders',
  activity: await db.activityForPeriod(periodId),
  evaluations: await db.evaluations(periodId),
  criteria: await db.activeCriteria(),
  attendance: null,
  fundTotal: await db.confirmedFund(periodId),
});
await db.savePeriodResult(periodId, period.workers);

const plan = acme.planCampaignPayout({
  ranking: await db.ranking(periodId),
  previous: payouts.summarizePrevious(await db.payments(periodId)),
  options: { base: 0, pool: 150, topN: 5 },
});
```
