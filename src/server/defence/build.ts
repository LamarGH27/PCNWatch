import { EVIDENCE_DEFINITIONS } from '@/core/evidence/definitions';
import { supportsAssessment, type EvidenceItem } from '@/core/evidence/lifecycle';
import { EVIDENCE_FIELD_LABELS } from '@/core/evidence/analysis';
import type { EvidenceComparison } from '@/core/evidence/compare';
import type { EvidenceType } from '@/core/evidence/types';
import { evidenceRelevance, reconcileContext, type CanonicalFact } from '@/core/context/reconcile';
import { ASSERTION_LABELS } from '@/core/context/types';
import { evidenceForAssertion, isMitigationAssertion } from '@/core/context/questions';
import { getReference, referencesByCategory, toCitation } from '@/core/reference/store';
import type { CaseRecord, CaseView } from '@/server/cases/case-view';
import type {
  AccountSection,
  CaseSummarySection,
  ChecklistEntry,
  DefencePack,
  EvidenceChecklistSections,
  EvidenceSection,
  EvidenceStanding,
  EvidenceSummaryItem,
  FactualPoint,
  GroundedStatement,
  LegalPositionSection,
  PermittedReferences,
  Weakness,
} from '@/core/defence/types';
import { MAX_MOST_USEFUL } from '@/core/defence/types';

/**
 * The Defence Pack, built from the record and nothing else.
 *
 * No model is involved anywhere in this file, and that is the design rather
 * than an implementation detail. Everything a Defence Pack asserts is decided
 * here, from facts the user confirmed; the drafting layer that runs afterwards
 * is given this object and permitted to say what is in it more fluently. It
 * cannot add a point, promote a claim, or supply a fact of its own.
 *
 * Read the sections in order and the shape of the product is visible: what the
 * notice says, what the user says, what the documents say, where those agree,
 * where they do not, and what is still missing. A challenge letter is the last
 * thing produced, not the first.
 */

