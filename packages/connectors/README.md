# @zelena/harmony-connectors

Turns work that a system already records into plain Harmony events,
`{ participantId, metric, value }`, so a program can score it and pay it out.
Two sources: **GitHub** and **Azure Boards**. Zero dependencies, global `fetch`,
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
