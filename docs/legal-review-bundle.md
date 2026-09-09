# PCNWatch — legal reference review pack

<!--
  GENERATED FILE. Do not edit by hand.
    npx tsx scripts/review-bundle-markdown.ts
  It is generated from the candidate propositions so it cannot drift from
  them, and a test fails if the committed copy is stale.
-->

This is the document a qualified reviewer works through. Every proposition below is a
candidate: something PCNWatch would like to be able to say, the document it would have to
come from, and what it must not be read as establishing.

**Nothing here is approved.** Until a proposition is reviewed, PCNWatch states no
legal ground and the Defence Pack argues facts. That is the intended state.

## Where the bundle stands

| | |
| --- | --- |
| Candidate propositions | 14 |
| `PENDING_LEGAL_REVIEW` | 14 |
| Source not yet opened | 14 |
| **Usable by PCNWatch** | **0** |

## Before you start

No source in this pack has been opened. The environment the candidates were prepared in
could not reach legislation.gov.uk, londoncouncils.gov.uk, westminster.gov.uk or
londontribunals.gov.uk, so **every excerpt is blank and no source text has been read**.

That is deliberate. An invented excerpt is the single most dangerous artefact this
project could produce, because it would look exactly like evidence that somebody
checked. The candidates name the document and provision precisely enough for you to
open them, and stop there.

A proposition becomes usable only when **all** of these hold:

1. You recorded `decision: REVIEWED`.
2. You are **named**. `reviewer: null` is not an approval.
3. The source was opened — `retrieval: RETRIEVED` with a date.
4. An `excerpt` was recorded from the source.
5. Nothing supersedes it.
6. The source **tier** is competent to establish that **kind** of proposition.

Conditions 3 and 4 exist because condition 1 is a field a script could set.

## Initial Launch Review

The 10 propositions on the critical path to a Defence Pack for the launch
scenario: a London local-authority parking PCN, contravention code 12, paid through a
parking app, registration possibly entered incorrectly, issued by Westminster.

### 1. `CAND-CODE12-DEFINITION`

**Classification** `CONTRAVENTION_DEFINITION` — What the code alleges

| | |
| --- | --- |
| Organisation | London Councils |
| Document | Parking contravention codes used by London enforcement authorities |
| Canonical URL | <https://www.londoncouncils.gov.uk/services/parking-services/parking-and-traffic/contravention-codes> |
| Provision | Code 12 |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `LONDON_COUNCILS_FRAMEWORK` — may establish: CONTRAVENTION_DEFINITION, CONTRAVENTION_METADATA |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> Code 12 describes parking in a residents’ or shared-use parking place or zone without the required valid virtual or physical permit, voucher, pay-and-display ticket, or payment of the parking charge.

**Applicability**

- Contravention codes: 12
- Authority: Any
- Notice types: Any
- Procedural stages: Any
- London local-authority parking PCNs only.
- Do not infer from the code alone that the allegation is proven.

**Must not be read as establishing**

- That the contravention occurred. The code records what the authority alleges, and nothing more.
- That the vehicle was in fact parked without a valid permit or payment.
- Any ground of representation, and any entitlement to cancellation.
- What any suffix letter denotes. Each suffix is a separate candidate against a separate table.
- That the underlying traffic order was valid, or that the bay was correctly signed.

**Question for the reviewer**

> Open the London Councils contravention code list and confirm the current wording of code 12 against this statement. Record the exact wording. Reject if the code has been reworded, split, or withdrawn.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 2. `CAND-CODE12-SUFFIXES`

**Classification** `CONTRAVENTION_METADATA` — What a suffix denotes

| | |
| --- | --- |
| Organisation | London Councils |
| Document | Parking contravention codes used by London enforcement authorities |
| Canonical URL | <https://www.londoncouncils.gov.uk/services/parking-services/parking-and-traffic/contravention-codes> |
| Provision | Code-specific suffix table — suffix "x" (codes 01, 12, 16, 19, 85) |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `LONDON_COUNCILS_FRAMEWORK` — may establish: CONTRAVENTION_DEFINITION, CONTRAVENTION_METADATA |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> For permit contraventions including codes 01, 12, 16, 19 and 85, the code-specific suffix "x" means an incorrect vehicle registration mark.

**Applicability**

- Contravention codes: 01, 12, 16, 19, 85
- Authority: Any
- Notice types: Any
- Procedural stages: Any
- London local-authority parking PCNs only.
- Permit contraventions only. The suffix is code-specific, so its meaning outside codes 01, 12, 16, 19 and 85 is not covered by this candidate.
- PCNWatch currently declines to interpret a suffix at all and says so. This candidate exists to replace that silence with one enumerated meaning, not to license inference from it.

