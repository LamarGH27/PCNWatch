import type { NormalisedPcnEvent } from '@/data-sources/shared/types';

/**
 * In-flight aggregation.
 *
 * The pipeline used to write one row per notice and then rebuild aggregates by
 * reading them back. That cost roughly 1.5 kB of database per PCN to answer
 * questions none of which are asked per PCN. Here the notices are counted as
 * they stream past and then dropped.
 *
 * The accumulator is bounded by the number of distinct
 * (location, day, contravention, class) combinations held at once, not by the
 * number of notices — and the caller flushes it when it grows, so a borough with
 * five years of history costs no more memory than one with five days.
 *
 * Flushing partway is safe because the database merge adds counts and adds
 * histograms slot by slot, so a key that reappears in a later page accumulates
 * rather than overwrites.
 */

/** One aggregated cell: many PCNs, one row. */
export interface DailyActivityKey {
  readonly locationSlug: string;
  readonly activityDate: string;
  readonly contraventionCode: string | null;
  readonly enforcementClass: NormalisedPcnEvent['enforcementType'];
}

export interface DailyActivityCell extends DailyActivityKey {
  pcnCount: number;
  /** 24 slots, index = hour. Sums to pcnCount where the source gave times. */
  hourHistogram: number[];
  /** Weakest confidence of the notices counted here. */
  minConfidence: number;
  /** True only when every notice counted here was camera-issued. */
  viaCctv: boolean | null;
}

/** One wording an authority used for a code, and how often. */
export interface ContraventionLabelCount {
  readonly code: string;
  readonly description: string;
  count: number;
}

/** What a location needs, kept once rather than per notice. */
export interface LocationFacts {
  readonly slug: string;
  displayName: string;
  streetName: string;
  streetNameNormalised: string;
  sourceLocationRaw: string;
  locality: string | null;
  postcodeDistrict: string | null;
  longitude: number | null;
  latitude: number | null;
  geometrySource: string | null;
  geometryMethod: string | null;
  geometryConfidence: number | null;
  /** Source record the position came from, so a placement can be re-checked. */
  geometryFromRecordId: string | null;
  bestConfidence: number;
}

function keyOf(k: DailyActivityKey): string {
  return `${k.locationSlug} ${k.activityDate} ${k.contraventionCode ?? ''} ${k.enforcementClass}`;
}

export class ActivityAccumulator {
  private readonly cells = new Map<string, DailyActivityCell>();
  private readonly locations = new Map<string, LocationFacts>();
  private readonly labels = new Map<string, ContraventionLabelCount>();

  /** Notices counted since construction, including those already flushed. */
  private counted = 0;

  get cellCount(): number {
    return this.cells.size;
  }

  get locationCount(): number {
    return this.locations.size;
  }

  get totalCounted(): number {
    return this.counted;
  }

  get labelCount(): number {
    return this.labels.size;
  }

  add(event: NormalisedPcnEvent): void {
    this.counted += 1;

    const cellKey = keyOf({
      locationSlug: event.locationSlug,
      activityDate: event.issuedDate,
      contraventionCode: event.contraventionCode,
      enforcementClass: event.enforcementType,
    });

    let cell = this.cells.get(cellKey);
    if (!cell) {
      cell = {
        locationSlug: event.locationSlug,
        activityDate: event.issuedDate,
        contraventionCode: event.contraventionCode,
        enforcementClass: event.enforcementType,
        pcnCount: 0,
        hourHistogram: new Array<number>(24).fill(0),
        minConfidence: 1,
        viaCctv: null,
      };
      this.cells.set(cellKey, cell);
    }

    cell.pcnCount += 1;
    const hour = event.issuedHour;
    if (hour !== null && hour >= 0 && hour < 24) {
      cell.hourHistogram[hour] = (cell.hourHistogram[hour] ?? 0) + 1;
    }
    cell.minConfidence = Math.min(cell.minConfidence, event.dataConfidence);

    // A channel claim holds only if it holds for every notice in the cell.
    const cctv = readCctv(event);
    if (cell.pcnCount === 1) cell.viaCctv = cctv;
    else if (cell.viaCctv !== cctv) cell.viaCctv = null;

    this.rememberLocation(event);
    this.rememberLabel(event);
  }

