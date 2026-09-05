# Geography: where a PCN happened, and where we may draw it

Camden's published PCN dataset (`4k7m-4gkk`) publishes coordinates for **some**
of its notices and not others. A whole-dataset census found **296,978 rows** with
`latitude`, `longitude` and a Socrata `location` column. Every row carries a
street name and a `spatial_accuracy` of `Unknown` — the publisher makes no claim
about how precisely a notice is located, even where it gives a position.

**This was got wrong, repeatedly.** Four separate 50-row probes showed no
coordinate column and the conclusion drawn was that the dataset had none. Socrata
omits null fields per row, so a column absent from every row of a sample never
appears in that sample at all: a dataset with partial geography is
indistinguishable from one with none, if you only ever look at 50 rows. The probe
now asks the whole dataset directly — `$select=count(*)` with
`$where <column> IS NOT NULL` per candidate column — and samples rows selected
*because* they have a position, so the adapter is proven against them rather than
assumed to handle them.

The consequence for the product is partial coverage, which has to be stated
rather than left to be assumed:

- The map draws the geolocated subset. It is true about every point it shows and
  silent about the rest, and on a map silence reads as an absence of enforcement.
  So the map states the share it is showing and points at hotspots for the whole.
- Hotspot ranking uses every notice, geolocated or not — ranking is not mapping.

## The separation

Two things are kept apart permanently, in the type system
(`src/core/geography/types.ts`), because conflating them is how a product ends up
showing a made-up position as if the council had published it.

**A. Source location** — `SourceLocation`. What the authority actually published:
street name, controlled parking zone, postcode district, and the publisher's own
precision claim, verbatim. We never alter this.

Camden publishes no postcode column — the district is inside the street value
(`MAPLE STREET W1`). Reading it out is a derivation from the source's own text,
not an external lookup, so it stays A-side; it is stamped
`_postcodeDistrictSource: DERIVED_FROM_STREET_VALUE` so it is never mistaken for
a published field. The district also stays in the location identity: splitting a
street sometimes recorded without its district is visible in the data, whereas
silently merging two real streets of the same name is not.

**B. Derived geometry** — `DerivedGeometry`. A coordinate. It exists only with
provenance attached:

| Field | Why it exists |
| --- | --- |
| `origin` | `SOURCE_PUBLISHED` or `STREET_REFERENCE`. Never blank. |
| `method` | How the match was made — a source point, an exact name, a USRN. |
| `referenceSource` | Which dataset, or which source column. |
| `referenceVersion` | Which *release* of it, so a match is reproducible. |
| `referenceRecordId` | The matched record, so a match can be re-checked. |
| `confidence` | Confidence in the match, distinct from row completeness. |
| `lookedUpAt` | When, so a stale match can be found and redone. |
| `precision` | `POINT`, `STREET` or `AREA`. A street match may not claim `POINT`. |

`assertGeometryProvenance` throws when any of that is missing, so a coordinate
without provenance is a construction error rather than something to catch in
review. There is no code path that produces a position any other way.

Absence is a first-class value, not a null: `NoGeometry` carries a reason —
`SOURCE_PUBLISHES_NO_COORDINATES`, `SOURCE_COORDINATES_UNUSABLE`,
`NO_STREET_REFERENCE_CONFIGURED`, `STREET_NOT_IN_REFERENCE`. The ingestion
report counts them separately and the quality gate names the right remedy for
each: a dataset with no geography needs a reference, one whose geography we
cannot read needs an adapter fix.

---

## Current behaviour

No street reference is configured. `UnavailableStreetReference` resolves nothing.
Every Camden record therefore has `longitude = null`, `latitude = null`,
`precision = NONE`, and a recorded reason. Consequences, all intended:

- Nothing is drawn on the map, and the map says why: "this authority publishes
  its penalty charge notices without any location coordinates". It does not say
  "no recorded PCNs", which would be a false statement about enforcement.
- Streets are still ranked. Geometry is **not** an input to the Ticket Activity
  Score — see below.