**Must not be read as establishing**

- That payment was made. The suffix records what the authority alleges about the registration, not what the motorist did.
- That the contravention did not occur. Whether it occurred is a question of fact for the authority and, on appeal, the adjudicator.
- That the notice must be cancelled, or that cancellation follows from the suffix being present.
- Any statutory ground of representation or appeal.
- That the authority is obliged to search for a payment made against a different registration.

**Question for the reviewer**

> Open the London Councils code and suffix framework and confirm that "x" is a code-specific suffix meaning incorrect VRM, and that it is in current use with each of codes 01, 12, 16, 19 and 85. Record the exact table wording. Reject if the suffix has been withdrawn, if it means something different for any of those codes, or if the list of codes it applies to is not as stated — a suffix that means one thing on code 12 and another on code 19 is two propositions, not one.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 3. `CAND-CODE12-ELECTRONIC-PAYMENT`

**Classification** `CONTRAVENTION_METADATA` — What a suffix denotes

| | |
| --- | --- |
| Organisation | London Councils |
| Document | Parking contravention codes used by London enforcement authorities |
| Canonical URL | <https://www.londoncouncils.gov.uk/services/parking-services/parking-and-traffic/contravention-codes> |
| Provision | General suffix table, suffix "u" |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `LONDON_COUNCILS_FRAMEWORK` — may establish: CONTRAVENTION_DEFINITION, CONTRAVENTION_METADATA |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> The general suffix "u" denotes electronic payment.

**Applicability**

- Contravention codes: Any
- Authority: Any
- Notice types: Any
- Procedural stages: Any
- London local-authority parking PCNs only.
- A general suffix is not confined to one code, so the reviewer should confirm its scope rather than assume this bundle’s code-12 framing.

**Must not be read as establishing**

- That a valid parking session existed. The suffix records the payment method involved, not that payment succeeded.
- That any payment was made against the correct vehicle.
- That any payment covered the correct location.
- That any payment covered the correct time or period.
- Any entitlement to cancellation, and any statutory ground — in particular not the ground concerning payment of the penalty charge.
- How an enforcement officer verifies electronic payment or virtual permit status against a registration. That mechanism would need its own candidate, from a source that states it.

**Question for the reviewer**

> Open the London Councils code and suffix framework and confirm that "u" is a general suffix denoting electronic payment. Record the exact table wording. Reject if it is code-specific rather than general, or denotes something else. Note for the record which codes a general suffix may accompany.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 4. `CAND-WCC-INDIVIDUAL-MERITS`

**Classification** `AUTHORITY_POLICY` — Authority policy (discretionary)

| | |
| --- | --- |
| Organisation | Westminster City Council |
| Document | Consideration of parking ticket challenges |
| Canonical URL | <https://www.westminster.gov.uk/parking/challenge-your-parking-ticket/consideration-parking-ticket-challenges> |
| Provision | Merits of the case |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `ISSUING_AUTHORITY_POLICY` — may establish: AUTHORITY_POLICY, PROCEDURE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> Westminster City Council states that the circumstances surrounding a particular PCN are unique and each PCN should be considered on its own merits.

**Applicability**

- Contravention codes: Any
- Authority: westminster
- Notice types: Any
- Procedural stages: Any
- Westminster only. Not to be generalised to other London authorities.

**Must not be read as establishing**

- Any statutory right to cancellation. The council saying it will look at a case on its merits is a statement about how it decides, not about what a motorist is entitled to.
- That Westminster will cancel any particular notice, or that a challenge on the merits will succeed.
- That an adjudicator applies the same approach. An adjudicator’s powers are narrower than an authority’s discretion.
- Any statutory ground of representation or appeal.
- That any other authority says or does the same.

**Question for the reviewer**

> Find and confirm the published Westminster statement to this effect, and record where it appears. If Westminster publishes no such statement, REJECT rather than substituting a general expectation about how authorities behave.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 5. `CAND-WCC-GENUINE-MISTAKE`

**Classification** `AUTHORITY_POLICY` — Authority policy (discretionary)

