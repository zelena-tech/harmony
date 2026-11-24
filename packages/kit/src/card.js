'use strict';

const { explorerUrl } = require('./submit');

/**
 * The Harmony Card: what one person earned in one period, in a form they can
 * keep and show. It is plain JSON plus an SVG rendering; it holds no secret
 * and no full wallet address, only the transaction hashes that prove the
 * payment on the public ledger.
 */

const short = (w) => (typeof w === 'string' && w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : null);
const iso = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);

/**
 * @param {object} program
 * @param {object} tenant
 * @param {object} input
 * @param {{participantId: string, name?: string, wallet?: string}} input.participant
 * @param {object} input.standing   the person's row of score().standings
 * @param {number} [input.of]       how many people took part
 * @param {object} [input.payment]  the person's row of plan().payments
 * @param {object} [input.receipt]  submit() result; without it the card is a preview
 * @param {string} [input.period]   label, e.g. "Week 47"
 * @param {number} [input.now]      unix seconds
 */
function card(program, tenant, { participant, standing, of, payment, receipt, period, now = Math.floor(Date.now() / 1000) }) {
  const id = String(participant.participantId);
  const mine = (receipt ? receipt.transactions : []).flatMap((t) => t.operations
    .filter((o) => String(o.participantId) === id)
    .map((o) => ({ ...o, hash: t.hash })));
  const byPocket = new Map(mine.map((o) => [o.pocketId, o]));

  const pockets = (payment ? payment.pockets : []).map((k) => {
    const op = byPocket.get(k.id);
    let status = 'planned';
    if (op) {
      if (op.kind === 'payment') status = 'paid';
      else if (op.kind === 'unlocks') status = now >= op.claimableFrom ? 'claimable' : 'locked';
      else if (op.kind === 'expires') status = now < op.claimableUntil ? 'claimable' : 'expired';
      else status = 'waiting';
    }
    return {
      id: k.id,
      label: k.label,
      amount: k.amount,
      rule: k.rule.type,
      date: iso(k.rule.at),
      status,
      balanceId: op ? op.balanceId : null,
    };
  });

  const hashes = [...new Set(mine.map((o) => o.hash))];
  return {
    version: 1,
    kind: 'harmony-card',
    issuedAt: new Date(now * 1000).toISOString(),
    preview: !receipt,
    network: tenant.network,
    organization: tenant.id,
    program: { id: program.id, name: program.name, industry: program.industry },
    period: period || null,
    participant: { id, name: participant.name || id, wallet: short(participant.wallet) },
    level: {
      id: standing.level.id,
      name: standing.level.name,
      step: standing.level.step,
      steps: standing.level.steps,
      multiplier: standing.level.multiplier,
      next: standing.levelAfter.next,
      promotedTo: standing.levelAfter.id !== standing.level.id ? standing.levelAfter.name : null,
    },
    points: { earned: standing.earnedPoints, adjusted: standing.adjustedPoints, lifetime: standing.lifetimeAfter },
    rank: standing.rank,
    of: of || null,
    reward: payment
      ? { asset: tenant.rewardAsset.code, total: payment.amount, pockets }
      : null,
    proofs: hashes.map((hash) => ({ hash, url: explorerUrl(tenant.network, hash) })),
    planId: receipt ? receipt.planId : null,
  };
}

