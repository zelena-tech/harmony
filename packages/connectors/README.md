# @zelena/harmony-connectors

Turns work that a system already records into plain Harmony events,
`{ participantId, metric, value }`, so a program can score it and pay it out.
Three sources: **GitHub**, **Azure Boards** and any **CSV** export. Zero dependencies, global `fetch`,
no environment variables: you pass the token as an argument, and every function
accepts an injectable `fetch`, so tests never touch the network.

Every event also carries `at` (ISO date) and `ref` (URL of the work) so a payout
can be audited back to what was delivered. Scoring ignores those two fields.

## GitHub

```js
const { githubEvents, creditMilestone } = require('@zelena/harmony-connectors');

const r = await githubEvents({
  owner: 'acme', repo: 'widgets',
  since: '2026-03-01', until: '2026-04-01',   // events in [since, until)
  token: process.env.GITHUB_TOKEN,            // read it in YOUR code; optional for public repos
  include: { pulls: true, reviews: true, commits: true, milestones: true },
});
// r.events      -> [{ participantId: 'ana', metric: 'pr_merged', value: 1, at, ref }, ...]
// r.milestones  -> [{ title, number, closedAt, closedIssues, url }]  (team events, nobody credited)
// r.people      -> [{ participantId, name, url }]                    (no emails)
// r.truncated   -> true when maxPages (default 10) cut a list short
const team = ['ana', 'ben'];                  // the host decides who earns a milestone
const milestoneEvents = creditMilestone(r.milestones, team);
```

## Azure Boards

```js
const { azureBoardsEvents } = require('@zelena/harmony-connectors');

const r = await azureBoardsEvents({
  organization: 'acme', project: 'Widgets',
  since: '2026-03-01', until: '2026-04-01',
  token: myPat, auth: 'pat',                  // 'pat' (Basic) or 'bearer' (Entra ID token)
  participantKey: 'id',                       // 'uniqueName' (default, usually an email) or 'id'
  maxEffort: 13,                              // default 13: the most one item may credit (see below)
});
// r.events     -> item_done (value = effort or story points, else 1, at most maxEffort) and bug_fixed (1)
// r.clamped    -> ids of the items whose effort was above maxEffort and was cut to it
// r.unassigned -> { count, ids }  closed items with no assignee; nobody is credited
// r.items      -> every closed item seen, for auditing
```

**Effort is editable by any board user.** Anybody who can edit a work item can
change its effort or story points after it is closed, and that number becomes
points (and money). `maxEffort` (default 13, the usual top of a story-point
scale; raise it if your team estimates in hours or bigger units) clamps it: a
larger effort counts as `maxEffort` and the item is listed in `clamped` so you
can review it; a missing, zero, negative or non-finite effort counts as 1. Keep
a cap on the `item_done` metric of your program as well (the
`software-delivery` template caps every metric), and review the `clamped` list
before you pay.

**Every number here comes from a tool that any team member can edit** (merge a
trivial pull request, approve a review, close a bug, change an effort). The
caps of the `software-delivery` template limit the damage, they do not remove
it: a team should review the event list before paying (every event links to its
source: `ref`) and agree on the weights with the people who will be paid.

Combine sources and map one person across systems:

```js
const { mergeEvents } = require('@zelena/harmony-connectors');
const { events, unmapped, assumedCanonical } = mergeEvents(github, azure, {
  identities: { 'ana-dev': 'ana', 'ana@example.com': 'ana' },   // lookup ignores case
});
// unmapped:         ids that were not in the map (kept as they are).
// assumedCanonical: ids that were not in the map but equal a canonical id (a VALUE of the
//                   map): taken as that person and listed so a collision (two different
//                   people with the same id) is visible. Review it before you pay.
```

## CSV

Most companies cannot give API access on day one, but every one of them can
export a spreadsheet. `csvEvents` turns that export into events. It is a pure
function: CSV text in, no file system and no network (read the file in your own
code).

