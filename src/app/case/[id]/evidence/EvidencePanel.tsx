'use client';

import { useState } from 'react';
import { Card } from '@/components/primitives';
import { EVIDENCE_FIELD_LABELS } from '@/core/evidence/analysis';
import type { EvidenceItem } from '@/core/evidence/lifecycle';
import {
  EVIDENCE_STATUS_LABELS,
  EVIDENCE_STATUS_MEANING,
  supportsAssessment,
} from '@/core/evidence/lifecycle';
import { UNREAD_EVIDENCE_NOTE, isAnalysable } from '@/core/evidence/profiles';
import { readingsForCheck } from '@/core/evidence/verification';
import type { EvidenceAnalysis } from '@/core/evidence/analysis';
import type { EvidenceChecklistItem } from '@/core/evidence/types';
import { ACCEPTED_EVIDENCE_TYPES } from '@/core/evidence/upload-limits';

/**
 * Uploading, checking and deleting evidence.
 *
 * The screen is built around the one distinction that matters: a file we hold
 * is not the same as a document that supports the case, and the only thing that
 * closes the gap is the user reading what we read and saying it is right. So
 * every item says where it is in plain words, and an item waiting to be checked
 * asks for that and nothing else.
 *
 * Nothing here decides anything. The readings are transcriptions, the ticks are
 * the user agreeing with a transcription, and what any of it means for their
 * case is worked out elsewhere from rules.
 */

type Busy = { readonly id: string; readonly what: 'UPLOAD' | 'READ' | 'SAVE' | 'DELETE' } | null;

interface PanelProps {
  readonly caseId: string;
  readonly items: readonly EvidenceChecklistItem[];
  readonly evidence: readonly EvidenceItem[];
}