| | |
| --- | --- |
| Organisation | Westminster City Council |
| Document | Consideration of parking ticket challenges |
| Canonical URL | <https://www.westminster.gov.uk/parking/challenge-your-parking-ticket/consideration-parking-ticket-challenges> |
| Provision | Genuine mistakes, mitigation and discretion |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `ISSUING_AUTHORITY_POLICY` — may establish: AUTHORITY_POLICY, PROCEDURE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> Westminster City Council states that discretion can be given where it is evident that the motorist made an honest attempt to park legally and correctly but made a genuine mistake and incurred the PCN in doing so.

**Applicability**

- Contravention codes: Any
- Authority: westminster
- Notice types: Any
- Procedural stages: Any
- Westminster only.

**Must not be read as establishing**

- That a mistaken registration entry is a genuine mistake within the policy. That is the authority’s judgement on the facts, not something this proposition decides.
- That cancellation is mandatory, or that the policy obliges Westminster to cancel anything.
- That any particular result is guaranteed.
- That an adjudicator would take the same view. An adjudicator’s powers are narrower than an authority’s discretion.
- Any statutory ground. Discretion and entitlement are different things and this bundle keeps them apart.

**Question for the reviewer**

> Confirm whether Westminster publishes such a policy and record its actual terms and any stated conditions. This is the proposition closest to the paid-by-app scenario and the easiest to overstate: confirm the words, and confirm they describe discretion rather than entitlement.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 6. `CAND-WCC-EVIDENCE-CONSIDERED`

**Classification** `AUTHORITY_POLICY` — Authority policy (discretionary)

| | |
| --- | --- |
| Organisation | Westminster City Council |
| Document | Consideration of parking ticket challenges |
| Canonical URL | <https://www.westminster.gov.uk/parking/challenge-your-parking-ticket/consideration-parking-ticket-challenges> |
| Provision | Full consideration of evidence and the 'balance of probabilities' |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `ISSUING_AUTHORITY_POLICY` — may establish: AUTHORITY_POLICY, PROCEDURE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> Westminster City Council states that all relevant evidence should be fully considered and decisions should be based on the weight of the evidence.

**Applicability**

- Contravention codes: Any
- Authority: westminster
- Notice types: Any
- Procedural stages: Any
- Westminster only.

**Must not be read as establishing**

- Any particular weight that will be given to any evidence.
- That providing evidence obliges the authority to cancel.

**Question for the reviewer**

> Confirm what Westminster publishes about submitting evidence with a challenge, including any format or deadline it states. PCNWatch tells users an authority will weigh their documents; confirm that is what Westminster actually says.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 7. `CAND-TMA-GROUND-NO-CONTRAVENTION`

**Classification** `STATUTORY_GROUND` — Statutory ground

| | |
| --- | --- |
| Organisation | UK Parliament (legislation.gov.uk) |
| Document | The Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022 (S.I. 2022/576) |
| Canonical URL | <https://www.legislation.gov.uk/uksi/2022/576> |
| Provision | To be identified by the reviewer: the regulation and paragraph stating this ground |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `STATUTORY_INSTRUMENT` — may establish: STATUTORY_GROUND, STATUTORY_GROUND_INTERPRETATION, PROCEDURE, DEADLINE_RULE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> That the contravention did not occur is a statutory ground of representation and of appeal for a parking penalty charge notice.

**Applicability**

- Contravention codes: Any
- Authority: Any
- Notice types: NOTICE_TO_OWNER, PCN_POSTAL
- Procedural stages: NEW, NOTICE_TO_OWNER, FORMAL_REPRESENTATION
- Applies to an enforcement notice: a Notice to Owner, or a regulation 10 (postal) penalty charge notice.
- Not the regulation 9 windscreen PCN at the informal challenge stage.

**Must not be read as establishing**

- That the ground is available on the facts of any particular case. It must never be asserted merely because a user says "I paid for parking" or "I used RingGo" — those are accounts of what happened, and whether they mean the contravention did not occur is a question of fact for the authority and, on appeal, the adjudicator.
- That a payment made against a different registration means the contravention did not occur.
- That raising this ground obliges an authority to cancel.
- Any view about how likely the ground is to succeed.

**Question for the reviewer**

> Open S.I. 2022/576 and record the exact statutory wording of this ground, verbatim, together with the regulation and paragraph it sits in. London Tribunals' published grounds of appeal (https://www.londontribunals.gov.uk/) is a useful cross-check on how the ground is described in practice, but do not approve on the strength of it: a tribunal page is competent about how the tribunal runs, not about what the instrument says. This is the only ground the paid-by-app scenario would plausibly engage, so its wording matters more than any other candidate in this bundle.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 8. `CAND-TMA-GROUND-PAID-DISTINCTION`

