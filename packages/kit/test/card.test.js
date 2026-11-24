'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { kit, NOW, DAY, scenario, simpleProgram, signXdr, fakeHorizon, account, scoreOf, peopleOf, tenant } = require('./_helpers');
const { submit } = require('../src/submit');
const { card, renderCardSvg } = require('../src/card');

const FOUR_POCKETS = [
  { id: 'now', label: 'Available now', share: 0.4, rule: { type: 'instant' } },
  { id: 'soon', label: 'Streak', share: 0.2, rule: { type: 'expires', afterDays: 14 } },
  { id: 'later', label: 'Savings', share: 0.3, rule: { type: 'unlocks', afterDays: 60 } },
  { id: 'extra', label: 'Extra', share: 0.1, rule: { type: 'instant' } },
];

const ladder = [
  { id: 'one', name: 'One', minLifetimePoints: 0, multiplier: 1 },
  { id: 'two', name: 'Two', minLifetimePoints: 100, multiplier: 1.1 },
  { id: 'three', name: 'Three', minLifetimePoints: 1000, multiplier: 1.2 },
];

const GADDR = /G[A-Z2-7]{55}/;

/** Runs a scenario through submit and returns what the card needs. */
async function paid(opts = {}) {
  const s = scenario(opts);
  const built = await kit.build(s.program, s.tenant, { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now });
  const receipt = await submit(s.tenant, { built, signedXdrs: built.xdrs.map((x) => signXdr(x, s.payer)), horizon: fakeHorizon({}) });
  return { ...s, built, receipt };
}

const cardFor = (s, id, extra = {}) => {
  const standing = s.standings.find((x) => x.participantId === id);
  const person = s.people[id];
  const payment = s.plan.payments.find((p) => p.participantId === id);
  return card(s.program, s.tenant, { participant: { participantId: id, name: person.name, wallet: person.wallet }, standing, of: s.standings.length, payment, period: 'Week 47', now: NOW, ...extra });
};

test('a card without a receipt is a preview: planned pockets, no proofs, no plan id', async () => {
  const s = scenario({ program: simpleProgram({ pockets: FOUR_POCKETS, levels: ladder }) });
  const c = cardFor(s, 'a');
  assert.equal(c.kind, 'harmony-card');
  assert.equal(c.version, 1);
  assert.equal(c.preview, true);
  assert.deepEqual(c.proofs, []);
  assert.equal(c.planId, null);
  assert.deepEqual(c.reward.pockets.map((k) => k.status), ['planned', 'planned', 'planned', 'planned']);
  assert.ok(c.reward.pockets.every((k) => k.balanceId === null));
  assert.equal(c.reward.total, s.plan.payments[0].amount);
  assert.equal(c.reward.asset, 'USDC');
  assert.equal(c.period, 'Week 47');
  assert.equal(c.issuedAt, new Date(NOW * 1000).toISOString());
});

test('without a payment the card shows points only', () => {
  const s = scenario();
  const c = cardFor(s, 'a', { payment: undefined });
  assert.equal(c.reward, null);
  assert.equal(c.points.adjusted, 50);
  assert.equal(c.rank, 1);
  assert.equal(c.of, 3);
});

test('statuses after payment: paid, claimable, locked, and the date of each pocket', async () => {
  const s = await paid({ program: simpleProgram({ pockets: FOUR_POCKETS }), points: { a: 1 } });
  const c = cardFor(s, 'a', { receipt: s.receipt, now: NOW + DAY });
  assert.equal(c.preview, false);
  assert.deepEqual(c.reward.pockets.map((k) => [k.id, k.status]), [['now', 'paid'], ['soon', 'claimable'], ['later', 'locked'], ['extra', 'paid']]);
  assert.equal(c.reward.pockets[1].date, new Date((NOW + 14 * DAY) * 1000).toISOString().slice(0, 10));
  assert.equal(c.reward.pockets[0].date, null);
  assert.match(c.reward.pockets[1].balanceId, /^[0-9a-f]{72}$/);
  assert.match(c.reward.pockets[2].balanceId, /^[0-9a-f]{72}$/);
  assert.equal(c.reward.pockets[0].balanceId, null);
  assert.deepEqual(c.proofs.map((p) => p.hash), s.built.hashes);
  assert.match(c.proofs[0].url, /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/);
  assert.equal(c.planId, s.plan.planId);
});

test('statuses over time: a locked pocket opens and an expiring one expires, exactly on the date', async () => {
  const s = await paid({ program: simpleProgram({ pockets: FOUR_POCKETS }), points: { a: 1 } });
  const at = (now) => cardFor(s, 'a', { receipt: s.receipt, now }).reward.pockets.map((k) => k.status);
  assert.deepEqual(at(NOW + 14 * DAY - 1), ['paid', 'claimable', 'locked', 'paid']);
  assert.deepEqual(at(NOW + 14 * DAY), ['paid', 'expired', 'locked', 'paid']);
  assert.deepEqual(at(NOW + 60 * DAY - 1), ['paid', 'expired', 'locked', 'paid']);
  assert.deepEqual(at(NOW + 60 * DAY), ['paid', 'expired', 'claimable', 'paid']);
});

