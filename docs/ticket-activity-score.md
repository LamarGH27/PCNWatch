# Ticket Activity Score

A 0–100 measure of **relative historic enforcement intensity within the data
FineRadar holds**. It is not a probability, a likelihood, a chance of a fine, or
anything equivalent, and the product must never describe it as one.

The approved wording, rendered verbatim wherever a score appears:

> The Ticket Activity Score compares historical PCN enforcement activity within
> available FineRadar data. It does not predict whether you will receive a ticket
> and does not determine whether parking is permitted.

Implementation: `src/core/scoring/`. Weights and thresholds:
`src/core/scoring/config.ts`. Tests: `tests/core/ticket-activity-score.test.ts`.

---

## Review of the proposed weighting

The brief proposed:

```
45% historical volume percentile
20% recent activity percentile
15% current/selected time-window concentration
10% recent trend
10% data quality/confidence
```

and asked for it to be checked mathematically before implementation. Four
problems, one of them serious.

### 1. Data quality as an additive term is wrong (serious)

If confidence contributes 10 points of *score*, then a well-evidenced quiet
street and a poorly-evidenced busy street can land on the same number while
meaning entirely different things. Worse, a location scores higher for being
well-recorded — which is not enforcement intensity, it is a property of the
dataset.

Confidence answers "how much should you trust this number", not "how intense is
enforcement here". Those are different axes and adding them together destroys
both.

**Change:** confidence is not a component. It acts in two places instead:

- **A gate.** Below `minDataConfidence` (0.4) the location is not scored at all
  and returns `INSUFFICIENT_SOURCE_QUALITY`. This is what the brief means by
  "do not calculate scores for records where source quality is inadequate".
- **Shrinkage.** The final score is pulled toward the population median in
  proportion to confidence:

  ```
  final = median + (raw − median) × confidence
  ```

  A location we are unsure about regresses toward "Moderate" rather than making a
  strong claim in either direction. A confident location keeps its raw score.

Confidence is then displayed separately, as its own figure, which is where a user
can actually act on it.

Tested by `never treats data confidence as enforcement intensity` — lowering
confidence on a high-activity location must *reduce* its score, and lowering it on
a low-activity location must *raise* it.

### 2. Time-window concentration is contextual, not intrinsic

A street with 10 PCNs all issued at 09:00 is highly *concentrated* but not
intense. Making concentration a permanent 15% rewards peaky quiet streets over
consistently busy ones.

Concentration only means something relative to a window the user has selected.

**Change:** the window component contributes only when a time or day filter is
active. When no filter is applied its weight is redistributed proportionally
across the remaining components, so the weights always sum to 1 rather than
silently summing to 0.85.

Tested by `redistributes the window weight when no time filter is active` and
`applies the window component when a time filter is active`.

### 3. Trend on small counts is noise

1 → 3 PCNs is a 200% increase and means nothing. Left undamped, the trend term
makes the quietest locations the most volatile.

**Change:** the trend ratio is shrunk toward neutral by an empirical-Bayes weight
`n / (n + k)` with `k = 12` pseudo-counts. A location with 100 observations keeps
almost all of its measured trend; one with 4 keeps a quarter of it.

Tested by `damps trend for locations with very few observations`.

### 4. Raw volume percentile ignores recency

45% on all-time volume means a street heavily enforced three years ago and never
since ranks alongside one enforced heavily last month.

**Change:** the volume component uses **recency-weighted** volume — each monthly
bucket is weighted `0.5 ^ (monthsAgo / 9)`, so activity nine months old counts
half as much as this month's. The separate recent-activity component still exists
and is still collinear with it; that collinearity is deliberate, expressing "busy,
and busy lately" rather than either alone.

---

## The implemented model

```
raw   = 100 × ( V·w_v + R·w_r + W·w_w + T·w_t )
final = round( median(raw) + (raw − median(raw)) × confidence )
```

| Component | Symbol | Weight (filter active) | Weight (no filter) |
| --- | --- | --- | --- |
| Recency-weighted volume percentile | V | 0.50 | 0.625 |
| Recent-activity percentile (3 months) | R | 0.20 | 0.250 |
| Selected-window concentration | W | 0.20 | 0 |
| Recent trend | T | 0.10 | 0.125 |

**V** — midrank percentile of `Σ count_b × 0.5^(monthsAgo_b / 9)` across all
eligible locations in the comparison population.

**R** — midrank percentile of PCN count in the last 3 months.

**W** — the share of a location's activity falling inside the selected window,
divided by the share expected if activity were spread uniformly. A lift of 1.0
maps to 0.5 (neutral), 2.0 or above maps to 1.0. Shrunk toward neutral by
observation count.

**T** — recent 6 months against the previous 6, mapped the same way and shrunk the
same way.

### Why midrank percentile

"Fraction strictly below" gives every member of a uniform population a percentile
of 0, which would make an entire borough read as Very Low. Midrank (average rank
for ties) gives 0.5, which is the honest answer: no location in that population is
distinguishable from any other.

### Classification bands

| Score | Classification |
| --- | --- |
| 0–19 | Very Low |
| 20–39 | Low |
| 40–59 | Moderate |
| 60–79 | High |
| 80–100 | Very High |

---

## When a score is refused

No score is produced, and the reason is shown instead of a number:

| Reason | Condition |
| --- | --- |
| `NO_GEOMETRY` | The location has no verified position |
| `INSUFFICIENT_SOURCE_QUALITY` | `dataConfidence < 0.4` |
| `INSUFFICIENT_OBSERVATIONS` | Fewer than 5 recorded PCNs |
| `NO_COMPARISON_POPULATION` | Fewer than 5 eligible locations to rank against |

A refusal is persisted as a row in `pcn_activity_scores` carrying its reason. No
row would be indistinguishable from "not computed yet", and the UI needs to
explain the absence.

---

## Determinism

`computeTicketActivityScores` is a pure function of `(inputs, asOf, config)`. It
reads no clock — `asOf` is required — and produces identical output for identical
input regardless of the order locations are supplied in. Both properties are
tested.

The stored `model_version` (`tas-1.0.0`) records which version produced a score.
**Any change to the weights or thresholds must bump it**, because a persisted
score is only reproducible against the config that made it.

---

## Comparison population

Percentiles are relative to the eligible members of the input set. The caller must
pass a genuinely comparable set — all scored locations in one authority for one
period — not an arbitrary subset. Passing a filtered subset would silently change
what every percentile means.