// ── SVG rendering ────────────────────────────────────────────────────────────

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clip = (s, n) => { const t = String(s || ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const money = (a) => { const n = Number(a); return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

/** One gradient per rung of the ladder, from the first level to the top one. */
const PALETTE = [
  ['#3b4a63', '#1f2a3d', '#9fb3d1'],
  ['#0f766e', '#0b3b46', '#7fe3d2'],
  ['#4f46e5', '#27215f', '#b9b5ff'],
  ['#b7791f', '#5c3508', '#ffd98a'],
  ['#16161d', '#000000', '#c6f432'],
];
function paletteFor(step, steps) {
  if (steps <= 1) return PALETTE[1];
  return PALETTE[Math.round(((step - 1) / (steps - 1)) * (PALETTE.length - 1))];
}

const STATUS_LABEL = { paid: 'paid', claimable: 'ready to claim', locked: 'locked until', expired: 'expired', waiting: 'waiting for you', planned: 'planned' };

/**
 * Renders a card as a standalone SVG (680 x 420, no external fonts or images).
 * Every piece of text is escaped: names come from the host and are not trusted.
 *
 * @param {object} c  card() result
 * @returns {string}
 */
function renderCardSvg(c) {
  const [from, to, accent] = paletteFor(c.level.step, c.level.steps);
  const dots = Array.from({ length: c.level.steps }, (_, i) => {
    const on = i < c.level.step;
    return `<circle cx="${52 + i * 18}" cy="196" r="5" fill="${on ? accent : 'none'}" stroke="${accent}" stroke-width="1.5"/>`;
  }).join('');

  const pockets = c.reward ? c.reward.pockets : [];
  const total = pockets.reduce((s, k) => s + Number(k.amount), 0) || 1;
  // Proportional pieces of at least 6 px; whatever the minimum adds is taken
  // from the widest piece so the whole bar always fits in 600 px.
  const GAP = 4;
  const avail = 600 - GAP * Math.max(0, pockets.length - 1);
  const widths = pockets.map((k) => Math.max(6, Math.round((Number(k.amount) / total) * avail)));
  const over = widths.reduce((s, v) => s + v, 0) - avail;
  if (over > 0) widths[widths.indexOf(Math.max(...widths))] -= over;
  let x = 40;
  const bar = pockets.map((k, i) => {
    const rect = `<rect x="${x}" y="286" width="${widths[i]}" height="10" rx="5" fill="${accent}" opacity="${(1 - i * 0.22).toFixed(2)}"/>`;
    x += widths[i] + GAP;
    return rect;
  }).join('');
  const colW = pockets.length ? Math.floor(600 / pockets.length) : 600;
  const labels = pockets.map((k, i) => {
    const px = 40 + i * colW;
    const note = k.status === 'locked' || (k.status === 'planned' && k.date) ? `${STATUS_LABEL[k.status] || k.status} ${k.date || ''}`.trim()
      : k.status === 'claimable' && k.rule === 'expires' ? `claim before ${k.date}` : (STATUS_LABEL[k.status] || k.status);
    return `<text x="${px}" y="320" class="s b">${esc(clip(k.label, Math.max(8, Math.floor(colW / 8))))}</text>`
      + `<text x="${px}" y="340" class="m">${esc(money(k.amount))} ${esc(c.reward.asset)}</text>`
      + `<text x="${px}" y="357" class="t">${esc(clip(note, Math.max(10, Math.floor(colW / 6.5))))}</text>`;
  }).join('');

  const proof = c.proofs[0] ? `tx ${c.proofs[0].hash.slice(0, 10)}…${c.proofs[0].hash.slice(-8)}` : (c.preview ? 'preview · not paid yet' : '');
  const rank = c.of ? `#${c.rank} of ${c.of}` : `#${c.rank}`;
  const next = c.level.promotedTo ? `Promoted to ${c.level.promotedTo}`
    : c.level.next ? `${c.level.next.pointsToGo.toLocaleString('en-US')} pts to ${c.level.next.name}` : 'Top level';

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 420" width="680" height="420" role="img"',
    ` aria-label="${esc(`Harmony Card of ${c.participant.name}`)}">`,
    '<defs>',
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`,
    '<style>',
    'text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;fill:#fff}',
    '.k{font-size:11px;letter-spacing:2.2px;opacity:.72}.n{font-size:28px;font-weight:700}.l{font-size:15px;font-weight:600}',
    '.h{font-size:40px;font-weight:800}.s{font-size:12px}.b{font-weight:700}.m{font-size:14px;font-weight:600}',
    '.t{font-size:11px;opacity:.75}.x{font-size:11px;opacity:.7;font-family:ui-monospace,Menlo,Consolas,monospace}',
    '</style>',
    '</defs>',
    '<rect width="680" height="420" rx="28" fill="url(#g)"/>',
    `<circle cx="590" cy="70" r="150" fill="${accent}" opacity=".07"/><circle cx="640" cy="330" r="110" fill="${accent}" opacity=".06"/>`,
    `<text x="40" y="52" class="k">STELLAR HARMONY</text>`,
    `<text x="640" y="52" class="k" text-anchor="end">${esc(clip((c.program.name || '').toUpperCase(), 34))}</text>`,
    `<text x="40" y="112" class="n">${esc(clip(c.participant.name, 28))}</text>`,
    `<text x="40" y="136" class="s" opacity=".8">${esc(clip([c.organization, c.period].filter(Boolean).join(' · '), 60))}</text>`,
    `<text x="40" y="178" class="l" style="fill:${accent}">${esc(clip(c.level.name, 22))} · x${esc(c.level.multiplier)}</text>`,
    dots,
    `<text x="${52 + c.level.steps * 18 + 6}" y="200" class="t">${esc(next)}</text>`,
    `<text x="640" y="112" class="h" text-anchor="end">${esc(c.reward ? money(c.reward.total) : c.points.adjusted.toLocaleString('en-US'))}</text>`,
    `<text x="640" y="136" class="s" text-anchor="end" opacity=".8">${esc(c.reward ? `${c.reward.asset} earned` : 'points')}</text>`,
    `<text x="640" y="178" class="l" text-anchor="end">${esc(rank)}</text>`,
    `<text x="640" y="200" class="t" text-anchor="end">${esc(c.points.adjusted.toLocaleString('en-US'))} pts · ${esc(c.points.lifetime.toLocaleString('en-US'))} lifetime</text>`,
    '<line x1="40" y1="232" x2="640" y2="232" stroke="#fff" stroke-opacity=".18"/>',
    `<text x="40" y="266" class="k">POCKETS</text>`,
    bar,
    labels,
    `<text x="40" y="394" class="x">${esc(proof)}</text>`,
    `<text x="640" y="394" class="x" text-anchor="end">${esc(c.network)}${c.participant.wallet ? ` · ${esc(c.participant.wallet)}` : ''}</text>`,
    '</svg>',
  ].join('');
}

module.exports = { card, renderCardSvg };