/** Masked wherever the Pack shows it. Enough to recognise, not enough to quote. */
export function maskPcnNumber(pcnNumber: string | null): string | null {
  if (!pcnNumber) return null;
  const trimmed = pcnNumber.trim();
  if (trimmed.length <= 4) return '•'.repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}${'•'.repeat(Math.max(3, trimmed.length - 5))}${trimmed.slice(-3)}`;
}

export function buildDefencePack(record: CaseRecord, view: CaseView): DefencePack {
  const reconciled = reconcileContext(
    record.contextAnswers,
    record.confirmedAssertions,
    record.resolvedFacts,
  );

  const held = record.evidenceItems.filter(supportsAssessment);

  const caseSummary = buildCaseSummary(record, view);
  const account = buildAccount(record, reconciled);
  const evidence = buildEvidence(record, held, view.evidenceComparisons);
  const legalPosition = buildLegalPosition(record);
  const factualPoints = buildFactualPoints(reconciled, evidence, view.evidenceComparisons, record);
  const weaknesses = buildWeaknesses(record, view, evidence, reconciled);
  const checklist = buildChecklist(record, evidence, view, reconciled.facts);
  const checklistSections = splitChecklist(checklist, reconciled.facts);

  return {
    caseSummary,
    account,
    evidence,
    factualPoints,
    weaknesses,
    checklist,
    checklistSections,
    dates: { deadlines: view.deadlines, refused: view.refusedDeadlines },
    legalPosition,
    evidenceBasis: view.assessment.basis,
    evidenceBasisExplanation: view.assessment.basisExplanation,
    permittedReferences: permittedReferences(record, held, view),
  };
}

/* ---- A. Case summary ----------------------------------------------------- */

/**
 * Only what the user actually confirmed.
 *
 * A field they were never asked to tick, or ticked as unknown, is absent and
 * named in `unconfirmed`. Printing an unverified value in a document intended
 * for an authority would be putting our reading of their notice into their
 * mouth.
 */
function buildCaseSummary(record: CaseRecord, view: CaseView): CaseSummarySection {
  const unconfirmed: string[] = [];
  const verified = <T>(field: string, value: T | null, label: string): T | null => {
    if (record.verifiedFields[field] === true && value !== null) return value;
    unconfirmed.push(label);
    return null;
  };

  const contravention = record.contraventionCode
    ? (getReference(`CONTRAVENTION-${record.contraventionCode}`)?.summary ?? null)
    : null;

  return {
    authority: record.authorityName,
    authorityRecognised: record.authoritySlug !== null,
    pcnNumberMasked: maskPcnNumber(verified('pcnNumber', record.pcnNumber, 'The PCN number')),
    /*
     * Gated like every other field.
     *
     * It was ungated, which was harmless while nothing cited it — and stopped
     * being harmless the moment the drafting material started offering it as a
     * fact the letter may assert. An unverified value there is a reference the
     * validator will not accept, so the whole draft would be rejected for a
     * fact the pack should never have offered.
     */
    vehicleRegistration: verified('vehicleRegistration', record.vehicleRegistration, 'The vehicle registration'),
    contraventionCode: verified('contraventionCode', record.contraventionCode, 'The contravention code'),
    contravention,
    location: verified('location', record.locationText, 'The location on the notice'),
    incidentDate: verified('incidentDate', record.incidentDate, 'The date of the alleged contravention'),
    incidentTime: record.incidentTime,
    stageLabel: view.stageLabel,
    amount:
      record.verifiedFields.fullAmountPence === true && record.fullAmountPence !== null
        ? `£${(record.fullAmountPence / 100).toFixed(2)}`
        : (unconfirmed.push('The amount demanded'), null),
    unconfirmed,
  };
}

/* ---- B. Your account ----------------------------------------------------- */

/**
 * Testimony, kept as testimony.
 *
 * Every line is attributed and carries CONFIRMED_USER_ASSERTION. A Defence Pack
 * that restated "you paid using an app" as a finding would be laundering the
 * user's own account into evidence, and an authority reading it would be
 * entitled to treat the whole document as unreliable.
 */
function buildAccount(
  record: CaseRecord,
  reconciled: ReturnType<typeof reconcileContext>,
): AccountSection {
  const userSays: GroundedStatement[] = reconciled.facts
    .filter((fact) => fact.stance === 'ASSERTED' && fact.topic !== 'OTHER_REQUIRES_REVIEW')
    .map((fact) => ({
      text: ASSERTION_LABELS[fact.topic],
      source: 'CONFIRMED_USER_ASSERTION' as const,
      reference: fact.topic,
    }));

  const openQuestions: string[] = [];
  for (const fact of reconciled.facts) {
    if (fact.stance === 'UNCLEAR') {
      openQuestions.push(`${ASSERTION_LABELS[fact.topic]} — you left this open.`);
    }
  }
  for (const conflict of reconciled.conflicts) {
    openQuestions.push(
      `${ASSERTION_LABELS[conflict.topic]} — you have told us two different things, so it is not being relied on.`,
    );
  }
  if (reconciled.facts.some((f) => f.topic === 'OTHER_REQUIRES_REVIEW')) {
    openQuestions.push(
      'You told us something that does not fit the checks we run automatically. It is not in this pack because we have not assessed it.',
    );
  }

  return { provided: record.narrativeProvided, userSays, openQuestions };
}

/* ---- C. Evidence summary ------------------------------------------------- */

function buildEvidence(
  record: CaseRecord,
  held: readonly EvidenceItem[],
  comparisons: readonly EvidenceComparison[],
): EvidenceSection {
  const items: EvidenceSummaryItem[] = held.map((item) => {
    const mine = comparisons.filter((c) => c.evidenceId === item.id);
    const supports = mine.filter((c) => c.outcome === 'CONSISTENT').map((c) => c.statement);
    const contradicts = mine.filter((c) => c.outcome === 'DIFFERS').map((c) => c.statement);
    const { standing, standingReason } = standingFor(mine.length, supports.length, contradicts.length);

    return {
      evidenceId: item.id,
      type: item.type,
      label: EVIDENCE_DEFINITIONS[item.type]?.label ?? item.type,
      verifiedFacts: item.verifiedFacts.map((fact) => ({
        text: `${EVIDENCE_FIELD_LABELS[fact.field as keyof typeof EVIDENCE_FIELD_LABELS] ?? fact.field}: ${fact.value}`,
        source: 'VERIFIED_EVIDENCE_FACT' as const,
        reference: item.id,
      })),
      supports,
      contradicts,
      standing,
      standingReason,
    };
  });

  /*
   * Claimed and never produced.
   *
   * Listed here so the Pack shows the gap rather than the claim. A declaration
   * is the single easiest thing for a product like this to quietly count: the
   * user says they have the receipt, it appears in a list headed "evidence",
   * and they submit a challenge resting on a document nobody has seen.
   */
  const heldTypes = new Set(record.evidenceItems.map((i) => i.type));
  const declaredButNotHeld = record.declaredEvidence
    .filter((d) => d.held === 'HAVE' && !heldTypes.has(d.type))
    .map((d) => EVIDENCE_DEFINITIONS[d.type]?.label ?? d.type);

  return { items, declaredButNotHeld, sourceNoticeHeld: record.noticeSource === 'SCANNED' };
}

function standingFor(
  comparisons: number,
  supports: number,
  contradicts: number,
): { standing: EvidenceStanding; standingReason: string } {
  if (contradicts > 0) {
    return {
      standing: 'CONFLICTING',
      standingReason:
        'Something on this document does not match your notice. It is here because an authority will see it too.',
    };
  }
  if (supports > 0) {
    return {
      standing: 'CORROBORATIVE',
      standingReason: 'What we read off this agrees with what your notice says.',
    };
  }
  if (comparisons === 0) {
    return {
      standing: 'INCONCLUSIVE',
      standingReason:
        'There is nothing on this we could check against your notice, so it neither supports nor undermines your account on its own.',
    };
  }
  return {
    standing: 'NEUTRAL',
    standingReason: 'We could not compare what this says with your notice in a way that settles anything.',
  };
}

/* ---- D. Strongest factual points ----------------------------------------- */

/**
 * The points the record actually supports, ranked by what stands behind them.
 *
 * Every one is assembled from confirmed facts here, not proposed by a model and
 * checked afterwards. The order is deliberate: a point corroborated by a
 * document the user confirmed outranks the same point resting on their account
 * alone, because that is the order an authority will read them in.
 *
 * Nothing in this section says a notice is invalid, or that a point is a
 * ground. It says what the documents show.
 */
function buildFactualPoints(
  reconciled: ReturnType<typeof reconcileContext>,
  evidence: EvidenceSection,
  comparisons: readonly EvidenceComparison[],
  record: CaseRecord,
): FactualPoint[] {
  const points: FactualPoint[] = [];
  const contraventionRecord = record.contraventionCode
    ? getReference(`CONTRAVENTION-${record.contraventionCode}`)
    : undefined;
  const citations = contraventionRecord ? [toCitation(contraventionRecord)] : [];

  /*
   * Evidence that differs from the notice.
   *
   * First, because it is the most concrete thing the record contains — a
   * document the user confirmed, saying something the notice does not. This is
   * the RingGo case: the session began before the alleged contravention and the
   * registration on it is not the one on the notice.
   */
  for (const item of evidence.items) {
    if (item.contradicts.length === 0) continue;
    points.push({
      id: `point-evidence-differs-${item.evidenceId}`,
      headline: `${item.label}: something on this document does not match your notice`,
      detail: item.contradicts.join(' '),
      basis: 'VERIFIED_EVIDENCE',
      grounds: item.verifiedFacts,
      citations,
    });
  }

  // Evidence that agrees with the notice about the vehicle, date or code. Weaker
  // than a difference, and worth stating because it establishes the document is
  // about this vehicle on this day rather than some other occasion.
  for (const item of evidence.items) {
    if (item.supports.length === 0 || item.contradicts.length > 0) continue;
    points.push({
      id: `point-evidence-agrees-${item.evidenceId}`,
      headline: `${item.label}: this document is about the vehicle and day on your notice`,
      detail: item.supports.join(' '),
      basis: 'VERIFIED_EVIDENCE',
      grounds: item.verifiedFacts,
      citations,
    });
  }

  /*
   * What the user says, where a document they gave us bears on the same topic.
   *
   * Kept separate from the two above and always attributed. A confirmed account
   * with a document behind it is worth putting to an authority; the same
   * account with nothing behind it is in the weaknesses section instead.
   */
  /*
   * The account, shown whether or not a document backs it.
   *
   * This used to be skipped entirely when no evidence had been uploaded, on the
   * reasoning that an uncorroborated claim is not a "strongest point". The
   * effect was that the Westminster case — where the user had confirmed they
   * paid, paid by app, and may have entered the wrong registration — produced
   * "there is nothing here the record supports yet". The product held the only
   * material theory of the case and declined to mention it.
   *
   * Withholding it is not caution, it is unhelpfulness. Presenting it as
   * established would be the real failure, and that is what the label prevents:
   * every one of these carries USER_ACCOUNT and says so on the page and in the
   * letter, and an evidence-backed point still outranks it in this list.
   */
  const corroborated = new Set(
    comparisons.filter((c) => c.outcome !== 'NOT_COMPARED').map((c) => c.evidenceType as string),
  );
  for (const fact of reconciled.facts) {
    if (fact.stance !== 'ASSERTED') continue;
    if (isMitigationAssertion(fact.topic)) continue;
    if (fact.topic === 'OTHER_REQUIRES_REVIEW') continue;

    points.push({
      id: `point-account-${fact.topic}`,
      headline: ASSERTION_LABELS[fact.topic],
      detail:
        corroborated.size > 0
          ? 'This is your account. The documents you have provided are listed above so an authority can weigh it against them.'
          : 'This is your account. Nothing we hold corroborates it yet, and an authority will read it as your recollection rather than as established fact.',
      basis: 'USER_ACCOUNT',
      grounds: [
        {
          text: ASSERTION_LABELS[fact.topic],
          source: 'CONFIRMED_USER_ASSERTION',
          reference: fact.topic,
        },
      ],
      citations: [],
    });
  }

  return points;
}

/* ---- E. Weaknesses and gaps ---------------------------------------------- */

/**
 * Mandatory, and never trimmed to make the Pack read better.
 *
 * This is the section that decides whether the product is honest. A paid
 * document that lists a user's strongest points and quietly omits the
 * photograph contradicting them has sold them a worse outcome than the free
 * assessment would have given.
 */
function buildWeaknesses(
  record: CaseRecord,
  view: CaseView,
  evidence: EvidenceSection,
  reconciled: ReturnType<typeof reconcileContext>,
): Weakness[] {
  const weaknesses: Weakness[] = [];

  for (const item of evidence.items) {
    for (const contradiction of item.contradicts) {
      weaknesses.push({
        id: `weak-conflict-${item.evidenceId}`,
        what: contradiction,
        whyItMatters:
          'An authority looking at the same document will see this. Raising it yourself is better than being answered with it.',
      });
    }
  }

  if (!record.evidenceItems.some((i) => i.type === 'COUNCIL_PHOTOGRAPHS')) {
    weaknesses.push({
      id: 'weak-no-authority-photographs',
      what: 'You have not provided the authority’s own photographs.',
      whyItMatters:
        'These are what the authority will rely on. Until you have seen them you do not know what you are answering.',
    });
  }

  for (const missing of view.evidence.missingEssential) {
    /*
     * The notice itself no longer appears here on a scanned case: the
     * checklist is told the source notice is held, so it never reaches
     * `missingEssential`. A pack telling somebody "the penalty charge notice
     * has not been provided" ninety seconds after they photographed it was the
     * product forgetting what it had just done.
     */
    weaknesses.push({
      id: `weak-missing-${missing}`,
      what: `${EVIDENCE_DEFINITIONS[missing]?.label ?? missing} has not been provided.`,
      whyItMatters: EVIDENCE_DEFINITIONS[missing]?.whyItMatters ?? 'It is listed as essential for this case.',
    });
  }

  for (const label of evidence.declaredButNotHeld) {
    weaknesses.push({
      id: `weak-declared-${label}`,
      what: `You told us you have ${label.toLowerCase()}, and we have not seen it.`,
      whyItMatters:
        'It is not evidence until it has been provided and checked, and this challenge does not claim it exists.',
    });
  }

  const unverified = view.assessment.missingInformation;
  for (const item of unverified) {
    weaknesses.push({ id: `weak-info-${hash(item)}`, what: item, whyItMatters: '' });
  }

  if (evidence.items.length === 0 && reconciled.facts.length > 0) {
    weaknesses.push({
      id: 'weak-account-only',
      what: 'Your account is not supported by any document we hold.',
      whyItMatters:
        'A challenge resting on your word alone can still succeed, but it gives the authority nothing to check.',
    });
  }

  return weaknesses;
}

/* ---- F. Checklist -------------------------------------------------------- */

function buildChecklist(
  record: CaseRecord,
  evidence: EvidenceSection,
  view: CaseView,
  facts: readonly CanonicalFact[],
): ChecklistEntry[] {
  const sourceNoticeHeld = evidence.sourceNoticeHeld;
  void facts;
  const heldTypes = new Set(record.evidenceItems.filter(supportsAssessment).map((i) => i.type));
  const relevant = new Set(view.evidence.items.map((i) => i.type));

  const entries: ChecklistEntry[] = view.evidence.items.map((item) => {
    // The notice the case was built from is already in hand, whatever the
    // evidence table says.
    const have = heldTypes.has(item.type) || (item.type === 'PCN_IMAGE' && sourceNoticeHeld);
    return {
      type: item.type,
      label: item.definition.label,
      standing: have ? 'ALREADY_HAVE' : 'RECOMMENDED',
      note: have
        ? item.type === 'PCN_IMAGE' && !heldTypes.has(item.type)
          ? 'You photographed this when you started, and we read it with you.'
          : 'Provided and checked by you.'
        : item.reason,
      importance: item.importance,
    } satisfies ChecklistEntry;
  });

  /*
   * What this case does not need.
   *
   * Named rather than omitted, because a checklist of six items with eight
   * evidence types in the product reads as an oversight. Saying "not relevant
   * here" is a smaller and more useful statement than silence.
   */
  for (const type of Object.keys(EVIDENCE_DEFINITIONS) as EvidenceType[]) {
    if (relevant.has(type)) continue;
    entries.push({
      type,
      label: EVIDENCE_DEFINITIONS[type].label,
      standing: 'NOT_RELEVANT',
      note: 'Not something this contravention normally turns on.',
      importance: 'SUPPORTING',
    });
  }

  return entries;
}

/**
 * The three things worth gathering, and everything else.
 *
 * A flat list of six items reads as a tribunal bundle, and to somebody deciding
 * whether to challenge at all it makes the job look bigger than it is. So the
 * same entries are split: the three the existing ranking engine puts highest,
 * and the rest kept behind a disclosure rather than dropped.
 *
 * The ranking is `evidenceRelevance`, not a new one — the same function that
 * orders the evidence guidance on the free assessment, and the same function
 * that refuses to rank the authority's own material down because the user
 * disputes the allegation.
 */
function splitChecklist(
  checklist: readonly ChecklistEntry[],
  facts: readonly CanonicalFact[],
): EvidenceChecklistSections {
  const priorityOrder = { PRIORITY: 0, STANDARD: 1, LESS_LIKELY: 2 } as const;
  const importanceOrder = { ESSENTIAL: 0, STRONG: 1, SUPPORTING: 2 } as const;

  const recommended = checklist
    .filter((entry) => entry.standing === 'RECOMMENDED')
    .map((entry, index) => {
      const supports = facts
        .map((fact) => fact.topic)
        .filter((topic) => evidenceForAssertion(topic).includes(entry.type));
      const { priority } = evidenceRelevance(entry.type, supports, facts);
      return { entry, priority, index };
    })
    /*
     * Essential first, then what the account makes most relevant.
     *
     * Two rankings, and importance leads because they answer different
     * questions. `evidenceRelevance` says what this user's story turns on;
     * importance says what any case of this kind needs. A missing essential
     * item outranks a merely relevant one — a manually entered case with no
     * notice attached should be asked for the notice before anything else.
     */
    .sort(
      (a, b) =>
        importanceOrder[a.entry.importance] - importanceOrder[b.entry.importance] ||
        priorityOrder[a.priority] - priorityOrder[b.priority] ||
        a.index - b.index,
    );

  return {
    alreadyHave: checklist.filter((e) => e.standing === 'ALREADY_HAVE'),
    mostUseful: recommended.slice(0, MAX_MOST_USEFUL).map((r) => r.entry),
    other: recommended.slice(MAX_MOST_USEFUL).map((r) => r.entry),
    notRelevant: checklist.filter((e) => e.standing === 'NOT_RELEVANT'),
  };
}

/* ---- Legal position ------------------------------------------------------ */

/**
 * What the Pack will not claim.
 *
 * Every statutory ground in the reference store is PENDING_LEGAL_REVIEW, as is
 * every contravention and procedure record. So this returns false today, and
 * the Pack says so in as many words rather than reaching for a half-remembered
 * paragraph of the Traffic Management Act.
 *
 * It is computed rather than hardcoded: when a reviewer signs off a ground, the
 * Pack starts being able to cite it without anybody remembering to change this.
 */
function buildLegalPosition(record: CaseRecord): LegalPositionSection {
  const reviewedGrounds = referencesByCategory('STATUTORY_GROUND').filter(
    (r) => r.reviewStatus === 'REVIEWED',
  );

  const unreviewedGrounds = record.assertedGroundKeys.filter(
    (key) => getReference(key)?.reviewStatus !== 'REVIEWED',
  );

  return {
    canStateGrounds: reviewedGrounds.length > 0,
    explanation:
      reviewedGrounds.length > 0
        ? 'The grounds cited in this pack are drawn from reviewed reference material.'
        : 'This pack sets out facts, not legal grounds. PCNWatch does not yet hold legally reviewed wording for the statutory grounds of representation, and it will not paraphrase legislation from memory. What is here is what your notice says, what you have told us, and what your documents show — which is what an authority considers first in any event.',
    unreviewedGrounds,
  };
}

/* ---- What the drafting layer may cite ------------------------------------ */

function permittedReferences(
  record: CaseRecord,
  held: readonly EvidenceItem[],
  view: CaseView,
): PermittedReferences {
  return {
    verifiedCaseFields: Object.entries(record.verifiedFields)
      .filter(([, confirmed]) => confirmed === true)
      .map(([field]) => field),
    confirmedAssertions: record.confirmedAssertions.map((a) => a.kind),
    evidenceRefs: held.map((item) => item.id),
    // Only what the assessment actually cited, and only if reviewed. An
    // unreviewed record can inform a finding; it cannot be quoted at a council.
    referenceKeys: view.assessment.citations
      .map((c) => c.key)
      .filter((key) => getReference(key)?.reviewStatus === 'REVIEWED'),
  };
}

function hash(text: string): string {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(value).toString(36);
}
