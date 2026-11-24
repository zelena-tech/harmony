# Use cases

Each section says who pays, where the signals come from, shows a program that
is valid for `defineProgram` (field reference in [kit.md](kit.md)), explains
the pockets, what ends up on the public ledger, and what Harmony does not do.

Two limits apply to every case:

- **Pockets control when money becomes available and whether it returns to
  the payer. They do not control where it is spent after it is claimed.**
  Restricting merchants would need a card or anchor partner.
- Harmony **does not decide** what work is valid. It scores the events your
  system gives it. If the events are wrong, the payment is wrong. Keep the
  source records and the plan you approved.

Every person who is paid needs a Stellar address. The kit and the connectors
are new in 0.2.0, tested offline and on testnet, and **not audited**.

## 1. Logistics

### Warehouse bonuses (the origin)

- **Who pays:** the warehouse operator, or the brand that hires it.
- **Signals:** orders picked and packed, inventory lines counted, picking
  errors from the warehouse management system. Harmony was born inside one;
  its direct-payment rail is used on mainnet from there (`packages/core`).
- **Program:** template `warehouse-fulfillment`: `topN` (5 people, base 5, pool
  150), quality weight 0.3, four levels, 80% instant and 20% `unlocks` in 30
  days.
- **Pockets:** the `unlocks` pocket is a savings habit the payer cannot undo.
- **On the ledger:** one memo (the plan id) per transaction, the payments and
  claimable balances, and the claims. Not the scores or the orders.
- **What Harmony does not do here:** it does not read your WMS. You export the
  events. Inventory accuracy, shift planning and labor law stay with you.

### Last-mile couriers paid per delivery

- **Who pays:** a delivery company, a marketplace or a merchant.
- **Signals:** delivery completed, on time, five-star rating, failed delivery
  (from the delivery app or the order system).
- **Program:** template `last-mile-delivery`: `rate` model (0.02 per point,
  budget 500), 75% instant, 10% `expires` in 14 days (a streak bonus), 15%
  `unlocks` in 60 days (a rainy-day fund). A courier with no account yet is
  held, not skipped.
- **Pockets:** `expires` rewards people who come back and claim within two
  weeks; what is not claimed returns to the payer.
- **On the ledger:** payments and claimable balances per courier.
- **What Harmony does not do here:** it does not route, dispatch or verify a
  delivery. It does not decide whether couriers are employees or contractors.

### Carriers and owner-operators paid on proof of delivery

- **Who pays:** a shipper or broker.
- **Signals:** a confirmed proof of delivery, delivered inside the window,
  damage reported.
- **Program:**

```js
const carrierPay = defineProgram({
  id: 'carrier-pod',
  name: 'Carrier pay on proof of delivery',
  industry: 'Logistics',
  metrics: [
    { id: 'delivery_confirmed', label: 'Delivery with proof', points: 10 },
    { id: 'inside_window', label: 'Inside the delivery window', points: 2 },
    { id: 'damage_reported', label: 'Damage reported', points: -20 },
  ],
  payout: { model: 'rate', rate: 1.5, budget: 6000 },
  pockets: [
    { id: 'now', label: 'On proof of delivery', share: 0.9, rule: { type: 'instant' } },
    { id: 'claims-window', label: 'Held for the claims window', share: 0.1, rule: { type: 'unlocks', afterDays: 30 } },
  ],
  unreachable: { mode: 'hold', reclaimAfterDays: 60 },
});
```

- **Pockets:** the held 10% is released on a date. Because `unlocks` can never
  be taken back by the payer, it is a promise, not a deposit you can cut if a
  damage claim arrives later.
- **On the ledger:** each payment, tied to the plan id.
- **What Harmony does not do here:** it does not verify the proof of delivery,
  hold cargo insurance or settle disputes.

### A 3PL running campaigns funded by its brands

- **Who pays:** each brand, from its own wallet.
- **How:** one tenant per brand (or per campaign), each with its own payer
  wallet, caps and reward asset. A tenant is just configuration.

```js
const brandA = createProgram({
  tenant: { id: 'brand-a', network: 'testnet', payouts: { caps: { perPerson: 80, perBatch: 800 } } },
  program: 'warehouse-fulfillment',
  overrides: { payout: { model: 'topN', pool: 400, topN: 8, base: 0 } },
});
const brandB = createProgram({
  tenant: { id: 'brand-b', network: 'testnet', payouts: { caps: { perPerson: 40, perBatch: 300 } } },
  program: 'warehouse-fulfillment',
});
```