- The quality gate passes with `mapReadiness = NO_SOURCE_GEOGRAPHY` and a loud
  caution. The stored data is usable as enforcement intelligence; it just cannot
  be mapped, and those are different questions.

The non-geographic intelligence works on real data: which streets, which
contraventions, what times, what enforcement classes, what trend.

### Ranking is not mapping

This was got wrong once and is worth stating plainly. The scoring engine used to
refuse any location without geometry, and `dataConfidence` was capped below the
scoring gate when a row had no coordinate. Against Camden's real data that meant
every street was refused a score while the counts behind it were perfectly sound
— the core of the product, empty, because of a question it never needed to ask.

The Ticket Activity Score measures recorded enforcement activity at a named
location: the street, the counts, the dates. It does not need a coordinate, and
geometry is now not an input to it at all — a location scores identically with or
without one. Mappability is enforced where it belongs, in the SQL behind the map,
which filters on `geom is not null`. `MODEL_VERSION` moved to `tas-2.0.0`,
because stored scores from before this change mean something different.

---

## Recommendation: OS Open USRN

The smallest trustworthy way to turn `street` into geometry.

**What it is.** The National Street Gazetteer's Unique Street Reference Numbers,
published by Ordnance Survey with GeoPlace as a free open dataset under the Open
Government Licence. Every street in Great Britain, each with a stable USRN and a
geometry, released quarterly as a single download.

**Why this one:**

- *Authoritative.* USRNs are the statutory street identifiers local authorities
  themselves use. Camden's own street naming is the same reference.
- *Reproducible.* A quoted release (`2026-07`) plus a USRN is a position anyone
  can verify. A commercial geocoder's answer changes silently as its index does.
- *Licence permits what we need.* OGL v3.0 allows storing and displaying the
  geometry with attribution. Most geocoding APIs forbid retaining results.
- *Honest about precision.* A USRN geometry is a street, and we would record it
  as `STREET`. Note that this is a stronger claim than Camden itself makes — the
  publisher says `Unknown` — so the claim would rest on the reference dataset,
  which is exactly why its identifier and release must be recorded with it.

**What it would take.** Still not built, but the case has changed: it is no
longer the difference between a map and no map, it is the difference between
roughly a third of notices being placeable and all of them. That makes it a
coverage improvement rather than a prerequisite, and it can follow a first real
ingestion rather than block one.

1. Download the Camden extract of OS Open USRN once; store it in a
   `street_reference` table with `usrn`, normalised name, geometry, release.
2. Implement `StreetReferenceResolver` against that table: exact normalised-name
   match within the Camden boundary first, no fuzzy matching. An ambiguous or
   absent name returns `STREET_NOT_IN_REFERENCE` rather than a best guess.
3. Store the resolved geometry with its provenance and re-resolve when a new
   release is loaded. Nothing else in the pipeline changes.

That is roughly a table, a loader and a lookup — small, because the boundary it
plugs into already exists.

### Rejected alternatives

| Option | Why not |
| --- | --- |
| Commercial geocoding API | Not reproducible, licence usually forbids storing results, and we could not tell a user which authority stands behind the position. |
| Postcode centroids | Precise-looking and wrong. A postcode unit spans several streets; a street spans many postcodes. |
| Road centre "for display only" | Fabrication. A user cannot tell a display convenience from a recorded fact. |
| Fuzzy or AI-assisted matching | Produces a plausible answer where the truthful answer is "this street is not in the reference". |

---

## What the UI may say

- Never that a notice was issued *at a point* when the position came from a
  street reference. Street-level means the correct street, not a place on it.
- Never a parking-only caption over a mixed dataset. In the live 50-row sample
  there were **no parking rows at all**: 34 `O/S TMA` (unclassified by us) and 16
  `MTC` (moving traffic, camera-issued). Surfaces that show counts carry
  `MeasurementBasis`, which states that enforcement classes are counted together
  and that notices the authority did not classify are included.
- When nothing can be positioned, the map says the authority publishes no
  coordinates — not "no enforcement activity", and not a blank screen.
