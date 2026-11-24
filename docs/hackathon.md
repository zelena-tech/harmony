# Build with Stellar Harmony in 10 minutes

You will clone the repository, run an offline demo, run a real transaction demo
on Stellar testnet, and then call the kit from your own code. Nothing is
published to npm yet, so you work inside the clone.

Requirements: Node.js 20 or later and Git. The testnet demo needs internet
access (it uses the public testnet Horizon and friendbot).

## 1. Clone and install

```bash
git clone https://github.com/zelena-tech/harmony.git
cd harmony
git checkout feat/harmony-kit        # until it is merged to main

(cd packages/core && npm ci)
(cd packages/kit && npm ci)
# packages/connectors has no dependencies: there is nothing to install
```

Check that it works:

```bash
(cd packages/kit && npm test)
(cd packages/connectors && npm test)
```

## 2. Offline quickstart (no network)

```bash
node examples/quickstart-offline.js
```

It scores a set of events, builds a payout plan and prints the Harmony Cards.
No wallet, no keys, no network. This is level 0 in
[adoption-levels.md](adoption-levels.md).

## 3. Testnet quickstart (real transactions)

```bash
node examples/quickstart-testnet/run.js                      # default template
node examples/quickstart-testnet/run.js last-mile-delivery   # any template id
```

It creates throwaway accounts, funds them with friendbot, builds the
transactions, signs them with the throwaway payer key, submits them to testnet
and writes SVG cards to `examples/quickstart-testnet/out/`. The keys exist only
for that run. Do not reuse that pattern with a real key: in production the
payer signs in its own wallet.

## 4. Integrate it in your project (about 15 lines)

```js
const { createProgram } = require('./packages/kit/src');   // path into the clone

const harmony = createProgram({
  tenant: { id: 'my-project', network: 'testnet' },
  program: 'learn-to-earn',                                 // one of the 11 templates
});

const { standings } = harmony.score({ events });            // [{ participantId, metric, value }]
const plan = harmony.plan({ standings, people });           // people: { id: { name, wallet } }
const built = await harmony.build({ plan, payer });         // unsigned XDR, payer is a G... address
// Keep plan, built and built.hashes on your server. Send built.xdrs to the payer's wallet to sign.
// Mark the plan as submitted when you sign. If submit() says SUBMISSION_UNKNOWN, resubmit the
// SAME signed transactions and never build the plan again (see kit.md, "After you sign").
const receipt = await harmony.submit({ built, signedXdrs });
const card = harmony.card({ participant: { participantId: 'ana', name: 'Ana' },
  standing: standings[0], of: standings.length, payment: plan.payments[0], receipt });
require('fs').writeFileSync('ana.svg', harmony.renderCardSvg(card));
```

To feed it from GitHub or Azure Boards, use `packages/connectors` (see
`examples/software-team/github-to-plan.js`). The field reference is
[kit.md](kit.md).

## 5. Ten project ideas

Each uses one template as a starting point.

1. **Warehouse bonus board** (`warehouse-fulfillment`). Warehouses already log
   orders picked and packed. Build a screen that shows the live ranking and
   pays the top five every Friday, with a savings pocket.
2. **Courier payday** (`last-mile-delivery`). Couriers wait days for pay and
   many have no wallet. Build a flow where the money is held for them and a
   single signature claims it and adds the trustline.
3. **Shop-floor commissions** (`retail-sales`). Independent shops want a
   transparent sell-out contest. Build a brand dashboard that funds a campaign
   and pays every seller with a public proof.
4. **Support desk quality pay** (`customer-support`). Agents are scored on
   tickets and satisfaction. Build a plug-in for a ticket system that turns
   the month into a plan and a card per agent.
5. **Crew hand-over bonus** (`construction-crew`). Crews distrust promised
   bonuses. Build a tracker where 40% unlocks on the delivery date and anyone
   can see the money is already there.
6. **Shift recognition** (`healthcare-shifts`). Nights and weekends go
   unrecognized. Build a rota-to-reward tool that gives each clinic its own
   pool and a wellbeing pocket that expires.
7. **Learn-to-earn course** (`learn-to-earn`). Students drop out before the
   end. Build a course platform where half of the scholarship unlocks only on
   the last day.
8. **Tip pool you can audit** (`tip-pool`). Staff cannot check how tips were
   split. Build a point-of-sale add-on that shares tips by hours worked and
   shows the split.
9. **Contributor payouts** (`open-source-bounties` and `software-delivery`). A
   maintainer pays by hand each month. Build a scheduled job that reads
   merged work with the connectors and opens the payment for the treasurer to
   sign.
10. **Harvest piece-rate** (`harvest-piece-rate`). Pickers are paid in cash,
    late. Build a phone app that records kilograms and pays daily at a rate,
    with a season-end pocket.

## 6. What judges usually ask

**Who holds the keys?** Nobody but the owner. The kit builds unsigned
transactions; the payer signs in its own wallet and each person signs their own
claim. `submit` only accepts a transaction whose hash matches what `build`
produced, and rejects any operation that is not a payment or claimable balance
of the reward asset to a wallet in the plan.

**What is on-chain?** Payments and claimable balances of the reward asset, the
claims, and a memo with the plan id (a salted hash, so the participant ids behind
it cannot be guessed from it). Points, standings and the source
events stay off-chain, with you. Amounts and addresses are public on a public
network. The privacy example in `examples/private-payouts` hides amounts, but it
is a separate example.

**What does a payout cost?** The network fee is 0.0001 XLM per operation (up to
20 operations per transaction). Claimable balances also need a reserve of 0.5
XLM per claimant, paid by the payer and returned when the balance is claimed.
A person's trustline holds a small reserve on their own account.

**What is audited?** The Organization and Factory contracts and the engine in
`packages/core` are prepared for an external audit, with known issues disclosed
in [audit/findings.md](audit/findings.md); the contracts are a testnet pilot,
not on mainnet. The **kit and the connectors are new and not audited.** Do not
use the kit with real money on mainnet without your own review.

**Can it restrict where the money is spent?** No. Pockets control when money
becomes available and whether it returns to the payer, not where it goes after
the person claims.

**Is it a payroll system?** No. See [use-cases.md](use-cases.md).

**What is real today?** The direct-payment rail in `packages/core` is used on
mainnet. Pockets are proven on testnet only. The status table is in
[adoption-levels.md](adoption-levels.md).