**Classification** `STATUTORY_GROUND_INTERPRETATION` — Scope of a statutory ground (never itself a ground)

| | |
| --- | --- |
| Organisation | UK Parliament (legislation.gov.uk) |
| Document | The Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022 (S.I. 2022/576) |
| Canonical URL | <https://www.legislation.gov.uk/uksi/2022/576> |
| Provision | To be identified by the reviewer: the regulation stating the payment ground |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `STATUTORY_INSTRUMENT` — may establish: STATUTORY_GROUND, STATUTORY_GROUND_INTERPRETATION, PROCEDURE, DEADLINE_RULE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> The statutory ground that the penalty charge has already been paid refers to payment of the penalty charge itself, not payment for the underlying parking session.

**Applicability**

- Contravention codes: Any
- Authority: Any
- Notice types: NOTICE_TO_OWNER, PCN_POSTAL
- Procedural stages: NEW, NOTICE_TO_OWNER, FORMAL_REPRESENTATION
- Applies to an enforcement notice: a Notice to Owner, or a regulation 10 (postal) penalty charge notice.
- Not the regulation 9 windscreen PCN at the informal challenge stage.

**Must not be read as establishing**

- That paying for parking engages any ground. A user saying "I paid for parking" must never reach GROUND-ALREADY_PAID.
- That paying for parking is irrelevant. It is a factual matter, which is where PCNWatch already puts it.
- Any ground at all. This narrows a ground; approving it never makes one available. It is classified STATUTORY_GROUND_INTERPRETATION precisely so that it can never satisfy `hasApprovedStatutoryGround` and therefore can never itself enable `canStateGrounds`.

**Question for the reviewer**

> Confirm the wording of the payment-related ground. PCNWatch holds a record keyed GROUND-ALREADY_PAID; check whether it describes payment of the penalty or payment for parking. If it conflates the two, REJECT the existing record — a user who paid by app has not paid the penalty, and telling them otherwise would send a representation on a ground that does not apply.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 9. `CAND-MITIGATION-SEPARATE`

**Classification** `PROCEDURE` — Procedure

| | |
| --- | --- |
| Organisation | UK Parliament (legislation.gov.uk) |
| Document | The Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022 (S.I. 2022/576) |
| Canonical URL | <https://www.legislation.gov.uk/uksi/2022/576> |
| Provision | Regulation 5(2)(b)(i) and (ii) |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `STATUTORY_INSTRUMENT` — may establish: STATUTORY_GROUND, STATUTORY_GROUND_INTERPRETATION, PROCEDURE, DEADLINE_RULE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> A motorist may ask the enforcement authority to consider mitigation even where no statutory ground is established.

**Applicability**

- Contravention codes: Any
- Authority: Any
- Notice types: Any
- Procedural stages: Any
- This is the route the Westminster paid-by-app scenario actually takes today: facts and a request to reconsider, with no ground asserted.

**Must not be read as establishing**

- That mitigation is a statutory ground. It is the opposite: this candidate exists to hold the two apart, and it is classified PROCEDURE so that approving it can never make a ground available.
- That an authority must consider mitigation, or must cancel where it does.
- That an adjudicator has the same discretion an authority has. An adjudicator’s powers are narrower and that is a separate proposition.
- That the contravention did not occur.

**Question for the reviewer**

