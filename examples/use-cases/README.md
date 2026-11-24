# Use cases from a CSV

Most companies cannot give API access on day one, but every one of them can
export a spreadsheet. These three cases go from "here is an export" to "here is
your team's ranking and what a payout would look like" in one command, with no
network, no wallet and no keys.

```bash
node examples/use-cases/run.js carriers
node examples/use-cases/run.js suppliers
node examples/use-cases/run.js collections
node examples/use-cases/run.js carriers --out some/folder     # default: examples/out/use-cases/<case>/
node examples/use-cases/run.js carriers --now 2026-12-05      # pocket dates are counted from here
```

Each run prints what it read, the standings and a payout preview, and writes
`report.json`, `report.md` and one preview Harmony Card (SVG) per person who
would be paid. **It stops at the plan: nothing is built, signed or sent.** The
wallets marked `"generate"` in a `case.json` are random keys made for the run
(only the public key is used, the secret is discarded), so the plan id changes
on every run; everything else is the same each time. Pocket dates are counted
from the end of the period unless you pass `--now`.

All data is invented: first names or obviously fictional company names, made-up
amounts, no real people or customers.

## The three cases

| Case | Who pays | The CSV | Template |
| --- | --- | --- | --- |
| `carriers` | A shipper that pays independent carriers | A month of deliveries: order, carrier, date, status, proof-of-delivery reference, days late, damage | [`carrier-proof-of-delivery`](../../packages/kit/templates/carrier-proof-of-delivery.json) |
| `suppliers` | A manufacturer that pays its suppliers | Goods-receipt export in a Spanish-locale format (`;` delimiter, decimal comma, `DD/MM/YYYY`): units received, accepted and rejected, on time or not | [`supplier-deliveries`](../../packages/kit/templates/supplier-deliveries.json) |
| `collections` | A company with an accounts-receivable team | A ledger export: payments (with the invoice age and a quoted amount such as `"1,250,000.00"`), promises kept and broken | [`collections-team`](../../packages/kit/templates/collections-team.json) |

- **carriers** pays per delivery confirmed with proof of delivery, with a bonus
  for arriving on time and for no damage, and takes points away for a rejected
  delivery. A delivery with no proof reference earns nothing. 90% is available
  at once and 10% is a damage-claims reserve released 15 days later, on that
  date, not on a claims decision. The budget is a ceiling on the whole payout.
- **suppliers** pays for the units accepted and for being on time, takes points
  away for rejected units, and keeps a 10% retention that unlocks 30 days
  later. The case overrides the template's payout to show how: the points are
  worth more than the budget, so every share is scaled down to it. The
  retention is released by date; releasing it on approval needs an escrow.
- **collections** shares a pool by points, with more points per unit the older
  the invoice was (one unit is 1,000 of the currency of the export), plus points
  for promises kept. A small share unlocks at the end of the quarter.

What the output means: **standings** show the units each person was credited
with, per metric (and say when a cap cut them), the level multiplier and the
adjusted points; the **payout preview** shows each person's total and how it is
split into pockets with their dates; **withheld** is the share of somebody who
has no wallet yet (it is kept aside, never given to anybody else); **skipped
rows** are the rows of the CSV that could not be used, with their line number
and the reason. In every case some rows are messy on purpose (a missing name, a
date that does not exist, a date in the wrong format, a row outside the period,
a row with too many columns) so you can see them reported.

## What a case folder holds

```
examples/use-cases/<case>/
  data.csv     the export
  case.json    organization, period, mapping, template, overrides?, people?, lifetime?
```

`run.js` is generic and reads only these two files. In `case.json`:

| Key | Meaning |
| --- | --- |
| `organization` | Slug used as the tenant id of the run |
| `period` | `{ label, since, until }`; rows from `since` up to, not including, `until` count |
| `mapping` | How the columns become events: see the CSV section of [`packages/connectors/README.md`](../../packages/connectors/README.md#csv). `since` and `until` come from `period` |
| `template` | Id of a kit template |
| `overrides` | Optional program fields that replace the template's (validated like any program) |
| `people` | Optional `{ "<participant id>": { name?, wallet } }`. `wallet` is `"generate"`, `null` (nobody to pay yet) or a public key; anybody not listed has no wallet |
| `lifetime` | Optional lifetime points before the period, which decide each person's level |

## Adapting a case to a real export, in five steps

1. **Export.** Ask for the raw rows (one row per delivery, per receipt, per
   payment), with a date, the person or company and a reference such as an order
   or invoice number. Do not pre-summarise it.
2. **Write the mapping.** Copy a case folder, put your file in as `data.csv`
   and edit `case.json`: which column is the participant, the date and the
   reference, which `delimiter`, `decimal` and `dateFormat` the export uses, and
   one rule per metric (`when` the row counts, `value` where the number comes
   from).
3. **Pick or edit the template.** Start from the closest template, or give
   `overrides` (or your own program) for the metrics, caps, rate or pool and
   pockets. The metric ids in the rules must be the ones in the program. Caps are
   in units: set them above what an honest person does in a period.
4. **Run it.** `node examples/use-cases/run.js <your-case>`.
5. **Review before you trust the ranking.** Read every line of **skipped rows**
   (fix the export or the mapping until the reasons make sense), look at the rows
   that matched no rule, and open the event list in `report.json`: each event
   carries the reference you mapped, so any amount can be traced back to its row.

## Honest limits

- A CSV is a snapshot that someone exported. If it was edited, filtered or
  incomplete, the ranking is too. Harmony cannot tell.
- The numbers are only as good as the export. A record that somebody can edit
  (a status, a date, an amount) is something somebody can inflate: the caps limit
  the damage, they do not remove it.
- Rows are not deduplicated. If the export lists an order twice it counts twice.
- A participant is whatever the cell says: `Ana` and `ana` are two people.
- Agree on the metric weights with the people being measured before anybody is
  paid. A rule people did not accept is a rule they will contest.
- These cases preview a payout. Paying it is a separate decision: see
  [adoption levels](../../docs/adoption-levels.md) and the quickstarts.