- **Pockets:** as in the warehouse case. Each brand sees only its own plans.
- **On the ledger:** each brand's payments come from its own payer account.
- **What Harmony does not do here:** it does not invoice the brands or
  allocate shared labor between them. The 3PL must send each tenant only its
  own events. Isolation between tenants is by configuration, not by code.

## 2. Variable pay next to payroll

- **Who pays:** an employer, for bonuses, commissions and per-shift incentives.
- **Signals:** sales and returns from the sales system, shifts from the
  rostering tool.
- **Program:**

```js
const commissions = defineProgram({
  id: 'sales-commission',
  name: 'Quarterly sales commission',
  industry: 'Retail',
  metrics: [
    { id: 'sale', label: 'Sale', points: 5 },
    { id: 'new_customer', label: 'New customer', points: 12 },
    { id: 'return', label: 'Return', points: -6 },
  ],
  minPoints: 50,
  payout: { model: 'proportional', pool: 2400 },
  pockets: [
    { id: 'now', label: 'Paid now', share: 0.8, rule: { type: 'instant' } },
    { id: 'quarter-end', label: 'Released at quarter end', share: 0.2, rule: { type: 'unlocks', afterDays: 90 } },
  ],
});
```

- **Pockets:** `unlocks` defers part of the commission to a date that
  everybody can verify.
- **On the ledger:** amounts and addresses are public unless you use a
  privacy option (see [adoption-levels.md](adoption-levels.md)). Think about
  whether that is acceptable for pay data before using a public network.
- **What Harmony does not do here:** **Harmony is not a payroll system.** It
  does not calculate salaries, taxes or social security. Whether a payment
  counts as salary is a legal question for the employer's accountant in each
  country. It produces an auditable record (the plan, the standings and the
  transaction hashes) that payroll can import.

## 3. Supplier and contractor payments

- **Who pays:** a company that pays suppliers or contractors for work it has
  accepted.
- **Signals:** units delivered and accepted, units rejected, from the
  receiving system.
- **Program:**

```js
const supplierPay = defineProgram({
  id: 'supplier-accepted-work',
  name: 'Supplier pay on accepted work',
  industry: 'Procurement',
  metrics: [
    { id: 'unit_accepted', label: 'Unit delivered and accepted', points: 1 },
    { id: 'unit_rejected', label: 'Unit rejected', points: -2 },
  ],
  payout: { model: 'rate', rate: 4, budget: 12000 },
  pockets: [
    { id: 'now', label: 'On acceptance', share: 0.9, rule: { type: 'instant' } },
    { id: 'retention', label: 'Retention', share: 0.1, rule: { type: 'unlocks', afterDays: 60 } },
  ],
});
```

- **Pockets:** the retention pocket is released at a date. Pockets are **time
  rules**. A release that depends on someone approving a delivery needs an
  escrow: the Organization contract in this repository (testnet pilot, see
  [audit/README.md](audit/README.md)) or an escrow service such as Trustless
  Work. That is roadmap, not shipped in the kit.
- **On the ledger:** a payment per supplier and a visible, dated retention.
- **What Harmony does not do here:** it does not match purchase orders to
  invoices, judge quality, resolve disputes or withhold taxes at source. The
  payer cannot cancel a retention once it is created.

## 4. Accounts receivable

### (a) Incentives for the collections team

- **Who pays:** the company, from a pool tied to what is collected.
- **Signals:** amounts collected and invoice age from the receivables ledger.
  Events are numbers, so choose a unit: here one unit is 100 of your currency.
- **Program:**

```js
const collections = defineProgram({
  id: 'collections-team',
  name: 'Collections team incentive',
  industry: 'Finance',
  unit: 'hundreds collected',
  metrics: [
    { id: 'collected', label: 'Collected, per 100', points: 1 },
    { id: 'collected_over_60d', label: 'Collected on invoices over 60 days, per 100', points: 2 },
    { id: 'broken_promise', label: 'Promise to pay broken', points: -3 },
  ],
  minPoints: 100,
  payout: { model: 'proportional', pool: 1500 },
  pockets: [
    { id: 'now', label: 'Paid now', share: 0.7, rule: { type: 'instant' } },
    { id: 'quarter', label: 'Quarterly release', share: 0.3, rule: { type: 'unlocks', afterDays: 90 } },
  ],
});
```

- **Pockets:** the deferred part keeps the team interested in invoices that
  stay paid.
- **On the ledger:** the bonus payments only, not the invoices or the debtors.

### (b) Early-payment rewards for customers

- **Who pays:** the company, to customers who pay early.
- **Signals:** invoices paid before the due date, with the amount.
- **Program:** the participants are customers. The single pocket expires, so
  the reward must be claimed before a date or it goes back to the payer.

