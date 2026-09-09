'use client';

import { useState } from 'react';
import { Card } from '@/components/primitives';
import { EVIDENCE_BASIS_LABELS } from '@/core/assessment/types';
import {
  POINT_BASIS_LABELS,
  PROVENANCE_LABELS,
  type DefencePack,
  type PackStatus,
} from '@/core/defence/types';

/**
 * The Defence Pack, on screen.
 *
 * Sections in the order somebody actually needs them: what the notice says,
 * what they say, what their documents say, where those agree, where they do
 * not, what is missing, and then the letter. The letter is last because it is
 * the least important part — anyone can write a letter, and what makes this
 * worth paying for is the four sections above it.
 */

export interface StoredPackView {
  readonly id: string;
  readonly status: PackStatus;
  readonly pack: DefencePack;
  readonly generatedBody: string;
  readonly editedBody: string | null;
  readonly version: number;
  readonly generatedAt: string | null;
  readonly staleness: { stale: boolean; message?: string };
}

type Busy = 'BUILD' | 'SAVE' | null;

export function DefencePanel({
  caseId,
  initial,
}: {
  caseId: string;
  initial: StoredPackView | null;
}) {
  const [stored, setStored] = useState<StoredPackView | null>(initial);
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [letterNote, setLetterNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [copied, setCopied] = useState(false);

  const letter = stored ? (stored.editedBody ?? stored.generatedBody) : '';

  async function build() {
    setProblem(null);
    setLetterNote(null);
    setBusy('BUILD');
    try {
      const response = await fetch(`/api/cases/${caseId}/defence-pack`, { method: 'POST' });
      const result = (await response.json()) as {
        ok?: boolean;
        status?: PackStatus;
        pack?: StoredPackView;
        message?: string;
        letter?: { drafted: boolean; what?: string; whatYouCanDo?: string };
      };
      if (!result.ok || !result.pack) {
        setProblem(result.message ?? 'We could not build your Defence Pack.');
        return;
      }
      setStored(result.pack);
      setEditing(false);
      if (result.letter && !result.letter.drafted) {
        // The pack is complete. Only the letter is missing, and saying which
        // is the difference between a usable document and a failed one.
        setLetterNote(`${result.letter.what ?? ''} ${result.letter.whatYouCanDo ?? ''}`.trim());
      }
    } catch {
      setProblem('We could not reach the server. Your case is unchanged.');
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    if (!stored) return;
    setProblem(null);
    setBusy('SAVE');
    try {
      const response = await fetch(`/api/defence-pack/${stored.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editedBody: draftText }),
      });
      const result = (await response.json()) as { ok?: boolean; pack?: StoredPackView };
      if (!result.ok || !result.pack) {
        setProblem('We could not save your changes to the letter.');
        return;
      }
      setStored(result.pack);
      setEditing(false);
    } catch {
      setProblem('We could not reach the server. Your changes were not saved.');
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(letter);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setProblem('Your browser would not let us copy. Select the text and copy it by hand.');
    }
  }

  if (!stored) {
    return (
      <>
        {problem && <Problem>{problem}</Problem>}
        <Card style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 620, marginBottom: 8 }}>
            Build your Defence Pack
          </h2>
          <p style={{ margin: '0 0 14px', fontSize: 15, color: 'var(--text-muted)' }}>
            Built from the notice details you confirmed, what you told us, and the evidence you
            have checked. Nothing in it is invented, and anything we cannot establish is listed
            rather than filled in.
          </p>
          <button
            type="button"
            className="fr-touch"
            onClick={build}
            disabled={busy !== null}
            style={primaryButton}
          >
            {busy === 'BUILD' ? 'Building…' : 'Build Defence Pack'}
          </button>
        </Card>
      </>
    );
  }

  const pack = stored.pack;

  return (
    <>
      {problem && <Problem>{problem}</Problem>}

      {stored.status === 'PACK_PARTIAL' && (
        <p
          role="status"
          style={{
            marginTop: 16,
            padding: '12px 14px',
            borderRadius: 8,
            border: '1px solid var(--color-urgent)',
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          <strong>This pack is not finished.</strong> Everything below is yours and is correct, but
          we could not produce the challenge letter. Rebuilding usually works.
        </p>
      )}

      {stored.staleness.stale && (
        <p
          role="status"
          style={{
            marginTop: 16,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--color-urgent)',
            fontSize: 14,
          }}
        >
          {stored.staleness.message} Rebuild it so the document matches your case.
        </p>
      )}

      <div className="fr-pack-actions" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 18 }}>
        <button type="button" className="fr-touch" onClick={build} disabled={busy !== null} style={primaryButton}>
          {busy === 'BUILD' ? 'Rebuilding…' : 'Rebuild from current case'}
        </button>
        <button type="button" className="fr-touch" onClick={() => window.print()} style={secondaryButton}>
          Print or save as PDF
        </button>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
        Version {stored.version}
        {stored.generatedAt ? ` · built ${new Date(stored.generatedAt).toLocaleString('en-GB')}` : ''}
        . Rebuilding replaces any edits you have made to the letter.
      </p>

      <Section title="Your case">
        <Rows
          rows={[
            ['Issuing authority', pack.caseSummary.authority],
            ['PCN number', pack.caseSummary.pcnNumberMasked],
            ['Vehicle', pack.caseSummary.vehicleRegistration],
            ['Contravention code', pack.caseSummary.contraventionCode],
            ['Contravention', pack.caseSummary.contravention],
            ['Location', pack.caseSummary.location],
            ['Alleged date', pack.caseSummary.incidentDate],
            ['Alleged time', pack.caseSummary.incidentTime],
            ['Stage', pack.caseSummary.stageLabel],
            ['Amount', pack.caseSummary.amount],
          ]}
        />
        {pack.caseSummary.unconfirmed.length > 0 && (
          <p style={{ margin: '12px 0 0', fontSize: 13.5, color: 'var(--text-muted)' }}>
            Not confirmed by you, so left out: {pack.caseSummary.unconfirmed.join('; ')}.
          </p>
        )}
      </Section>

      <Section title="Your account">
        {pack.account.userSays.length === 0 ? (
          <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-muted)' }}>
            You have not confirmed anything about what happened.
          </p>
        ) : (
          <ul style={listStyle}>
            {pack.account.userSays.map((statement) => (
              <li key={statement.reference}>
                <strong style={{ fontWeight: 550 }}>You say:</strong> {statement.text}
                <Provenance source={statement.source} />
              </li>
            ))}
          </ul>
        )}
        {pack.account.openQuestions.length > 0 && (
          <ul style={{ ...listStyle, marginTop: 12, color: 'var(--text-muted)' }}>
            {pack.account.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Your evidence">
        {pack.evidence.items.length === 0 ? (
          <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-muted)' }}>
            Nothing has been uploaded and checked yet, so this pack rests on your account alone.
          </p>
        ) : (
          <ul style={listStyle}>
            {pack.evidence.items.map((item) => (
              <li key={item.evidenceId} style={{ marginBottom: 12 }}>
                <strong style={{ fontWeight: 600 }}>{item.label}</strong>{' '}
                <span
                  className="fr-eyebrow"
                  style={{ color: standingColour(item.standing) }}
                >
                  {item.standing.toLowerCase()}
                </span>
                <div style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 3 }}>
                  {item.standingReason}
                </div>
                <ul style={{ ...listStyle, marginTop: 6, fontSize: 13.5 }}>
                  {item.verifiedFacts.map((fact) => (
                    <li key={fact.text}>{fact.text}</li>
                  ))}
                </ul>
                {item.contradicts.map((line) => (
                  <div key={line} style={{ fontSize: 13.5, color: 'var(--color-urgent)', marginTop: 4 }}>
                    {line}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
        {pack.evidence.declaredButNotHeld.length > 0 && (
          <p style={{ margin: '12px 0 0', fontSize: 13.5, color: 'var(--text-muted)' }}>
            You told us about, and we have not seen:{' '}
            {pack.evidence.declaredButNotHeld.join('; ')}. This pack does not claim these exist.
          </p>
        )}
      </Section>

      <Section title="Your strongest factual points">
        {pack.factualPoints.length === 0 ? (
          <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-muted)' }}>
            There is nothing here the record supports yet.
          </p>
        ) : (
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 12, fontSize: 14.5 }}>
            {pack.factualPoints.map((point) => (
              <li key={point.id}>
                <strong style={{ fontWeight: 600 }}>{point.headline}</strong>
                {/*
                  What the point rests on, on the point itself.

                  A reader skimming a list headed "strongest factual points"
                  will take every line as established unless each one says
                  otherwise. Evidence-backed points come first; this is what
                  stops the rest reading as though they were.
                */}
                <div
                  className="fr-eyebrow"
                  style={{
                    marginTop: 2,
                    color:
                      point.basis === 'VERIFIED_EVIDENCE'
                        ? 'var(--color-ok)'
                        : 'var(--text-faint)',
                  }}
                >
                  {POINT_BASIS_LABELS[point.basis]}
                </div>
                <div style={{ marginTop: 3 }}>{point.detail}</div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="What could weaken this">
        <p style={{ margin: '0 0 10px', fontSize: 13.5, color: 'var(--text-muted)' }}>
          Everything here is something an authority may already be able to see. Raising it
          yourself is better than being answered with it.
        </p>
        <ul style={listStyle}>
          {pack.weaknesses.map((weakness) => (
            <li key={weakness.id} style={{ marginBottom: 8 }}>
              {weakness.what}
              {weakness.whyItMatters && (
                <div style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  {weakness.whyItMatters}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Before you submit">
        {/*
          Three things, not six.

          A flat list of everything the reference store can justify asking for
          reads as a tribunal bundle, and to somebody deciding whether to
          challenge at all it makes the job look bigger than it is. The rest is
          a disclosure away rather than gone.
        */}
        {pack.checklistSections.alreadyHave.length > 0 && (
          <ChecklistGroup heading="Already have" entries={pack.checklistSections.alreadyHave} />
        )}
        {pack.checklistSections.mostUseful.length > 0 && (
          <ChecklistGroup heading="Most useful" entries={pack.checklistSections.mostUseful} />
        )}
        {(pack.checklistSections.other.length > 0 ||
          pack.checklistSections.notRelevant.length > 0) && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 550 }}>
              Other evidence that may help
            </summary>
            <div style={{ marginTop: 8 }}>
              {pack.checklistSections.other.length > 0 && (
                <ChecklistGroup heading="Also worth having" entries={pack.checklistSections.other} />
              )}
              {pack.checklistSections.notRelevant.length > 0 && (
                <ChecklistGroup
                  heading="Not relevant to this case"
                  entries={pack.checklistSections.notRelevant}
                  showNotes={false}
                />
              )}
            </div>
          </details>
        )}
      </Section>

      <Section title="Important dates">
        {pack.dates.deadlines.length === 0 ? (
          <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-muted)' }}>
            No date on this case has been confirmed from your notice.
          </p>
        ) : (
          <Rows rows={pack.dates.deadlines.map((d) => [d.label, d.date])} />
        )}
        {pack.dates.refused.length > 0 && (
          <ul style={{ ...listStyle, marginTop: 10, fontSize: 13.5, color: 'var(--text-muted)' }}>
            {pack.dates.refused.map((refused) => (
              <li key={refused.label}>{refused.message}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="How well evidenced this is">
        <strong style={{ fontSize: 15.5 }}>{EVIDENCE_BASIS_LABELS[pack.evidenceBasis]}</strong>
        <p style={{ margin: '6px 0 0', fontSize: 14.5, color: 'var(--text-muted)' }}>
          {pack.evidenceBasisExplanation}
        </p>
        <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--text-faint)' }}>
          {pack.legalPosition.explanation}
        </p>
      </Section>

      <Section title="Your challenge letter">
        {letterNote && (
          <p role="status" style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--color-urgent)' }}>
            {letterNote}
          </p>
        )}
        {letter === '' ? (
          <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-muted)' }}>
            No letter has been drafted for this pack. Everything above is still yours to use.
          </p>
        ) : editing ? (
          <>
            <textarea
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              rows={16}
              style={{
                width: '100%',
                fontSize: 15,
                lineHeight: 1.55,
                padding: 12,
                borderRadius: 8,
                border: '1px solid var(--border)',
                fontFamily: 'inherit',
              }}
            />
            <p style={{ margin: '6px 0 10px', fontSize: 13, color: 'var(--text-faint)' }}>
              Editing this changes the letter only. The case details, your evidence and the
              findings above are not affected by anything you type here.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" className="fr-touch" onClick={saveEdit} disabled={busy !== null} style={primaryButton}>
                {busy === 'SAVE' ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" className="fr-touch" onClick={() => setEditing(false)} style={secondaryButton}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                whiteSpace: 'pre-wrap',
                fontSize: 15,
                lineHeight: 1.6,
                padding: 14,
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              {letter}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <button type="button" className="fr-touch" onClick={copy} style={secondaryButton}>
                {copied ? 'Copied' : 'Copy letter'}
              </button>
              <button
                type="button"
                className="fr-touch"
                onClick={() => {
                  setDraftText(letter);
                  setEditing(true);
                }}
                style={secondaryButton}
              >
                Edit letter
              </button>
            </div>
            {stored.editedBody !== null && (
              <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-faint)' }}>
                You have edited this letter. What we originally drafted is kept underneath.
              </p>
            )}
          </>
        )}
      </Section>
    </>
  );
}

function ChecklistGroup({
  heading,
  entries,
  showNotes = true,
}: {
  heading: string;
  entries: readonly { type: string; label: string; note: string }[];
  showNotes?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="fr-eyebrow" style={{ marginBottom: 4 }}>
        {heading}
      </div>
      <ul style={listStyle}>
        {entries.map((entry) => (
          <li key={entry.type}>
            {entry.label}
            {showNotes && <span style={{ color: 'var(--text-muted)' }}> — {entry.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const listStyle = { margin: 0, paddingLeft: 18, display: 'grid', gap: 5, fontSize: 14.5 } as const;

const primaryButton = {
  padding: '0 20px',
  background: 'var(--btn-primary-bg)',
  color: 'var(--btn-primary-fg)',
  border: 'none',
  borderRadius: 'var(--radius-md)',
  fontSize: 15,
  fontWeight: 550,
  cursor: 'pointer',
} as const;

const secondaryButton = {
  padding: '0 18px',
  background: 'transparent',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  fontSize: 15,
  fontWeight: 550,
  cursor: 'pointer',
} as const;

function standingColour(standing: string): string {
  if (standing === 'CONFLICTING') return 'var(--color-urgent)';
  if (standing === 'CORROBORATIVE') return 'var(--color-ok)';
  return 'var(--text-faint)';
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      style={{
        marginTop: 16,
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--color-urgent)',
        fontSize: 14,
      }}
    >
      {children}
    </p>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 22 }} className="fr-pack-section">
      <h2 style={{ fontSize: 17, fontWeight: 620, marginBottom: 10 }}>{title}</h2>
      <Card>{children}</Card>
    </section>
  );
}

function Rows({ rows }: { rows: readonly (readonly [string, string | null])[] }) {
  const present = rows.filter(([, value]) => value !== null && value !== '');
  return (
    <dl style={{ margin: 0, display: 'grid', gap: 7, fontSize: 14.5 }}>
      {present.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <dt style={{ minWidth: 150, color: 'var(--text-muted)' }}>{label}</dt>
          <dd style={{ margin: 0, fontWeight: 550 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Provenance({ source }: { source: keyof typeof PROVENANCE_LABELS }) {
  return (
    <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-faint)' }}>
      {PROVENANCE_LABELS[source]}
    </span>
  );
}