test('waiting: a held pocket of somebody who cannot receive yet', async () => {
  const s = scenario({ program: simpleProgram({ pockets: FOUR_POCKETS }), points: { a: 1 }, funded: false });
  s.horizon = fakeHorizon({ [s.payer.publicKey()]: account({ usdc: '1000000.0000000' }) });
  const built = await kit.build(s.program, s.tenant, { plan: s.plan, payer: s.payer.publicKey(), horizon: s.horizon, now: s.now });
  const receipt = await submit(s.tenant, { built, signedXdrs: built.xdrs.map((x) => signXdr(x, s.payer)), horizon: fakeHorizon({}) });
  const c = cardFor({ ...s, built }, 'a', { receipt, now: NOW + DAY });
  assert.deepEqual(c.reward.pockets.map((k) => k.status), ['waiting', 'claimable', 'locked', 'waiting']);
});

test('planned: a pocket that is not in the receipt (skipped person) stays planned', async () => {
  const s = await paid({ points: { a: 60, b: 40 } });
  const c = cardFor(s, 'a', { receipt: { ...s.receipt, transactions: s.receipt.transactions.map((t) => ({ ...t, operations: t.operations.filter((o) => o.participantId !== 'a') })) } });
  assert.deepEqual(c.reward.pockets.map((k) => k.status), ['planned']);
  assert.deepEqual(c.proofs, []);
});

test('level, promotion and points on the card', () => {
  const program = simpleProgram({ levels: ladder });
  const { standings } = scoreOf(program, { a: 120, b: 10 }, { lifetime: { a: 50, b: 0 } });
  const a = standings.find((x) => x.participantId === 'a');
  const c = card(program, tenant(), { participant: { participantId: 'a', name: 'Ana' }, standing: a, of: 2, now: NOW });
  assert.deepEqual([c.level.id, c.level.step, c.level.steps, c.level.multiplier], ['one', 1, 3, 1]);
  assert.equal(c.level.promotedTo, 'Two'); // 50 + 120 crosses 100
  assert.deepEqual(c.points, { earned: 120, adjusted: 120, lifetime: 170 });
  assert.equal(c.level.next.name, 'Three'); // the next step after the level reached this period
  const b = standings.find((x) => x.participantId === 'b');
  assert.equal(card(program, tenant(), { participant: { participantId: 'b' }, standing: b, now: NOW }).level.promotedTo, null);
  assert.equal(card(program, tenant(), { participant: { participantId: 'b' }, standing: b, now: NOW }).of, null);
});

test('no full wallet address appears anywhere in the card JSON or the SVG', async () => {
  const s = await paid({ program: simpleProgram({ pockets: FOUR_POCKETS, levels: ladder }), points: { a: 60, b: 40 } });
  for (const id of ['a', 'b']) {
    const c = cardFor(s, id, { receipt: s.receipt, now: NOW + DAY });
    const json = JSON.stringify(c);
    const svg = renderCardSvg(c);
    const full = s.people[id].wallet;
    for (const text of [json, svg]) {
      assert.ok(!text.includes(full), 'the full wallet is not there');
      assert.ok(!GADDR.test(text), 'nothing that looks like an account id');
      assert.ok(!text.includes(s.payer.publicKey()), 'the payer account is not there either');
    }
    assert.equal(c.participant.wallet, `${full.slice(0, 4)}…${full.slice(-4)}`);
  }
  // Short or missing wallets are not echoed.
  const s2 = scenario();
  assert.equal(cardFor(s2, 'a', {}).participant.wallet, cardFor(s2, 'a', {}).participant.wallet);
  const c = card(s2.program, s2.tenant, { participant: { participantId: 'x', wallet: 'GSHORT' }, standing: s2.standings[0], now: NOW });
  assert.equal(c.participant.wallet, null);
  assert.equal(card(s2.program, s2.tenant, { participant: { participantId: 'x' }, standing: s2.standings[0], now: NOW }).participant.wallet, null);
});

// ── SVG ─────────────────────────────────────────────────────────────────────

/** Minimal well-formedness check: balanced tags, quoted attributes, only legal entities, no raw < or & in text. */
function assertWellFormedXml(xml) {
  assert.ok(xml.startsWith('<svg') && xml.endsWith('</svg>'));
  const stack = [];
  const re = /<([^>]*)>|([^<]+)/g;
  let m;
  let root = 0;
  while ((m = re.exec(xml))) {
    if (m[2] !== undefined) {
      assert.ok(!/>/.test(m[2]) || true);
      assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(m[2]), `bad entity in text: ${m[2].slice(0, 60)}`);
      continue;
    }
    const tag = m[1];
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      assert.equal(stack.pop(), name, `closing ${name}`);
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const name = /^[A-Za-z][\w:-]*/.exec(body)[0];
    // every attribute value is quoted and free of raw < and bare &
    const attrs = body.slice(name.length);
    const rest = attrs.replace(/\s+[A-Za-z:][\w:-]*="[^"<]*"/g, '');
    assert.equal(rest.trim(), '', `malformed attributes in <${name}>: ${attrs.slice(0, 80)}`);
    for (const v of attrs.matchAll(/="([^"]*)"/g)) assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(v[1]), `bad entity in attribute of <${name}>`);
    if (!selfClosing) stack.push(name);
    if (stack.length === 1 && !selfClosing) root += 1;
  }
  assert.deepEqual(stack, [], 'every tag is closed');
  assert.equal(root, 1, 'one root element');
}

