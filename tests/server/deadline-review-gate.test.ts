import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/cases/assess/route';
import { assessVerifiedNotice } from '@/server/cases/assess-verified';
import { calculateAllDeadlines } from '@/core/deadlines/calculate';
import { DEADLINE_RULES, findRule } from '@/core/deadlines/rules';

/**
 * A date from an unreviewed timing rule must not exist in the payload.
 *
 * Hiding it in the React layer would not be enough. The assessment crosses the
 * network as JSON, and anything in that JSON is readable in the network tab,
 * reachable by any other client, and liable to be rendered by the next
 * component someone writes. "Not displayed" and "not present" are different
 * guarantees, and only the second one holds when somebody builds a new view.
 *
 * So these assert on the serialised response from the route handler itself,
 * not on a component and not on the composition function alone.
 */

const VERIFIED_FACTS = {
  noticeType: 'PCN_POSTAL' as const,
  authorityName: 'Westminster City Council',
  contraventionCode: '12',
  incidentDate: '2026-08-11',
  // The trigger date. Every rule keyed off it can be computed, so nothing is
  // withheld here merely for want of a date to work from.
  issueDate: '2026-08-14',
  fullAmountPence: 13_000,
};

/** The dates the engine really produces, unfiltered. */
function enginesDates() {
  const results = calculateAllDeadlines({
    pcnServedDate: VERIFIED_FACTS.issueDate,
    serviceMethod: 'POSTED',
  });
  const reviewed: string[] = [];
  const unreviewed: string[] = [];
  for (const result of results) {
    if (!result.calculated) continue;
    const rule = findRule(result.deadlineType);
    (rule?.reviewStatus === 'REVIEWED' ? reviewed : unreviewed).push(result.calculatedDueDate);
  }
  return { reviewed, unreviewed };
}

async function assessOverHttp(body: Record<string, unknown> = VERIFIED_FACTS) {
  const response = await POST(
    new Request('http://localhost/api/cases/assess', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const json = (await response.json()) as { ok: boolean; assessment: unknown };
  return { status: response.status, json, raw: JSON.stringify(json) };
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;

describe('the review gate is on the server, not in the view', () => {
  it('computes dates from unreviewed rules that the payload must not contain', () => {
    // Establishes the premise. If this ever finds nothing, the tests below
    // would pass vacuously and this says so instead.
    const { unreviewed } = enginesDates();
    expect(
      unreviewed.length,
      'the engine must produce at least one unreviewed date for this to test anything',
    ).toBeGreaterThan(0);
  });

  it('omits every unreviewed date from the serialised response', async () => {
    const { unreviewed } = enginesDates();
    const { raw } = await assessOverHttp();

    for (const date of unreviewed) {
      expect(raw, `${date} comes from an unreviewed rule and must not be in the payload`).not.toContain(
        date,
      );
    }
  });

  it('carries no calculated deadline whose rule is unreviewed', async () => {
    const { json } = await assessOverHttp();
    const assessment = (json as { assessment: { calculatedDeadlines: { label: string }[] } })
      .assessment;

    for (const deadline of assessment.calculatedDeadlines) {
      const rule = DEADLINE_RULES.find((r) => r.label === deadline.label);
      expect(rule?.reviewStatus, `${deadline.label} was sent to the client`).toBe('REVIEWED');
    }
  });

  it('sends the withheld deadline as a refusal carrying no date at all', async () => {
    const { json } = await assessOverHttp();
    const assessment = (
      json as {
        assessment: { refusedDeadlines: { label: string; reason: string; message: string }[] };
      }
    ).assessment;

    const withheld = assessment.refusedDeadlines.filter((d) => d.reason === 'RULE_AWAITING_REVIEW');
    expect(withheld.length).toBeGreaterThan(0);

    for (const refusal of withheld) {
      // The explanation must not smuggle the date back in as prose.
      expect(refusal.message).not.toMatch(ISO_DATE);
      expect(refusal.message).not.toMatch(/\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i);
      expect(refusal.label).toBeTruthy();
    }
  });

  it('lets through only dates the user gave us or a reviewed rule produced', async () => {
    // The general invariant, and the one that keeps holding as rules are
    // signed off: every date in the payload has an account of where it came
    // from. Nothing else may appear.
    const printed = '2026-08-28';
    const { reviewed } = enginesDates();
    const { raw } = await assessOverHttp({ ...VERIFIED_FACTS, discountDeadlinePrinted: printed });

    const permitted = new Set([
      VERIFIED_FACTS.incidentDate,
      VERIFIED_FACTS.issueDate,
      printed,
      ...reviewed,
    ]);

    for (const date of raw.match(ISO_DATE) ?? []) {
      expect(permitted.has(date), `${date} appears in the payload with no source`).toBe(true);
    }
  });

  it('still sends a deadline the authority printed, which is not our arithmetic', async () => {
    const { json } = await assessOverHttp({
      ...VERIFIED_FACTS,
      discountDeadlinePrinted: '2026-08-28',
    });
    const assessment = (
      json as { assessment: { printedDeadlines: { date: string; source: string }[] } }
    ).assessment;

    expect(assessment.printedDeadlines).toHaveLength(1);
    expect(assessment.printedDeadlines[0]!.date).toBe('2026-08-28');
    expect(assessment.printedDeadlines[0]!.source).toBe('PRINTED_ON_NOTICE');
  });

  it('holds for the composition function too, so no caller can bypass it', () => {
    // The route is the only caller today. This makes the guarantee a property
    // of the assessment itself rather than of one endpoint.
    const { unreviewed } = enginesDates();
    const raw = JSON.stringify(assessVerifiedNotice(VERIFIED_FACTS));
    for (const date of unreviewed) {
      expect(raw).not.toContain(date);
    }
  });
});
