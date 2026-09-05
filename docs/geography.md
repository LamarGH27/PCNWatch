# Geography: where a PCN happened, and where we may draw it

Camden's published PCN dataset (`4k7m-4gkk`) contains **no coordinates**. It
contains a street name and a `spatial_accuracy` value of `Unknown` — the
publisher makes no claim at all about how precisely a notice is located.

Everything below follows from that one fact.

`Unknown` is kept verbatim for traceability but is never read as a precision
claim (`publisherClaimsPrecision`). Treating it as a weak claim would be worse
than having no field: it would let a caller believe a claim exists.

---

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

- Nothing is drawn on the map.
- `dataConfidence` is capped below the scoring gate, so locations are refused a
  Ticket Activity Score rather than given a weak one.
- The quality gate fails with `mapReadiness = NO_SOURCE_GEOGRAPHY`, and says the
  records are intact and worth storing.

The non-geographic intelligence still works on real data: which streets, which
contraventions, what times, what enforcement classes, what trend.

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

**What it would take** (deliberately not built yet — the MVP does not require it,
and building it before the ticket-type and schema fixes are confirmed against
live data would be building on unproven ground):

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
