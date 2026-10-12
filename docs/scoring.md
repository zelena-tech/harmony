# Scoring

All formulas live in `packages/core/src/scoring/*` and `packages/core/src/period.js`.
They are pure functions; every number below is covered by a test in
`packages/core/test/`.

## 1. Base points

```
basePoints = picking × pointsPerPicking + packing × pointsPerPacking     (defaults 10 / 10)
```

`picking` and `packing` are orders **completed** by the worker in the period.

## 2. Performance component (0-100)

```
perHour     = completed / (activeSeconds / 3600)
velocity    = min(100, round(perHour / max(perHour of the team) × 100))   — 75 when nobody has time data
precision   = min(100, round(completed / started × 100))                  — 100 when nothing was started
performance = round(velocity × velocityWeight + precision × precisionWeight)   (defaults 0.5 / 0.5)
```

Velocity is relative to the best worker of the same period, so it rewards
being fast compared with the team, not against an absolute standard.

## 3. Other components (0-100, optional)

| Component | Formula | Missing when |
|---|---|---|
| Attendance | `round(min(1, daysWorked / workingDays) × 100 × 0.6 + min(1, utilization) × 100 × 0.4)`; attendance alone when utilization is unknown | attendance tracking is disabled or there is no data |
| Leader evaluation | weighted mean of grades 1-10 by criterion weight, × 10 | the leader did not grade the worker |

`workingDays` excludes Sundays and the holidays passed by the host.

## 4. Final score and adjusted points

```
finalScore     = Σ score_i × weight_i / Σ weight_i     over the components that are present
adjustedPoints = round(basePoints × finalScore / 100)
```

Default weights: performance 0.5, attendance 0.2, evaluation 0.3. A missing
component never penalizes: its weight is redistributed among the others.

## 5. Inventory campaigns (quality rule)

Effort is the number of **lines** (product + location) each person counted,
compared with the agreed result of the cross-count:

| Line outcome | Counts as |
|---|---|
| the person's number equals the consensus, or the line was discarded and the person entered 0 | correct |
| different number, a discarded line with a non-zero count, or a record voided by a supervisor | wrong |
| no consensus yet | not evaluated |

```
lineWeight = 1 + log10(max(1, units))           1 → 1, 10 → 2, 100 → 3, 10 000 → 5
points     = max(0, round(Σ weight(correct) − penalty × Σ weight(wrong)))     penalty = 2
precision  = correct / (correct + wrong)
eligible   = evaluated lines > 0 and precision ≥ minPrecision                  minPrecision = 0.9
```

In an inventory campaign `adjustedPoints = points` when eligible and `0`
otherwise; the person stays visible in the ranking with its points.

## 6. Top-N and fund share

```
qualified   = the N workers with the highest adjustedPoints (N = null → everybody)
fundShare   = adjustedPoints / Σ adjustedPoints of the qualified     (0 for the rest)
assigned    = round7(fundShare × fundTotal)
```

Ties keep the order of the input (the host should pass a stable order, e.g. by id).
Top-N and the per-campaign weight overrides only apply to inventory campaigns;
order campaigns always share among everybody with the tenant weights.

## 7. Encoding a campaign on-chain

The Organization contract splits a fund by `worker points / total points`.
For an inventory campaign each participant gets one task, and
`inventoryMultipliersBp` sets its review multiplier to

```
bp = qualified && points > 0 ? clamp(round(points / maxPoints × 20000), 1, 20000) : 0
```

so the on-chain shares reproduce the off-chain ones (to 4 decimals with a
shared `base_points`) and whoever did not qualify cannot claim.
