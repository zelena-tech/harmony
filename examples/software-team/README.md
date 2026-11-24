# Software team report

`team-report.js` is the first thing a software team (or an integrator paid per
milestone) runs to see Harmony working on its own work. It **reads** pull
requests, reviews and milestones from GitHub and closed items from Azure
Boards, and shows:

- points and a ranking per person,
- a payout preview (amount and pockets per person, shares withheld for people
  without a wallet),
- an audit trail: every event carries a link to its pull request, review,
  milestone or work item,
- one preview card (SVG) per person.

It never builds, signs or sends a transaction. It stops at the plan, which is
adoption level 0/1 in [adoption-levels.md](../../docs/adoption-levels.md).
Nothing is paid.

## The two-minute path

No tokens, no network, no install beyond the repository itself (Node 20+):

```bash
# from the repository root
node examples/software-team/team-report.js --fixtures
```

This runs on invented data (`fixtures.js`: five people, twelve merged pull
requests, one milestone, twenty board items, one bot, one unassigned item). The
output is the same every time. Open the files it writes in
`examples/out/software-team/`:

| File | What it is |
|---|---|
| `report.json` | standings, the plan, and every event with its `ref` link |
| `report.md` | a summary you can paste into a board or a chat |
| `<person>.svg` | one preview card per person |

The fixtures totals can be checked by hand; the table is at the top of
`fixtures.js`.

## Point it at your repository and board

1. Copy `team.example.json` and edit it (the invented values show every field).
2. Set the tokens in your environment. They are read only by `team-report.js`
   and are never printed or written to any file.

   | Variable | Needed for | Scope |
   |---|---|---|
   | `GITHUB_TOKEN` | private repositories; raises the rate limit of public ones | fine-grained, read-only: Pull requests, Contents, Metadata |
   | `AZURE_DEVOPS_TOKEN` | Azure Boards | Work Items: Read |
   | `AZURE_DEVOPS_AUTH` | Azure Boards | `pat` (default, a personal access token) or `bearer` (an Entra ID token) |

3. Run it:

   ```bash
   GITHUB_TOKEN=... AZURE_DEVOPS_TOKEN=... \
     node examples/software-team/team-report.js --config team.json [--out dir]
   ```

Public repositories work with no token (60 requests per hour). Reviews cost one
request per merged pull request, so for an anonymous run set
`"include": { "reviews": false }`. The default output folder is
`examples/out/software-team/`, which git ignores; do not commit reports of a
real team.

`--fixtures --config team.json` runs your own configuration against the invented
data (useful to try a program override or an identity map offline).

### The configuration

| Key | Meaning |
|---|---|
| `organization` | slug, also the tenant id shown on the cards |
| `period` | `label`, `since`, `until`. Dates are UTC; `until` is **not** included |
| `github` | array of `{ owner, repo, include, maxPages, excludeBots }`. May be empty or missing |
| `azureBoards` | array of `{ organization, project, participantKey, doneStates, bugTypes, effortFields, types }`. May be empty or missing |
| `identities` | each system's id mapped to one canonical person id (lookup ignores case) |
| `people` | per canonical id: display `name` and optional Stellar `wallet` (`null` or a public key `G...`) |
| `milestones.creditEveryone` | when `true`, each GitHub milestone closed in the period gives one `milestone` event to everybody with other activity |
| `program` | overrides on the `software-delivery` template: `payout`, `metrics`, `levels`, `pockets`... Each key replaces the template's key as a whole, so to change one metric repeat the whole `metrics` list. See [kit.md](../../docs/kit.md) |
| `lifetime` | lifetime points per person, so levels show (the level comes from points before this period) |

The configuration is validated first and every problem is listed at once.

Identities: Azure Boards identifies people by their sign-in name, usually an
email address. If you prefer not to store emails, set `"participantKey": "id"`
on the Azure entry and map the identity GUIDs instead. Any id you do not map is
kept as it came and listed at the end under "Unmapped identities" so you can
complete the file; until then that person may appear twice (for example once by
GitHub login and once by email). An id that is not mapped but equals a canonical
id is taken as that person and listed under "Taken as the same person because
the id matches": check it, because two different people can share an id.

Wallets are optional. Without one a person is still ranked and gets a card, and
the plan shows the share that would be withheld for them.

### Commits and the squash-merge double count

A squash-merged pull request produces both a `pr_merged` event and a `commit`
event for the same work. By default this report counts pull requests and
ignores commits (`include.commits` is `false`), and it says so in its output.
Set `"include": { "commits": true }` on a repository only if your program is
meant to value direct commits.

## What the numbers mean

Points come from the `software-delivery` template, unless you override it:

| Metric | Source | Points per unit |
|---|---|---|
| `pr_merged` | GitHub: a merged pull request, credited to its author | 20 |
| `review` | GitHub: one per reviewer per pull request (approved or changes requested), never the author | 8 |
| `item_done` | Azure Boards: a closed item; the unit is its effort or story points, 1 if it has none | 5 per unit |
| `bug_fixed` | Azure Boards: a closed bug | 10 |
| `milestone` | GitHub: a closed milestone, via `creditEveryone` | 50 |
| `commit` | GitHub, off by default | 1 (max 100) |

Every metric has a cap (`pr_merged` 60, `review` 120, `bug_fixed` 30,
`item_done` 200, `commit` 100 units per person and period) and Azure effort is
clamped at 13 per item by default. These numbers come from tools that any team
member can edit, so the caps limit the damage but do not remove it: review the
event list (every event links to its source in `report.json`) before paying.

Then, per person: `adjusted points = points x level multiplier`. The pool is
shared between everyone in proportion to adjusted points. Each person's amount
is split into pockets (by default 70 % available now and 30 % released 30 days
after the plan). A person without a wallet gets no payment and their share is
withheld, never redistributed. Bots are excluded. Items closed with nobody
assigned credit nobody. The amounts are in the program's reward asset (USDC by
default); the preview uses testnet defaults.

## From the preview to a real payout

The preview is level 0/1. To pay it for real, read [docs/kit.md](../../docs/kit.md)
(`build`, the payer signs in its own wallet, `submit`) and run the end to end
example on the Stellar testnet in [../quickstart-testnet/README.md](../quickstart-testnet/README.md).
Agree on the metric weights and on who signs before you move money. The kit is
not audited.

## What a points ranking is and is not

It is a faithful count of what your tools recorded in a window: merged pull
requests, reviews, closed items, milestones. It is transparent (every number
traces back to a link) and the rules are plain data you can read and change.

It is not a measure of quality, difficulty or effort on its own. A one-line fix
and a month of design both count as one merged pull request. Effort on board
items is whatever your team typed in. Work that leaves no trace in these tools
(pairing, mentoring, incident response, design discussions) scores zero, and
anything that is cheap to produce can be inflated once people know it is
counted. Reviews and items are credited to who the tool says did them, which for
Azure Boards is the current assignee, not necessarily who closed the item.

Use the ranking as input to a conversation, not as a verdict. Agree on the
metric weights, the caps and the pool with the people who will be paid on them
before the first real payout, and review the unmapped identities and the audit
trail every period.