> Open S.I. 2022/576 regulation 5(2)(b)(i) and (ii) and confirm that a person may put circumstances to the authority alongside, or independently of, the grounds — and record the wording verbatim. London Tribunals (https://www.londontribunals.gov.uk/) describes the same thing in practice and is a useful cross-check, but it is not the source: a tribunal page is competent about how the tribunal runs, not about what the instrument says. Reject if mitigation turns out to be available only as an adjunct to an established ground.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 10. `CAND-DEADLINE-APPEAL-28D`

**Classification** `DEADLINE_RULE` — Deadline rule

| | |
| --- | --- |
| Organisation | UK Parliament (legislation.gov.uk) |
| Document | The Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022 (S.I. 2022/576) |
| Canonical URL | <https://www.legislation.gov.uk/uksi/2022/576> |
| Provision | Regulation 7(2) |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `STATUTORY_INSTRUMENT` — may establish: STATUTORY_GROUND, STATUTORY_GROUND_INTERPRETATION, PROCEDURE, DEADLINE_RULE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> An appeal against a decision rejecting representations must ordinarily be made within 28 days beginning with the date of service of the decision notice, or such longer period as the adjudicator may allow.

**Applicability**

- Contravention codes: Any
- Authority: Any
- Notice types: NOTICE_OF_REJECTION
- Procedural stages: NOTICE_OF_REJECTION, TRIBUNAL_ELIGIBLE, TRIBUNAL_APPEAL
- London civil parking enforcement.
- Independently reviewable: approving this rule must not release any other deadline, and approving any other deadline must not release this one.
- Separate from the deadline projection. `projectDeadlines` gates on its own rule store, so approving this candidate does not by itself put a calculated date in front of a user.

**Must not be read as establishing**

- Any period for making representations, or any discount period. Those are separate rules with separate triggers and separate candidates.
- That an appeal made outside the period will be refused. The adjudicator may allow a longer period, and PCNWatch must not tell anybody their appeal is out of time.
- The date on any particular notice of rejection.
- Any statutory ground, or anything about the merits of an appeal.

**Question for the reviewer**

> Open S.I. 2022/576 regulation 7(2) and confirm the period, the event it runs from, that it is "beginning with" rather than "from" that date, and how service is deemed to occur for each service method. Record the wording verbatim. Cross-check against London Tribunals (https://www.londontribunals.gov.uk/), but do not approve on the strength of the tribunal page alone. Approving this candidate does NOT release a calculated date to users: the deadline projection reads its own rule store, and that rule needs its own review.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

## Also awaiting review

4 further candidates. Real, and still undecided, but not on the critical path
for the launch scenario — they can be taken in a later sitting.

### 11. `CAND-TMA-REPS-STAGE`

**Classification** `PROCEDURE` — Procedure

| | |
| --- | --- |
| Organisation | UK Parliament (legislation.gov.uk) |
| Document | The Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022 (S.I. 2022/576) |
| Canonical URL | <https://www.legislation.gov.uk/uksi/2022/576> |
| Provision | Regulation 5 — representations against an enforcement notice |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `STATUTORY_INSTRUMENT` — may establish: STATUTORY_GROUND, STATUTORY_GROUND_INTERPRETATION, PROCEDURE, DEADLINE_RULE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> The statutory grounds of representation apply to representations made against an enforcement notice — a Notice to Owner or a regulation 10 penalty charge notice — and not to an informal challenge made before one has been served.

**Applicability**

- Contravention codes: Any
- Authority: Any
- Notice types: NOTICE_TO_OWNER, PCN_POSTAL
- Procedural stages: NEW, NOTICE_TO_OWNER, FORMAL_REPRESENTATION
- Applies to an enforcement notice: a Notice to Owner, or a regulation 10 (postal) penalty charge notice.
- Not the regulation 9 windscreen PCN at the informal challenge stage.

**Must not be read as establishing**

- That an informal challenge is pointless or that an authority will not consider one.
- The content of any individual ground.
- That the grounds attach to a regulation 9 windscreen PCN. They do not; that stage is the informal challenge.

**Question for the reviewer**

> Re-sourced from the Act to the instrument, and reworded. It previously said the grounds attach to a Notice to Owner, sourced to Traffic Management Act 2004 Schedule 1. Under S.I. 2022/576 representations are made against an *enforcement notice*, which is a Notice to Owner OR a regulation 10 penalty charge notice — so the old wording excluded every postal PCN. Confirm from regulation 5 which document representations attach to and how "enforcement notice" is defined, and record both verbatim. Also confirm the relationship between Schedule 1 and these Regulations — whether Schedule 1 remains the enabling provision, has been amended, or is simply the wrong place to look for this. This governs every other statutory candidate in the bundle: if the scope is wrong, they are all scoped wrongly.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 12. `CAND-TMA-GROUND-LIST`

**Classification** `STATUTORY_GROUND_INTERPRETATION` — Scope of a statutory ground (never itself a ground)

| | |
| --- | --- |
| Organisation | UK Parliament (legislation.gov.uk) |
| Document | The Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022 (S.I. 2022/576) |
| Canonical URL | <https://www.legislation.gov.uk/uksi/2022/576> |
| Provision | Regulation 5 — grounds for representations |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `STATUTORY_INSTRUMENT` — may establish: STATUTORY_GROUND, STATUTORY_GROUND_INTERPRETATION, PROCEDURE, DEADLINE_RULE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> Regulation 5 sets out an exhaustive list of grounds on which representations against an enforcement notice may be made.

**Applicability**

- Contravention codes: Any
- Authority: Any
- Notice types: NOTICE_TO_OWNER, PCN_POSTAL
- Procedural stages: NEW, NOTICE_TO_OWNER, FORMAL_REPRESENTATION
- Applies to an enforcement notice: a Notice to Owner, or a regulation 10 (postal) penalty charge notice.
- Not the regulation 9 windscreen PCN at the informal challenge stage.

**Must not be read as establishing**

- The wording of any individual ground.
- That any ground is available on the facts of any case.
- That an authority must accept a representation made on a listed ground.

**Question for the reviewer**

> Re-sourced from Traffic Management Act 2004 Schedule 1 to S.I. 2022/576 regulation 5, because that is where the grounds for representations now sit and pointing a reviewer at the Act would have them reading the enabling provision rather than the list. Enumerate the grounds as currently in force and confirm the list is exhaustive. PCNWatch holds eight ground records written before any review; check each against regulation 5 and record which are correctly stated, which need rewording, and which do not exist. Confirm at the same time whether Schedule 1 is superseded, amended, or still the parent provision for these Regulations — I could not open either document and the relationship between them is assumed, not checked.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 13. `CAND-DEADLINE-DISCOUNT-14D`

**Classification** `DEADLINE_RULE` — Deadline rule

| | |
| --- | --- |
| Organisation | UK Parliament (legislation.gov.uk) |
| Document | Traffic Management Act 2004 and the regulations made under it |
| Canonical URL | <https://www.legislation.gov.uk/ukpga/2004/18/schedule/1> |
| Provision | To be identified: the provision fixing the discount period and its trigger |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `PRIMARY_LEGISLATION` — may establish: STATUTORY_GROUND, STATUTORY_GROUND_INTERPRETATION, PROCEDURE, DEADLINE_RULE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> A penalty charge notice is payable at the discounted rate if paid within 14 days, and the period runs from a date fixed by statute rather than from the date the notice is received.

**Applicability**

- Contravention codes: Any
- Authority: Any
- Notice types: PCN_ON_STREET, PCN_POSTAL
- Procedural stages: Any
- London civil parking enforcement.

**Must not be read as establishing**

- The date on any particular notice.
- That a printed date on a notice is correct. PCNWatch shows printed dates because the user confirmed them, which is a different basis.
- Any period for making representations.

**Question for the reviewer**

> Confirm the period and, more importantly, the exact event it runs from — service, issue, or the date shown on the notice — and how service is deemed to occur for a postal notice. PCNWatch holds rule LDN-DISCOUNT-14D unreviewed; approving this candidate is what would let a calculated discount date be shown at all.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

### 14. `CAND-DEADLINE-REPS-28D`

**Classification** `DEADLINE_RULE` — Deadline rule

| | |
| --- | --- |
| Organisation | UK Parliament (legislation.gov.uk) |
| Document | Traffic Management Act 2004, Schedule 1 |
| Canonical URL | <https://www.legislation.gov.uk/ukpga/2004/18/schedule/1> |
| Provision | Schedule 1 — period for making representations |
| Jurisdiction | ENGLAND_LONDON |
| Source tier | `PRIMARY_LEGISLATION` — may establish: STATUTORY_GROUND, STATUTORY_GROUND_INTERPRETATION, PROCEDURE, DEADLINE_RULE |
| Retrieval | `NOT_RETRIEVED` — **nobody has opened this document** |

**Candidate proposition**

> Representations against a Notice to Owner must be made within a period fixed by statute, running from service of that notice.

**Applicability**

- Contravention codes: Any
- Authority: Any
- Notice types: NOTICE_TO_OWNER
- Procedural stages: FORMAL_REPRESENTATION

**Must not be read as establishing**

- Any discount period.
- That an authority will refuse a late representation.

**Question for the reviewer**

> Confirm the length of the period and the event it runs from, and whether deemed service applies. Do not approve a period taken from a summary: this is the deadline whose miscalculation would cost somebody their right to make representations.

**Bounded excerpt from the source** _(paste the wording you actually read)_

```

```

**Reviewer comments**

```

```

**Decision** — delete as appropriate

`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`

Currently recorded: `PENDING_LEGAL_REVIEW`

| | |
| --- | --- |
| Reviewer name | |
| Qualification | |
| Date reviewed | |
| Date source retrieved | |

---

## Returning your decisions

Recording a decision is a code change: an edit to the candidate's `review` block and
its `source` provenance in `src/core/reference/candidates/`, in a commit, with you
named. That is a feature — it goes through the same review as any other change, it is
attributable, and it cannot be done by anything that can write to the database.

Approving a deadline rule here does **not** release a calculated date to users. The
deadline projection gates on its own rule store, which needs its own review.