  /**
   * The authority's own wording for a code, counted across the whole run.
   *
   * Bounded by distinct code-and-wording pairs — Camden publishes a few dozen —
   * so unlike the cells this is never flushed partway. Counting it here is what
   * lets the labels be replaced wholesale at publication: they then describe the
   * dataset being published rather than accumulating across every past run.
   */
  private rememberLabel(event: NormalisedPcnEvent): void {
    if (!event.contraventionCode) return;
    const raw = event.sourceMetadata['contravention_code_description'];
    if (typeof raw !== 'string') return;
    const description = raw.trim();
    if (description === '') return;

    const key = `${event.contraventionCode}\u0000${description}`;
    const existing = this.labels.get(key);
    if (existing) existing.count += 1;
    else this.labels.set(key, { code: event.contraventionCode, description, count: 1 });
  }

  /**
   * A location keeps the best evidence seen for it across the whole run: a
   * notice that can place the street beats one that cannot. Deciding this per
   * batch is what once left a street with 8,774 positioned notices unplaced.
   */
  private rememberLocation(event: NormalisedPcnEvent): void {
    const existing = this.locations.get(event.locationSlug);
    const hasPosition = event.longitude !== null && event.latitude !== null;

    if (!existing) {
      this.locations.set(event.locationSlug, {
        slug: event.locationSlug,
        displayName: event.streetName,
        streetName: event.streetName,
        streetNameNormalised: event.streetNameNormalised,
        sourceLocationRaw: event.streetName,
        locality: event.locality,
        postcodeDistrict: event.postcodeDistrict,
        longitude: hasPosition ? event.longitude : null,
        latitude: hasPosition ? event.latitude : null,
        geometrySource: hasPosition ? 'SOURCE_PUBLISHED' : null,
        geometryMethod: hasPosition ? 'REPRESENTATIVE_EVENT' : null,
        geometryConfidence: hasPosition ? event.dataConfidence : null,
        geometryFromRecordId: hasPosition ? event.sourceRecordId : null,
        bestConfidence: event.dataConfidence,
      });
      return;
    }

    // Keep the first position found, so re-ingesting the same data places a
    // street in the same spot every time.
    if (hasPosition && existing.longitude === null) {
      existing.longitude = event.longitude;
      existing.latitude = event.latitude;
      existing.geometrySource = 'SOURCE_PUBLISHED';
      existing.geometryMethod = 'REPRESENTATIVE_EVENT';
      existing.geometryConfidence = event.dataConfidence;
      existing.geometryFromRecordId = event.sourceRecordId;
    }
    if (event.dataConfidence > existing.bestConfidence) {
      existing.bestConfidence = event.dataConfidence;
    }
    existing.locality ??= event.locality;
    existing.postcodeDistrict ??= event.postcodeDistrict;
  }

  /** Everything accumulated so far. The caller writes it, then clears cells. */
  drain(): { cells: DailyActivityCell[]; locations: LocationFacts[] } {
    return { cells: [...this.cells.values()], locations: [...this.locations.values()] };
  }

  /** Every wording seen for every code, with its count. */
  drainLabels(): ContraventionLabelCount[] {
    return [...this.labels.values()];
  }

  /**
   * Forgets the cells, keeps the locations.
   *
   * Cells merge in the database, so dropping them is safe. Locations must not be
   * dropped: their geometry is chosen from the best notice across the entire
   * run, and forgetting a positioned street between flushes would reintroduce
   * exactly the batch-order bug this class exists to avoid. A borough has
   * thousands of locations, not millions, so holding them all is bounded.
   */
  clearCells(): void {
    this.cells.clear();
  }
}

function readCctv(event: NormalisedPcnEvent): boolean | null {
  const value = event.sourceMetadata['_viaCctv'];
  return typeof value === 'boolean' ? value : null;
}