```js
const fs = require('node:fs');
const { csvEvents } = require('@zelena/harmony-connectors');

const r = csvEvents(fs.readFileSync('deliveries.csv', 'utf8'), {
  participant: 'Carrier',                 // required: who did the work
  name: 'Carrier name',                   // optional display name
  date: 'Delivered on', dateFormat: 'DD/MM/YYYY',
  since: '2026-11-01', until: '2026-12-01',   // rows in [since, until); needs `date`
  ref: 'Order',                           // copied to each event, to trace a payout to its rows
  delimiter: ';', decimal: ',',           // Spanish-locale export
  rules: [
    { metric: 'delivery_confirmed', when: { column: 'Status', equals: 'Delivered' } },
    { metric: 'delivered_on_time', when: [{ column: 'Status', equals: 'Delivered' }, { column: 'Days late', lte: 0 }] },
    { metric: 'unit_accepted', value: { column: 'Units accepted' } },
  ],
});
// r.events    -> [{ participantId, metric, value, at?, ref? }, ...]
// r.people    -> [{ participantId, name }]       everybody with a usable row
// r.rows      -> data rows read (blank lines excluded)
// r.skipped   -> [{ line, reason }]              rows that could not be used, never dropped silently
// r.unmatched -> usable rows that no rule turned into an event
// r.window    -> { since, until } as ISO strings, or null
```

### Mapping reference

| Key | Meaning |
| --- | --- |
| `participant` | Column that holds who did the work. Required. The cell, trimmed, is the participant id. |
| `name` | Column with the display name (the first non-empty one seen for each participant). |
| `date` | Column with the date of the row. When set, every row needs a readable date. |
| `dateFormat` | `'ISO'` (default), `'DD/MM/YYYY'` or `'MM/DD/YYYY'`. ISO dates (`2026-11-05`, `2026-11-05 14:30`, `2026-11-05T14:30:00Z`) are always read; a time without an offset is UTC. A slash date (`05/03/2026`) is read only when `dateFormat` says which order it uses, and is skipped otherwise. Separators `/`, `.` and `-` are accepted. |
| `since`, `until` | ISO dates. A row is kept when `since <= date < until` (`until` is exclusive). Both need `date`. |
| `rules` | Array. Each rule turns a row into at most one event: `{ metric, when?, value? }`. A row can feed several rules. |
| `ref` | Column copied to the `ref` of each event (order number, invoice number). |
| `decimal` | `'.'` (default) or `','`. Declares the notation of every number: with `'.'`, `1,234.56`; with `','`, `1.234,56`. A number in the other notation is skipped, never guessed. No exponents, currency signs or `NaN`. |
| `delimiter` | One character, default `,`. Use `;` for most Spanish-locale exports, or a tab. |
| `maxRows` | Most data rows accepted. Default and ceiling 200,000; more than that is an error, not a truncation. |

`when` is one condition or an array of them (all must hold). A condition is
`{ column, ...operators }` with at least one of:

| Operator | True when the trimmed cell |
| --- | --- |
| `equals` | is exactly that text or number (case matters) |
| `in` | is exactly one of those texts or numbers |
| `notEmpty` | is not empty (`true`) or is empty (`false`) |
| `gt`, `gte`, `lt`, `lte` | is a number that compares that way; an empty cell is false; a non-number skips the row |

`value` is a number (default `1`) or `{ column, scale?, round? }`: the number in
that column times `scale` (default 1), then `round`: `'floor'`, `'ceil'` or a
number of decimals. An empty or non-numeric cell, a negative number or a result
above 1,000,000,000 skips the row. A value that comes out as exactly 0 credits
nothing. Use a metric with negative points (`rejected_unit`), not a negative
value, to take points away. `value` is only evaluated for a row whose `when`
holds.

**What is guaranteed.** The parser follows RFC 4180: quoted fields with
delimiters, doubled quotes and line breaks inside quotes, CRLF, LF or CR line
ends, an optional byte-order mark, blank lines ignored, trimmed headers. The
header row is required; a duplicate header name, a mapped column that is not in
the header, an unterminated quote or more rows than `maxRows` throw a
`ConnectorError` (a mapping that is not well formed throws a `TypeError`). A row
with a different number of columns than the header is skipped. Cells are data:
one that starts with `=`, `+`, `-` or `@` is just text here (it matters only if
you later write it into a spreadsheet; `toSdpDisbursement` refuses such ids).