```js
const earlyPay = defineProgram({
  id: 'early-payment',
  name: 'Early-payment reward',
  industry: 'Finance',
  metrics: [
    { id: 'paid_early_per_100', label: 'Paid early, per 100', points: 1 },
    { id: 'paid_on_time', label: 'Paid on time', points: 5 },
  ],
  payout: { model: 'rate', rate: 0.05, budget: 500 },
  pockets: [
    { id: 'reward', label: 'Reward to claim', share: 1, rule: { type: 'expires', afterDays: 30 } },
  ],
});
```

- **Pockets:** `expires` turns a discount into a visible offer with a
  deadline. The customer needs a Stellar address and claims with one
  signature.
- **What Harmony does not do here (both):** it does not collect debts, move or
  record invoices, apply interest or do credit scoring. The reward is not a
  credit against the invoice.

## 5. Software integrators and agencies

- **Who pays:** a company paying contributors or contractors, an agency, or a
  client paying an integrator per milestone.
- **Signals:** merged pull requests, reviews, commits and closed milestones
  from GitHub; closed items (with effort) and bugs from Azure Boards, through
  `packages/connectors`.
- **Program:** template `software-delivery`: `proportional` (pool 1000), 70%
  instant and 30% `unlocks` in 30 days ("released on acceptance").

```js
const { githubEvents, creditMilestone, azureBoardsEvents, mergeEvents } = require('./packages/connectors/src');
const { createProgram } = require('./packages/kit/src');

const gh = await githubEvents({ owner: 'acme', repo: 'widgets', since: '2026-03-01', until: '2026-04-01', token: process.env.GITHUB_TOKEN });
const az = await azureBoardsEvents({ organization: 'acme', project: 'Widgets', since: '2026-03-01', until: '2026-04-01', token: myPat, auth: 'pat', participantKey: 'id' });
const { events } = mergeEvents(gh, az, { identities: { 'ana-dev': 'ana', 'ana@example.com': 'ana' } });
const milestones = creditMilestone(gh.milestones, ['ana', 'ben']);   // the host decides who earns a milestone

const harmony = createProgram({ tenant: { id: 'acme-dev', network: 'testnet' }, program: 'software-delivery' });
const { standings } = harmony.score({ events: [...events, ...milestones] });
```

A runnable GitHub-only example is `examples/software-team/github-to-plan.js`.
A client who pays per milestone funds a tenant of their own and the
integrator's team is the participants.

- **Pockets:** the `unlocks` pocket is released a fixed time after the
  period. It does not wait for the client to approve. For approval, see the
  escrow note in section 3.
- **On the ledger:** payments to contributors' addresses and the plan id.
  Pull request titles and logins never go on-chain.
- **What Harmony does not do here:** it does not judge quality (a merged PR is
  not necessarily a good one), prevent gaming of counts, or map identities for
  you. `mergeEvents` only applies the map you give it. Azure Boards ids can be
  emails: read the privacy section of the connectors README.

## The 11 templates

All templates are in `packages/kit/templates/`. Each file has `meta` (who pays,
signals, an idea) and `program`.

| Template | Industry | Payout model | Pockets | Levels |
|---|---|---|---|---|
| `warehouse-fulfillment` | Logistics | topN 5, pool 150 | 80% instant, 20% unlocks 30d | 4 |
| `last-mile-delivery` | Delivery | rate 0.02, budget 500 | 75% instant, 10% expires 14d, 15% unlocks 60d | 4 |
| `retail-sales` | Retail | topN 10, pool 400 | 90% instant, 10% unlocks 90d | 4 |
| `customer-support` | Services | proportional, pool 300 | 85% instant, 15% expires 45d | 4 |
| `construction-crew` | Construction | proportional, pool 600 | 60% instant, 40% unlocks 90d | 4 |
| `healthcare-shifts` | Health | proportional, pool 500 | 80% instant, 20% expires 60d | 4 |
| `learn-to-earn` | Education | rate 0.1, budget 1000 | 50% instant, 50% unlocks 90d | 4 |
| `tip-pool` | Hospitality | proportional, pool 200 | 100% instant | single level |
| `open-source-bounties` | Technology | proportional, pool 1000 | 100% instant | 4 |
| `harvest-piece-rate` | Agriculture | rate 0.03, budget 2000 | 85% instant, 15% unlocks 45d | 3 |
| `software-delivery` | Technology | proportional, pool 1000 | 70% instant, 30% unlocks 30d | 4 |

The pools, rates and shares in templates are examples. Change them with
`overrides` or copy the template with `template(id)`.