export function EvidencePanel({ caseId, items, evidence }: PanelProps) {
  const [held, setHeld] = useState<readonly EvidenceItem[]>(evidence);
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const replace = (item: EvidenceItem) =>
    setHeld((current) => {
      const index = current.findIndex((c) => c.id === item.id);
      if (index === -1) return [...current, item];
      const next = [...current];
      next[index] = item;
      return next;
    });

  async function upload(type: string, file: File) {
    setProblem(null);
    setBusy({ id: type, what: 'UPLOAD' });
    try {
      const body = new FormData();
      body.set('file', file);
      body.set('evidenceType', type);
      const response = await fetch(`/api/cases/${caseId}/evidence`, { method: 'POST', body });
      const result = (await response.json()) as {
        ok?: boolean;
        item?: EvidenceItem;
        message?: string;
        correlationId?: string;
        stage?: string | null;
      };
      if (!result.ok || !result.item) {
        /*
         * The reference is shown, not hidden.
         *
         * It is a random id that means nothing outside our logs, and quoting it
         * turns "it didn't work" into a line somebody can actually find. The
         * stage stays out of the sentence — it is for the log, not for someone
         * trying to upload a photograph.
         */
        setProblem(
          [
            result.message ?? 'We could not save that file. Nothing was stored.',
            result.correlationId ? `Reference: ${result.correlationId}` : null,
          ]
            .filter(Boolean)
            .join(' '),
        );
        return;
      }
      replace(result.item);
      // Read it straight away — an upload nobody has read is a dead end, and
      // making the user press a second button to find that out is unkind.
      await read(result.item.id);
    } catch {
      setProblem('We could not reach the server. Nothing was saved.');
    } finally {
      setBusy(null);
    }
  }

  async function read(evidenceId: string) {
    setBusy({ id: evidenceId, what: 'READ' });
    try {
      const response = await fetch(`/api/evidence/${evidenceId}/analyse`, { method: 'POST' });
      const result = (await response.json()) as {
        kind?: string;
        item?: EvidenceItem;
        what?: string;
        whatYouCanDo?: string;
      };
      if (result.item) replace(result.item);
      if (result.kind === 'FAILED') {
        setProblem(`${result.what ?? 'We could not read that file.'} ${result.whatYouCanDo ?? ''}`.trim());
      }
    } catch {
      setProblem('We could not reach the server. Your file is still on your case.');
    } finally {
      setBusy(null);
    }
  }

  async function confirm(evidenceId: string, confirmed: readonly number[]) {
    setProblem(null);
    setBusy({ id: evidenceId, what: 'SAVE' });
    try {
      const response = await fetch(`/api/evidence/${evidenceId}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed }),
      });
      const result = (await response.json()) as { ok?: boolean; item?: EvidenceItem };
      if (!result.ok || !result.item) {
        setProblem('We could not save what you checked. Nothing has changed.');
        return;
      }
      replace(result.item);
    } catch {
      setProblem('We could not reach the server. Nothing has changed.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(evidenceId: string) {
    setProblem(null);
    setBusy({ id: evidenceId, what: 'DELETE' });
    try {
      const response = await fetch(`/api/evidence/${evidenceId}`, { method: 'DELETE' });
      const result = (await response.json()) as { ok?: boolean };
      if (!result.ok) {
        setProblem('We could not delete that item.');
        return;
      }
      setHeld((current) => current.filter((c) => c.id !== evidenceId));
    } catch {
      setProblem('We could not reach the server. Nothing was deleted.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {problem && (
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
          {problem}
        </p>
      )}

      <ul style={{ listStyle: 'none', margin: '24px 0 0', padding: 0, display: 'grid', gap: 12 }}>
        {items.map((item) => {
          const mine = held.filter((h) => h.type === item.type);
          return (
            <li key={item.type}>
              <Card
                style={{
                  borderColor:
                    item.importance === 'ESSENTIAL' && !item.provided
                      ? 'var(--color-urgent)'
                      : 'var(--border)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 14,
                    alignItems: 'flex-start',
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <h2 style={{ fontSize: 16, fontWeight: 620 }}>{item.definition.label}</h2>
                    <div
                      className="fr-eyebrow"
                      style={{
                        marginTop: 4,
                        color:
                          item.importance === 'ESSENTIAL'
                            ? 'var(--color-urgent)'
                            : 'var(--text-faint)',
                      }}
                    >
                      {item.importance.toLowerCase()}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 550,
                      color: item.provided ? 'var(--color-ok)' : 'var(--text-faint)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {requirementState(item)}
                  </span>
                </div>

                <p style={{ margin: '10px 0 0', fontSize: 14.5 }}>{item.definition.howToCapture}</p>
                <p style={{ margin: '7px 0 0', fontSize: 13.5, color: 'var(--text-muted)' }}>
                  {item.definition.whyItMatters}
                </p>
                <p style={{ margin: '7px 0 0', fontSize: 13, color: 'var(--text-faint)' }}>
                  Why this case needs it: {item.reason}
                </p>

                {mine.length > 0 && (
                  <ul style={{ listStyle: 'none', margin: '14px 0 0', padding: 0, display: 'grid', gap: 10 }}>
                    {mine.map((file) => (
                      <li key={file.id}>
                        <HeldItem
                          item={file}
                          busy={busy}
                          onRead={() => read(file.id)}
                          onConfirm={(indexes) => confirm(file.id, indexes)}
                          onDelete={() => remove(file.id)}
                        />
                      </li>
                    ))}
                  </ul>
                )}

                <label
                  style={{
                    display: 'inline-block',
                    marginTop: 14,
                    fontSize: 14,
                    fontWeight: 550,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ textDecoration: 'underline' }}>
                    {busy?.id === item.type ? 'Uploading…' : `Add ${item.definition.label.toLowerCase()}`}
                  </span>
                  <input
                    type="file"
                    accept={ACCEPTED_EVIDENCE_TYPES.join(',')}
                    disabled={busy !== null}
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void upload(item.type, file);
                    }}
                  />
                </label>
              </Card>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function requirementState(item: EvidenceChecklistItem): string {
  if (item.provided) return `${item.itemCount} checked`;
  if (item.heldCount > 0) return `${item.heldCount} uploaded — needs your check`;
  return 'Not uploaded';
}

function HeldItem({
  item,
  busy,
  onRead,
  onConfirm,
  onDelete,
}: {
  item: EvidenceItem;
  busy: Busy;
  onRead: () => void;
  onConfirm: (indexes: readonly number[]) => void;
  onDelete: () => void;
}) {
  /*
   * Nothing is ticked to begin with.
   *
   * A confirmation screen that arrives pre-agreed is not a confirmation
   * screen — it is a consent form with the boxes filled in, and a user who
   * scrolls past it has confirmed readings nobody looked at. So every reading
   * starts unchecked and the user does the checking.
   */
  const [ticked, setTicked] = useState<readonly number[]>([]);
  const analysis = item.analysis as EvidenceAnalysis | null;
  const readings = analysis ? readingsForCheck(analysis) : [];
  const working = busy?.id === item.id;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 550 }}>
            {item.originalFilename ?? 'Uploaded file'}
          </div>
          <div
            className="fr-eyebrow"
            style={{
              marginTop: 3,
              color: supportsAssessment(item) ? 'var(--color-ok)' : 'var(--text-faint)',
            }}
          >
            {EVIDENCE_STATUS_LABELS[item.status]}
          </div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy !== null}
          style={{
            fontSize: 13,
            background: 'none',
            border: 'none',
            padding: 0,
            textDecoration: 'underline',
            cursor: busy === null ? 'pointer' : 'default',
            color: 'var(--text-muted)',
          }}
        >
          {working && busy?.what === 'DELETE' ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      <p style={{ margin: '8px 0 0', fontSize: 13.5, color: 'var(--text-muted)' }}>
        {EVIDENCE_STATUS_MEANING[item.status]}
      </p>

      {!isAnalysable(item.type) && (
        <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-faint)' }}>
          {UNREAD_EVIDENCE_NOTE}
        </p>
      )}

      {item.legibility === 'UNREADABLE' && (
        <p style={{ margin: '8px 0 0', fontSize: 13.5, color: 'var(--color-urgent)' }}>
          We could not make this out. It stays on your case, and it is not counted as supporting
          it. A clearer photograph, square-on and in good light, usually reads.
        </p>
      )}

      {item.analysisFailure && (
        <p style={{ margin: '8px 0 0', fontSize: 13.5 }}>
          The last attempt to read this did not work. Your file is still here.{' '}
          <button
            type="button"
            onClick={onRead}
            disabled={busy !== null}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              fontSize: 13.5,
              textDecoration: 'underline',
              cursor: busy === null ? 'pointer' : 'default',
            }}
          >
            {working && busy?.what === 'READ' ? 'Reading…' : 'Try again'}
          </button>
        </p>
      )}

      {item.status === 'ANALYSED' && readings.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: 0, fontSize: 13.5, fontWeight: 550 }}>
            Check what we read. Tick anything we got right.
          </p>
          <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 6 }}>
            {readings.map((reading) => (
              <li key={reading.index}>
                <label
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    fontSize: 14,
                    opacity: reading.confirmable ? 1 : 0.65,
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={!reading.confirmable || busy !== null}
                    checked={ticked.includes(reading.index)}
                    onChange={(event) =>
                      setTicked((current) =>
                        event.target.checked
                          ? [...current, reading.index]
                          : current.filter((i) => i !== reading.index),
                      )
                    }
                  />
                  <span>
                    <strong style={{ fontWeight: 550 }}>{reading.label}:</strong>{' '}
                    {reading.confirmable ? reading.value : 'could not be read'}
                    {reading.hint && (
                      <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-faint)' }}>
                        {reading.hint}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => onConfirm(ticked)}
            disabled={busy !== null}
            className="fr-button"
            style={{ marginTop: 10, fontSize: 14 }}
          >
            {working && busy?.what === 'SAVE' ? 'Saving…' : 'Save what I have checked'}
          </button>
          <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
            Leave anything we got wrong unticked. Only what you tick is used, and saving with
            nothing ticked tells us this document does not say what we thought.
          </p>
        </div>
      )}

      {item.status === 'VERIFIED' && item.verifiedFacts.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, fontSize: 13.5 }}>
          {item.verifiedFacts.map((fact) => (
            <li key={`${fact.field}-${fact.value}`}>
              <strong style={{ fontWeight: 550 }}>
                {EVIDENCE_FIELD_LABELS[fact.field as keyof typeof EVIDENCE_FIELD_LABELS] ??
                  fact.field}
                :
              </strong>{' '}
              {fact.value}
            </li>
          ))}
        </ul>
      )}

      {item.status === 'VERIFIED' && item.verifiedFacts.length === 0 && (
        <p style={{ margin: '8px 0 0', fontSize: 13.5, color: 'var(--text-muted)' }}>
          You told us we did not read anything on this correctly, so nothing from it is being
          used.
        </p>
      )}
    </div>
  );
}
