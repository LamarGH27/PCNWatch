# Legal reference review

PCNWatch states no proposition of law that a qualified person has not approved.
This is how a proposition gets from a source document into the product.

## The shape of it

A **candidate proposition** answers one question, names the document and
provision it would have to come from, and says what it must *not* be read as
establishing. It is prepared by whoever is building the feature — including a
model — and it is inert until a reviewer decides on it.

`isApproved` in `src/core/reference/candidates/store.ts` is the whole safety
model. A candidate is usable only when all of these hold:

1. A person recorded `decision: 'REVIEWED'`.
2. That person is **named**. `reviewer: null` is not an approval.
3. The source was actually opened — `retrieval: 'RETRIEVED'` with a
   `retrievedAt` date.
4. An `excerpt` was recorded from the source.
5. Nothing supersedes it.
6. The source **tier** is competent to establish that **kind** of proposition.

Conditions 3 and 4 exist because condition 1 is a field a script could set.
Requiring evidence that somebody read the document is what makes the decision
mean something.

Condition 6 is the distinction the bundle is organised around: an authority's
own policy page is authoritative about that authority's practice and cannot
become a statutory ground however it is worded.

## Source tiers

| Tier | May establish |
| --- | --- |
| `PRIMARY_LEGISLATION` | `STATUTORY_GROUND`, `STATUTORY_GROUND_INTERPRETATION`, `PROCEDURE`, `DEADLINE_RULE` |
| `STATUTORY_INSTRUMENT` | `STATUTORY_GROUND`, `STATUTORY_GROUND_INTERPRETATION`, `PROCEDURE`, `DEADLINE_RULE` |
| `LONDON_COUNCILS_FRAMEWORK` | `CONTRAVENTION_DEFINITION`, `CONTRAVENTION_METADATA` |
| `ISSUING_AUTHORITY_POLICY` | `AUTHORITY_POLICY`, `PROCEDURE` |
| `TRIBUNAL` | `PROCEDURE`, `DEADLINE_RULE` |

`STATUTORY_GROUND_INTERPRETATION` is not a ground and the distinction is a safety
boundary rather than a taxonomy preference. `hasApprovedStatutoryGround` keys on
`STATUTORY_GROUND`, so a proposition whose purpose is to *narrow* what may be said —
"the already-paid ground means the penalty, not the parking charge" — would have
switched statutory drafting **on** when approved. A guard that unlocks the thing it
guards is worse than no guard.

There is no tier for a blog, a forum, a solicitor's marketing page or a model's
recollection, so there is no way to record one as the basis of an approved
proposition.

## Reviewing

```
npm run review:list                # everything still to decide, in the terminal
npx tsx scripts/review-bundle.ts --all      # including decided ones
npx tsx scripts/review-bundle.ts --usable   # what PCNWatch may actually say

npm run review:pack                # regenerate docs/legal-review-bundle.md
```

`docs/legal-review-bundle.md` is the document a reviewer actually works through:
every candidate with its source, provision, applicability, constraints, the question
being asked, and blank boxes for the excerpt, comments, decision and signature. It is
generated from the candidates so it cannot drift from them, and a test fails if the
committed copy is stale.

The nine propositions on the critical path for the launch scenario appear first, under
**Initial Launch Review**.

For each candidate the worklist prints the proposition, the document and
provision to open, the question you are being asked, and what the proposition
must not be read as establishing.

### Recording a decision

Edit the candidate's `review` block and its `source` provenance, and commit.

```ts
review: {
  decision: 'REVIEWED',          // or REJECTED / NEEDS_CHANGE
  reviewer: 'A. Solicitor',      // your name, not an organisation
  decidedAt: '2026-03-14',
  note: 'Wording checked against the provision as in force at this date.',
},
source: {
  ...
  retrieval: 'RETRIEVED',
  retrievedAt: '2026-03-14',
  excerpt: '…',                  // short. enough to recognise the provision.
},
```

This is a code change on purpose. It goes through the same review as any other
change, it is attributable in the history, and it cannot be done by anything
that can write to the database.

**Four decisions, not two.** `REJECTED` and `NEEDS_CHANGE` are both "not
approved" to every consumer, and they mean different things to the next person
picking the work up: one says the proposition is wrong, the other says it is
nearly right.

### Keeping excerpts short

Enough for a reviewer to recognise the provision. Not a copy of the instrument.

## What approval changes

Approval is granular. Approving one proposition makes exactly that proposition
usable, in exactly the scenario its `applicability` describes.

- Approving the code 12 definition says nothing about code 23.
- Approving a Westminster policy does not carry to Camden.
- Approving one statutory ground does not enable the other grounds.
- Approving a ground does not approve a deadline period.

`buildLegalPosition` asks `applicableApproved(scenario, 'STATUTORY_GROUND')`
rather than whether anything anywhere has been reviewed — so the first approval
cannot turn legal drafting on across the whole product.

## The current bundle

`src/core/reference/candidates/code-12-westminster.ts` — London parking PCN,
code 12, Westminster, paid by app, registration possibly wrong.

Every candidate is `PENDING_LEGAL_REVIEW` and every `excerpt` is `null`. The
environment the bundle was prepared in could not reach legislation.gov.uk,
londoncouncils.gov.uk or westminster.gov.uk, so **no source was opened and no
source text was read**. The candidates name the documents and provisions
precisely enough for a reviewer to open them, and stop there.

Until they are approved, PCNWatch's Defence Pack argues facts and says in as
many words that it is not establishing a legal ground. That is the intended
state, not a degraded one.
