import { describe, expect, it } from 'vitest';
import {
  isMitigationQuestion,
  resolveQuestionPrompt,
  selectContextQuestions,
} from '@/core/context/questions';
import { getReference, knownContraventionCodes } from '@/core/reference/store';

/**
 * Which questions PCNWatch asks, and where they come from.
 *
 * The whole risk in this stage is a product that invents plausible-sounding
 * questions for a code it knows nothing about, and thereby implies it
 * understands a notice it does not. These cover the boundary rather than the
 * happy path: every question must trace to a record in the approved store, and
 * a code we hold nothing for must produce nothing specific.
 */

const BASE = {
  noticeType: 'PCN_POSTAL',
  proceduralStage: 'NEW',
} as const;

describe('questions come from the approved reference store', () => {
  it('asks the code 12 questions the reference record holds, word for word', () => {
    const set = selectContextQuestions({ ...BASE, contraventionCode: '12' });
    const record = getReference('CONTRAVENTION-12');
    const expected = (record!.content as { commonFactualQuestions: readonly string[] })
      .commonFactualQuestions;

    const prompts = set.questions.map((q) => q.prompt);
    for (const question of expected) {
      expect(prompts, 'a reference question is missing from the stage').toContain(question);
    }
    // The permit question is the one this contravention actually turns on.
    expect(prompts).toContain('Did you hold a valid permit for that bay at that time?');
  });

  it('every question cites a record that exists', () => {
    for (const code of [...knownContraventionCodes(), null]) {
      const set = selectContextQuestions({ ...BASE, contraventionCode: code });
      for (const question of set.questions) {
        expect(question.referenceKeys.length, `${question.id} cites nothing`).toBeGreaterThan(0);
        for (const key of question.referenceKeys) {
          expect(getReference(key), `${question.id} cites missing ${key}`).toBeDefined();
        }
      }
    }
  });

  it('invents nothing for a contravention it does not hold', () => {
    const set = selectContextQuestions({ ...BASE, contraventionCode: '77' });

    expect(set.unknownContraventionCode).toBe('77');
    expect(
      set.questions.filter((q) => q.source === 'CONTRAVENTION_REFERENCE'),
      'a code with no record produced code-specific questions',
    ).toHaveLength(0);
    // What remains is general and still cited.
    for (const question of set.questions) {
      expect(question.source).toBe('GENERAL_GUIDANCE');
    }
  });

  it('asks different questions for different contraventions', () => {
    const twelve = selectContextQuestions({ ...BASE, contraventionCode: '12' }).questions.map(
      (q) => q.prompt,
    );
    const one = selectContextQuestions({ ...BASE, contraventionCode: '01' }).questions.map(
      (q) => q.prompt,
    );

    expect(twelve).not.toEqual(one);
    // Loading is what code 01 turns on; a permit is what code 12 turns on.
    expect(one.join(' ')).toMatch(/loading/i);
    expect(twelve.join(' ')).toMatch(/permit/i);
  });

  it('marks the mitigation question as mitigation and asks it last', () => {
    const set = selectContextQuestions({ ...BASE, contraventionCode: '12' });
    const mitigation = set.questions.filter((q) => q.isMitigation);

    expect(mitigation).toHaveLength(1);
    expect(set.questions.at(-1)!.isMitigation).toBe(true);
    expect(isMitigationQuestion(mitigation[0]!.id)).toBe(true);
  });

  it('does not repeat a question that has already been answered', () => {
    const first = selectContextQuestions({ ...BASE, contraventionCode: '12' });
    const answeredId = first.questions[0]!.id;

    const second = selectContextQuestions({
      ...BASE,
      contraventionCode: '12',
      answeredQuestionIds: [answeredId],
    });
    expect(second.questions.map((q) => q.id)).not.toContain(answeredId);
  });

  it('keeps the first pass short enough for a phone', () => {
    for (const code of knownContraventionCodes()) {
      const set = selectContextQuestions({ ...BASE, contraventionCode: code });
      expect(set.questions.length, `code ${code} asks too much at once`).toBeLessThanOrEqual(6);
      expect(set.evidenceQuestions.length).toBeLessThanOrEqual(6);
    }
  });
});

describe('evidence declarations follow the contravention', () => {
  it('asks about the evidence code 12 turns on', () => {
    const types = selectContextQuestions({ ...BASE, contraventionCode: '12' }).evidenceQuestions.map(
      (e) => e.type,
    );
    expect(types).toContain('PERMIT');
    expect(types).toContain('PAYMENT_RECEIPT');
    expect(types).toContain('PARKING_APP_RECEIPT');
  });

  it('does not ask for the notice the user just uploaded', () => {
    const types = selectContextQuestions({ ...BASE, contraventionCode: '12' }).evidenceQuestions.map(
      (e) => e.type,
    );
    expect(types).not.toContain('PCN_IMAGE');
  });

  it('does not ask whether the user holds evidence we already have', () => {
    const set = selectContextQuestions({
      ...BASE,
      contraventionCode: '12',
      evidenceProvided: { PERMIT: 1 },
    });
    expect(set.evidenceQuestions.map((e) => e.type)).not.toContain('PERMIT');
  });
});

describe('question wording is resolved from the store, not the caller', () => {
  it('resolves a contravention question by id', () => {
    expect(resolveQuestionPrompt('CONTRAVENTION-12#0')).toBe(
      'Did you hold a valid permit for that bay at that time?',
    );
  });

  it('resolves the general questions', () => {
    expect(resolveQuestionPrompt('GENERAL#mitigation')).toMatch(/exceptional/i);
    expect(resolveQuestionPrompt('GENERAL#council-photographs')).toMatch(/photographs/i);
  });

  it('refuses an id it cannot account for', () => {
    // A hand-made request must not be able to put words into a finding.
    for (const id of [
      'CONTRAVENTION-99999#0',
      'CONTRAVENTION-12#999',
      'GENERAL#made-up',
      'nonsense',
      '#0',
      'CONTRAVENTION-12#',
      'CONTRAVENTION-12#-1',
    ]) {
      expect(resolveQuestionPrompt(id), `${id} resolved to something`).toBeNull();
    }
  });
});
