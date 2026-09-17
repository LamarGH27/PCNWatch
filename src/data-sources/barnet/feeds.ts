import type { EnforcementClass } from '@/data-sources/camden/enforcement-class';

/**
 * Barnet publishes three raw CSVs, one per enforcement regime.
 *
 * They are three *feeds* of one source, not three sources, and the database
 * decides that rather than taste: `enforcement_dataset_versions` allows one
 * ACTIVE version per authority, so ingesting them separately would leave each
 * run superseding the last and only ever one third of Barnet visible.
 *
 * So one adapter reads all three and emits a single stream. The consequence
 * worth stating: a feed that fails takes the whole run with it, which is
 * correct — publishing "Barnet" while silently missing its bus lanes would be
 * a claim about enforcement that is not true.
 */

export type BarnetFeedKey = 'PARKING' | 'BUS_LANE' | 'MOVING_TRAFFIC';

export interface BarnetFeed {
  readonly key: BarnetFeedKey;
  /**
   * The enforcement class every row of this feed carries.
   *
   * Taken from which dataset the row came from, never inferred from its
   * contravention code. Barnet's own datasets are the authority on which regime
   * issued a notice, and a code read out of context is a guess.
   */
  readonly enforcementClass: EnforcementClass;
  /** Environment variable holding the path or glob for this feed's CSV(s). */
  readonly pathEnvVar: string;
  readonly datasetName: string;
  readonly datasetUrl: string;
  /**
   * Whether "A, B" in this feed's location column means "street, qualifier".
   *
   * True only for Parking, where the comma separates a postcode district or a
   * locality from the street ("BALLARDS LANE, N3") and the street is the thing
   * being ranked.
   *
   * False for the camera feeds, where the comma is part of the site's name
   * ("A5 West Hendon Broadway (NW9), junction with Cool Oak Lane"). Splitting
   * there merged three separate cameras on that road into one location and
   * would have credited all their activity to a single point on a ranking.
   */
  readonly splitsLocationQualifier: boolean;
  /** Column holding the event date, as the feed spells it. */
  readonly dateColumn: string;
  readonly timeColumn: string;
  readonly locationColumn: string;
}

export const BARNET_FEEDS: readonly BarnetFeed[] = [
  {
    key: 'PARKING',
    enforcementClass: 'PARKING',
    pathEnvVar: 'BARNET_PARKING_CSV',
    datasetName: 'Parking PCN raw data',
    datasetUrl: 'https://open.barnet.gov.uk/dataset/parking-pcn-dashboard-24r8e',
    splitsLocationQualifier: true,
    dateColumn: 'Date',
    timeColumn: 'Time',
    locationColumn: 'Street',
  },
  {
    key: 'BUS_LANE',
    enforcementClass: 'BUS_LANE',
    pathEnvVar: 'BARNET_BUS_LANE_CSV',
    datasetName: 'Bus Lane PCN raw data',
    datasetUrl: 'https://open.barnet.gov.uk/dataset/bus-lane-pcn-dashboard-em852',
    splitsLocationQualifier: false,
    dateColumn: 'Issue Date',
    timeColumn: 'Issue time',
    locationColumn: 'Location',
  },
  {
    key: 'MOVING_TRAFFIC',
    enforcementClass: 'MOVING_TRAFFIC',
    pathEnvVar: 'BARNET_MOVING_TRAFFIC_CSV',
    datasetName: 'Moving Traffic PCN raw data',
    datasetUrl: 'https://open.barnet.gov.uk/dataset/moving-traffic-pcn-dashboard-2r84e',
    splitsLocationQualifier: false,
    dateColumn: 'Issue Date',
    timeColumn: 'Issue time',
    locationColumn: 'Location',
  },
];

export function feedFor(key: BarnetFeedKey): BarnetFeed {
  const feed = BARNET_FEEDS.find((f) => f.key === key);
  if (!feed) throw new Error(`Unknown Barnet feed "${key}".`);
  return feed;
}