**What is not.** Rows are not deduplicated: if the export lists an order twice, it
counts twice (put an order number in `ref` and look for repeats). A participant is
whatever the cell says, so `Ana` and `ana` are two people; map them with
`mergeEvents({ identities })` or clean the export. The numbers are only as good as
the export: review `skipped`, `unmatched` and the event list before you trust a
ranking.

## Metric ids

Defaults match the `software-delivery` kit template. Rename with the `metrics` option.

| Metric | Source | Value |
| --- | --- | --- |
| `pr_merged` | GitHub | 1 per merged pull request, credited to its author |
| `review` | GitHub | 1 per reviewer per PR (APPROVED or CHANGES_REQUESTED), never the author |
| `commit` | GitHub | 1 per non-merge commit on the default branch linked to a GitHub user |
| `milestone` | GitHub | 1 per participant per closed milestone, via `creditMilestone` |
| `item_done` | Azure Boards | effort or story points of a closed item, 1 if it has none |
| `bug_fixed` | Azure Boards | 1 per closed bug |
| any | CSV | whatever your `rules` say; metric ids are yours, so match them to the program |

## Token permissions

- **GitHub**: public repositories need no token (60 requests/hour). For private
  ones use a read-only token (fine-grained: Pull requests, Contents and Metadata
  set to read-only on that repository). Bots are excluded unless `excludeBots: false`.
- **Azure DevOps**: Work Items, Read.

The token is only sent in the `Authorization` header, never in a URL, and never
appears in an error message. A `Link` header that points outside
`api.github.com` is refused rather than followed.

## Privacy

With Azure Boards the default participant id is the assignee's `uniqueName`,
which is usually an email address. That is personal data and it will end up in
whatever you store from the events. Use `participantKey: 'id'` for the opaque
identity GUID and translate it with `mergeEvents({ identities })`. GitHub
participants are public logins; `people` never includes emails.

## Limits

- GitHub: one repository per call, default branch only for commits, REST only
  (no GraphQL), 10 pages of 100 per endpoint unless you raise `maxPages`.
  Reviews cost one request per merged PR; turn them off for large windows or
  anonymous use. A squash-merged PR yields both a `pr_merged` and a `commit`:
  pick the metrics your program values, or turn one source off with `include`.
- GitHub reviews and milestones are not deduplicated across calls: use
  non-overlapping `[since, until)` windows.
- Azure Boards: the query returns at most 20,000 work items per window (Azure
  rejects larger result sets; use a shorter window). Items are credited to the
  current assignee at read time, not to whoever closed them. The effort fields
  must exist in the project's process template. The query sets
  `timePrecision=true` so the window is compared by time, not whole days.
- Both sources: nothing is cached or deduplicated between runs.

## Tests

`npm test` (Node 20+, no network).

## Output: Stellar Disbursement Platform