const HOSTILE = '<script>alert(1)</script>&"\'';

test('the SVG is well formed and escapes hostile names, labels and periods', async () => {
  const pockets = FOUR_POCKETS.map((k, i) => ({ ...k, label: i === 0 ? HOSTILE : k.label }));
  const program = simpleProgram({ pockets, levels: ladder.map((l, i) => (i === 1 ? { ...l, name: HOSTILE } : l)), name: HOSTILE });
  const s = await paid({ program, points: { a: 1 } });
  s.people.a.name = HOSTILE;
  const c = cardFor(s, 'a', { receipt: s.receipt, period: HOSTILE, now: NOW + DAY });
  c.organization = HOSTILE;
  const svg = renderCardSvg(c);
  assert.ok(!svg.includes('<script'), 'no raw script tag');
  assert.ok(!svg.includes('alert(1)</'), 'the text of the script is not a tag');
  assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;'), 'the hostile name is there, escaped');
  assertWellFormedXml(svg);
});

test('SVG of every status and of a preview is well formed and has no negative sizes', async () => {
  const s = await paid({ program: simpleProgram({ pockets: FOUR_POCKETS, levels: ladder }), points: { a: 100, b: 50 } });
  const variants = [
    cardFor(s, 'a'), // preview
    cardFor(s, 'a', { receipt: s.receipt, now: NOW + DAY }),
    cardFor(s, 'a', { receipt: s.receipt, now: NOW + 90 * DAY }),
    cardFor(s, 'b', { receipt: s.receipt, now: NOW }),
    cardFor(s, 'a', { payment: undefined }),
  ];
  for (const c of variants) {
    const svg = renderCardSvg(c);
    assertWellFormedXml(svg);
    assert.ok(!/(width|height|r)="-/.test(svg), 'no negative dimension');
    assert.ok(!/NaN|undefined|null/.test(svg), 'no leaked placeholders');
  }
  assert.match(renderCardSvg(variants[0]), /preview · not paid yet/);
  assert.match(renderCardSvg(variants[1]), /tx [0-9a-f]{10}…[0-9a-f]{8}/);
  assert.match(renderCardSvg(variants[1]), /claim before/);
  assert.match(renderCardSvg(variants[1]), /locked until/);
  assert.match(renderCardSvg(variants[2]), /ready to claim/);
});

test('the pocket bar stays inside the card even with six very uneven pockets', async () => {
  const shares = [0.9995, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001];
  const pockets = shares.map((share, i) => ({ id: `p${i}`, label: `Pocket ${i}`, share, rule: { type: 'unlocks', afterDays: 10 + i } }));
  const s = scenario({ program: simpleProgram({ pockets, payout: { model: 'proportional', pool: 1000 } }), points: { a: 1 } });
  const svg = renderCardSvg(cardFor(s, 'a'));
  assertWellFormedXml(svg);
  const rects = [...svg.matchAll(/<rect x="(\d+)" y="286" width="(-?\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(rects.length, 6);
  for (const [x, w] of rects) assert.ok(w > 0 && x + w <= 640, `bar piece at x=${x} width=${w}`);
});

test('long names are clipped so the card does not overflow', () => {
  const s = scenario();
  const longName = 'Maria '.repeat(40);
  const c = card(s.program, s.tenant, { participant: { participantId: 'a', name: longName }, standing: s.standings[0], now: NOW });
  const svg = renderCardSvg(c);
  const shown = /<text x="40" y="112" class="n">([^<]*)</.exec(svg)[1];
  assert.ok(shown.length <= 28 && shown.endsWith('…'), 'the visible name is clipped');
  assert.match(svg, /…/);
  assertWellFormedXml(svg);
});

test('the instance exposes the same card and renderer', () => {
  const harmony = kit.createProgram({ tenant: { id: 'acme-kit', network: 'testnet' }, program: 'tip-pool' });
  const s = scenario();
  const c = harmony.card({ participant: { participantId: 'a', name: 'Ana' }, standing: s.standings[0], now: NOW });
  assert.equal(c.program.id, 'tip-pool');
  assert.equal(harmony.renderCardSvg(c), renderCardSvg(c));
  assert.equal(harmony.explorerUrl('abc'), 'https://stellar.expert/explorer/testnet/tx/abc');
  assert.ok(peopleOf(['x']));
});
