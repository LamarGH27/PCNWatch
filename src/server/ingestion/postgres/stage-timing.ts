import { logInfo } from '@/lib/errors';

/**
 * Where an ingestion spent its time.
 *
 * The first full Camden run died on a statement timeout after 274 seconds and
 * reported one number: the total. Which of a dozen stages consumed it had to be
 * reconstructed by reading the code and re-running the suspects against a
 * Camden-scale database. That is an expensive way to learn something the run
 * already knew.
 *
 * Every stage is timed and logged as it completes, so the next failure names
 * the operation itself. Stage names are compile-time constants and the payload
 * is a duration and a count — nothing here can carry a connection string, a
 * token or anything about a vehicle.
 */

export type IngestionStage =
  | 'FETCH'
  | 'NORMALISE'
  | 'LOCATION_RESOLUTION'
  | 'AGGREGATE_FLUSH'
  | 'INDEX_COMPACTION'
  | 'RECONCILIATION'
  | 'QUALITY_GATE'
  | 'SCORING_30D'
  | 'SCORING_90D'
  | 'SCORING_12M'
  | 'PUBLICATION'
  | 'OLD_VERSION_CLEANUP';

export interface StageTiming {
  readonly stage: IngestionStage;
  readonly ms: number;
  /** Rows, cells or locations the stage handled, where that is meaningful. */
  readonly items: number | null;
}

export class StageTimer {
  private readonly timings: StageTiming[] = [];
  /** Stages interleaved with streaming accumulate rather than replace. */
  private readonly accumulated = new Map<IngestionStage, { ms: number; items: number }>();

  /** Times an awaited stage, logs it, and returns whatever it returned. */
  async time<T>(
    stage: IngestionStage,
    fn: () => Promise<T>,
    items?: (result: T) => number,
  ): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.record(stage, Date.now() - started, items ? items(result) : null);
      return result;
    } catch (error) {
      // A stage that threw is the most important one to have timed.
      this.record(stage, Date.now() - started, null);
      throw error;
    }
  }

  /** Adds to a stage that runs repeatedly, such as a per-page normalise. */
  add(stage: IngestionStage, ms: number, items = 0): void {
    const existing = this.accumulated.get(stage) ?? { ms: 0, items: 0 };
    this.accumulated.set(stage, { ms: existing.ms + ms, items: existing.items + items });
  }

  private record(stage: IngestionStage, ms: number, items: number | null): void {
    this.timings.push({ stage, ms, items });
    logInfo('ingestion.stage', stage, { ms, items });
  }

  /** Every stage, in the order it finished, with accumulated ones folded in. */
  report(): StageTiming[] {
    const accumulated: StageTiming[] = [...this.accumulated].map(([stage, v]) => ({
      stage,
      ms: v.ms,
      items: v.items,
    }));
    return [...accumulated, ...this.timings].sort((a, b) => b.ms - a.ms);
  }

  /** Logs the accumulated stages once streaming is done. */
  flushAccumulated(): void {
    for (const [stage, v] of this.accumulated) {
      logInfo('ingestion.stage', stage, { ms: v.ms, items: v.items });
    }
  }
}