The connectors above bring work in. `toSdpDisbursement` sends a payout plan out:
it turns a Harmony plan into the CSV that the
[Stellar Disbursement Platform](https://developers.stellar.org/docs/platforms/stellar-disbursement-platform)
(SDP, the open-source bulk-payout tool of the Stellar Development Foundation)
takes as a disbursement instruction file, so an organization that already runs
SDP can pay a plan without signing payments itself. SDP also handles receiver
onboarding (wallet registration by phone or email). Pure function: no network,
no file system.

```js
const { toSdpDisbursement } = require('@zelena/harmony-connectors');

const r = toSdpDisbursement(plan, {
  mode: 'phone_wallet',                       // must match the disbursement you create in SDP
  contacts: { w1: { phone: '+12025550101' } },// supplied by YOUR system, never read from the plan
  // pockets: 'instant' (default) | 'all' | ['now', 'bonus']
});
// r.csv     -> "phone,id,amount,walletAddress,paymentID\n+12025550101,w1,48.0000000,G...,abcdef012345-pw1\n"
// r.rows    -> the same rows as objects
// r.skipped -> [{ participantId, name, reason }]  nobody is ever emitted half filled
// r.total   -> "48.0000000"  (exact: BigInt stroops, never floating point)
// r.notes   -> what the host must know before uploading
```

| `mode` | SDP registration contact type | Columns |
| --- | --- | --- |
| `phone_wallet` | `PHONE_NUMBER_AND_WALLET_ADDRESS` | `phone,id,amount,walletAddress,paymentID` |
| `email_wallet` | `EMAIL_AND_WALLET_ADDRESS` | `email,id,amount,walletAddress,paymentID` |
| `phone` | `PHONE_NUMBER` | `phone,id,amount,verification,paymentID` |
| `email` | `EMAIL` | `email,id,amount,verification,paymentID` |

SDP has no wallet-only variant: every receiver is identified by a phone (E.164,
for example `+12025550101`) or an email, even when the wallet address is given.
`mode` is required because it has to match the registration contact type chosen
when the disbursement is created in SDP. In `phone` / `email` mode the receiver
registers their own wallet (the plan's wallet is not used) and each person needs
a `verification` value of the single type configured in SDP; pass it as
`verificationType`: `DATE_OF_BIRTH` (`YYYY-MM-DD`), `YEAR_MONTH` (`YYYY-MM`),
`PIN` (4 to 8 characters) or `NATIONAL_ID_NUMBER` (up to 50).

- `id` is the participant id (max 64 characters). `paymentID` is
  `<first 12 characters of planId>-p<participantId>`, so exporting the same plan
  twice yields the same ids and a double payment is visible. If the participant
  id has characters outside `A-Za-z0-9._-` or the result would pass 64
  characters (an id of more than 50), `<first 12 characters>-h<16 hex of a hash
  of the id>` is used instead. The `p` and `h` markers make the two shapes
  impossible to confuse, so no participant id can be chosen to collide with
  somebody else's `paymentID`. `planId` must be 64 lowercase hex characters.
- Amounts have exactly 7 decimals, the maximum SDP accepts.
- A person is skipped (with a reason) when the contact, wallet shape or
  verification value is missing or invalid, when the amount is zero, when a
  contact or wallet repeats (SDP rejects duplicates), or when an id, email or
  verification value starts with `=`, `+`, `-` or `@` (spreadsheet formula
  injection). Values are skipped rather than altered so identifiers never change.
- SDP accepts at most 10,000 rows per disbursement; `notes` says so if you exceed it.

**What is lost.** SDP sends plain payments, so pocket time rules cannot be
expressed. By default only `instant` pockets are exported and the amount that was
left out is reported in `notes`; it must be paid by another route. With
`pockets: 'all'` every pocket is summed into one immediate payment and the
`unlocks` / `expires` rules are lost (`notes` says so). The asset (for example
USDC) is chosen in SDP, not in the file, and must match the plan.

**Verified against** `stellar-disbursement-platform-backend` 7.1.0 (`main` at
commit `331ab68`, 2026-10-26), read on 2026-11-24:
- https://github.com/stellar/stellar-disbursement-platform-backend/blob/main/internal/serve/httphandler/disbursement_handler.go (`validateCSVHeaders`: required and disallowed columns per contact type, row and size limits)
- https://github.com/stellar/stellar-disbursement-platform-backend/blob/main/internal/data/disbursement_instructions.go (column names `phone`, `email`, `id`, `amount`, `verification`, `paymentID`, `walletAddress`, `walletAddressMemo`)
- https://github.com/stellar/stellar-disbursement-platform-backend/blob/main/internal/serve/validators/disbursement_instructions_validator.go and `internal/utils/validation.go` (E.164 phone, email, amount, verification rules, 64-character `id` and `paymentID`)
- https://github.com/stellar/stellar-disbursement-platform-backend/blob/main/dev/sample/sample-disbursement.csv and `internal/integrationtests/resources/disbursement_instructions_*.csv` (sample files)
- https://developers.stellar.org/openapi/stellar-disbursement-platform/bundled.yaml (the upload endpoint: columns vary with the disbursement configuration)

Not exported: the optional `walletAddressMemo` column, and the embedded-wallet
variant (`phone,id,amount`). The date-of-birth and year-month values are checked
for shape only; SDP also rejects dates in the future.
