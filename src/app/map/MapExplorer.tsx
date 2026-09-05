'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import maplibregl, { type Map as MapLibreMap, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { publicEnv, isPlaceholderMapStyle} from '@/lib/env';
import { SCORE_DISCLAIMER } from '@/core/scoring/config';
import type { ScoreClassification } from '@/core/scoring/types';

/**
 * The enforcement map.
 *
 * Data flow: the map reports its viewport, the client asks the server for binned
 * cells for that viewport and zoom, and renders them. Raw PCN events never cross
 * the wire — at low zoom the server returns cells, at high zoom individual
 * locations, and either way the payload is bounded.
 *
 * Every state the map can be in is explicit: loading, error, empty-but-covered,
 * and not-covered are four different things and each says so.
 */

const CAMDEN_CENTRE: [number, number] = [-0.1426, 51.5388];

const CLASSIFICATION_COLOUR: Record<ScoreClassification | 'UNSCORED', string> = {
  VERY_LOW: '#4c9f8a',
  LOW: '#a8bf6a',
  MODERATE: '#e0b452',
  HIGH: '#d9803f',
  VERY_HIGH: '#b8443c',
  UNSCORED: '#838b95',
};

export interface MapCell {
  cellKey: string;
  longitude: number;
  latitude: number;
  pcnCount: number;
  locationCount: number;
  maxScore: number | null;
  maxClassification: ScoreClassification | null;
  isSingleLocation: boolean;
  locationSlug: string | null;
  displayName: string | null;
}

type LoadState =
  | { kind: 'IDLE' }
  | { kind: 'LOADING' }
  | { kind: 'READY'; cells: MapCell[]; totalPcns: number }
  | { kind: 'ERROR'; message: string; correlationId: string | null };

type Period = '30D' | '90D' | '12M';

const PERIODS: { value: Period; label: string }[] = [
  { value: '30D', label: '30 days' },
  { value: '90D', label: '90 days' },
  { value: '12M', label: '12 months' },
];

export function MapExplorer({
  authoritySlug,
  canShowActivity,
  coverageHeadline,
  coverageDetail,
  hasMappableGeography,
  mappableEventShare,
  mappedEventShare,
}: {
  authoritySlug: string;
  canShowActivity: boolean;
  coverageHeadline: string;
  coverageDetail: string;
  /** False when the authority publishes enforcement records without positions. */
  hasMappableGeography: boolean;
  /** Share of recorded notices carrying a position of their own, 0–1. */
  mappableEventShare: number | null;
  /** Share of recorded notices that appear on the map at all, 0–1. */
  mappedEventShare: number | null;
}) {
  const [basemapError, setBasemapError] = useState<string | null>(null);
  const usingPlaceholderBasemap = isPlaceholderMapStyle(publicEnv.NEXT_PUBLIC_MAP_STYLE_URL);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const requestSeq = useRef(0);

  const [state, setState] = useState<LoadState>({ kind: 'IDLE' });
  const [period, setPeriod] = useState<Period>('12M');
  const [contravention, setContravention] = useState<string>('');
  const [selected, setSelected] = useState<MapCell | null>(null);
  const [search, setSearch] = useState('');
  const searchId = useId();

  /* -- Load cells for the current viewport -------------------------------- */

  const loadCells = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !canShowActivity) return;

    const seq = ++requestSeq.current;
    setState((prev) => (prev.kind === 'READY' ? prev : { kind: 'LOADING' }));

    const bounds = map.getBounds();
    const params = new URLSearchParams({
      authority: authoritySlug,
      minLon: String(bounds.getWest()),
      minLat: String(bounds.getSouth()),
      maxLon: String(bounds.getEast()),
      maxLat: String(bounds.getNorth()),
      zoom: String(Math.round(map.getZoom())),
      period,
    });
    if (contravention) params.set('contravention', contravention);

    try {
      const response = await fetch(`/api/map/cells?${params}`);
      // A stale response from an earlier viewport must never overwrite a newer one.
      if (seq !== requestSeq.current) return;

      const body = (await response.json()) as
        | { ok: true; cells: MapCell[]; totalPcns: number }
        | { ok: false; error: { what: string; whatYouCanDo: string; correlationId: string } };

      if (!response.ok || !body.ok) {
        setState({
          kind: 'ERROR',
          message: body.ok
            ? 'Data temporarily unavailable.'
            : `${body.error.what} ${body.error.whatYouCanDo}`,
          correlationId: body.ok ? null : body.error.correlationId,
        });
        return;
      }

      setState({ kind: 'READY', cells: body.cells, totalPcns: body.totalPcns });
    } catch {
      if (seq !== requestSeq.current) return;
      setState({
        kind: 'ERROR',
        message:
          'We could not load enforcement data just now. Nothing is wrong with your connection to the map itself — try again in a moment.',
        correlationId: null,
      });
    }
  }, [authoritySlug, canShowActivity, contravention, period]);

  /* -- Initialise the map -------------------------------------------------- */

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: publicEnv.NEXT_PUBLIC_MAP_STYLE_URL,
      center: CAMDEN_CENTRE,
      zoom: 12.6,
      attributionControl: false,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: publicEnv.NEXT_PUBLIC_MAP_ATTRIBUTION,
      }),
      'bottom-right',
    );
    map.addControl(
      new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }),
      'top-right',
    );

    // A basemap that fails to load leaves the enforcement data floating on a
    // blank colour, which looks exactly like a broken page. MapLibre reports
    // these and we were discarding them.
    map.on('error', (event) => {
      const message = event.error?.message ?? 'unknown error';
      // Tile 404s at the edge of a source's coverage are normal and noisy.
      if (/404|Not Found/i.test(message)) return;
      setBasemapError(message);
    });

    map.on('load', () => {
      map.addSource('activity', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Heatmap for the wider view.
      map.addLayer({
        id: 'activity-heat',
        type: 'heatmap',
        source: 'activity',
        maxzoom: 15,
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'pcnCount'], 0, 0, 200, 1],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 15, 2],
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0, 'rgba(0,0,0,0)',
            0.2, 'rgba(76,159,138,0.45)',
            0.4, 'rgba(168,191,106,0.55)',
            0.6, 'rgba(224,180,82,0.65)',
            0.8, 'rgba(217,128,63,0.75)',
            1, 'rgba(184,68,60,0.85)',
          ],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 14, 15, 34],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.85, 15, 0],
        },
      });

      // Points take over as you zoom in.
      map.addLayer({
        id: 'activity-points',
        type: 'circle',
        source: 'activity',
        minzoom: 12,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'pcnCount'], 1, 6, 50, 12, 500, 22],
          'circle-color': ['get', 'colour'],
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13.5, 0.82],
          'circle-stroke-width': 1.2,
          'circle-stroke-color': 'rgba(255,255,255,0.85)',
        },
      });

      map.addLayer({
        id: 'activity-labels',
        type: 'symbol',
        source: 'activity',
        minzoom: 14.5,
        layout: {
          'text-field': ['to-string', ['get', 'pcnCount']],
          'text-size': 11,
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(0,0,0,0.35)',
          'text-halo-width': 1,
        },
      });

      map.on('click', 'activity-points', (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        setSelected(JSON.parse(String(feature.properties?.cell)) as MapCell);
      });
      map.on('mouseenter', 'activity-points', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'activity-points', () => {
        map.getCanvas().style.cursor = '';
      });

      void loadCells();
    });

    let debounce: ReturnType<typeof setTimeout>;
    const onMoveEnd = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void loadCells(), 250);
    };
    map.on('moveend', onMoveEnd);

    return () => {
      clearTimeout(debounce);
      map.remove();
      mapRef.current = null;
    };
    // loadCells is intentionally excluded: re-creating the map on every filter
    // change would reset the user's viewport. Filter changes trigger a reload below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when a filter changes, without touching the viewport.
  useEffect(() => {
    if (mapRef.current?.isStyleLoaded()) void loadCells();
  }, [loadCells]);

  /* -- Push cells into the map source -------------------------------------- */

  useEffect(() => {
    const map = mapRef.current;
    if (!map || state.kind !== 'READY') return;
    const source = map.getSource('activity') as GeoJSONSource | undefined;
    if (!source) return;

    source.setData({
      type: 'FeatureCollection',
      features: state.cells.map((cell) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [cell.longitude, cell.latitude] },
        properties: {
          pcnCount: cell.pcnCount,
          colour: CLASSIFICATION_COLOUR[cell.maxClassification ?? 'UNSCORED'],
          cell: JSON.stringify(cell),
        },
      })),
    });
  }, [state]);

  /* -- Search -------------------------------------------------------------- */

  const onSearch = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const query = search.trim();
      if (!query) return;
      const response = await fetch(
        `/api/map/search?authority=${authoritySlug}&q=${encodeURIComponent(query)}`,
      );
      const body = (await response.json()) as
        | { ok: true; results: { longitude: number; latitude: number; displayName: string }[] }
        | { ok: false };
      const first = body.ok ? body.results[0] : undefined;
      if (first) {
        mapRef.current?.flyTo({ center: [first.longitude, first.latitude], zoom: 16 });
      }
    },
    [authoritySlug, search],
  );

  const summary = useMemo(() => {
    if (state.kind !== 'READY') return null;
    return {
      locations: state.cells.reduce((acc, c) => acc + c.locationCount, 0),
      pcns: state.totalPcns,
    };
  }, [state]);

  /* -- Render -------------------------------------------------------------- */

  if (!canShowActivity) {
    return (
      <div className="fr-container" style={{ paddingBlock: 64 }}>
        <div
          className="fr-panel"
          style={{ padding: 32, maxWidth: 640, textAlign: 'left' }}
          role="status"
        >
          <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 10 }}>{coverageHeadline}</h2>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 15 }}>{coverageDetail}</p>
          <p style={{ marginTop: 18, fontSize: 14 }}>
            <Link href="/analyse">You can still analyse a PCN you have received →</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 480, display: 'flex' }}>
      <div
        ref={containerRef}
        role="application"
        aria-label="Map of enforcement activity"
        style={{ position: 'absolute', inset: 0 }}
      />

      {/* Filters */}
      <div
        style={{
          position: 'absolute',
          top: 14,
          left: 14,
          right: 68,
          zIndex: 2,
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          pointerEvents: 'none',
        }}
      >
        <form
          onSubmit={onSearch}
          style={{ pointerEvents: 'auto', display: 'flex', gap: 6, flex: '1 1 210px', maxWidth: 340 }}
        >
          <label htmlFor={searchId} className="fr-eyebrow" style={{ position: 'absolute', left: -9999 }}>
            Search for a street or postcode
          </label>
          <input
            id={searchId}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search a street or postcode"
            className="fr-touch"
            style={{
              flex: 1,
              padding: '0 12px',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-raised)',
              color: 'var(--text)',
              fontSize: 14,
            }}
          />
          <button
            type="submit"
            className="fr-touch"
            style={{
              padding: '0 14px',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-ink-900)',
              color: 'var(--color-ink-50)',
              fontSize: 14,
              fontWeight: 550,
              cursor: 'pointer',
            }}
          >
            Go
          </button>
        </form>

        <div
          role="group"
          aria-label="Time period"
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPeriod(p.value)}
              aria-pressed={period === p.value}
              className="fr-touch"
              style={{
                padding: '0 13px',
                border: 'none',
                background: period === p.value ? 'var(--color-ink-900)' : 'transparent',
                color: period === p.value ? 'var(--color-ink-50)' : 'var(--text-muted)',
                fontSize: 13.5,
                cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <select
          value={contravention}
          onChange={(e) => setContravention(e.target.value)}
          aria-label="Filter by contravention code"
          className="fr-touch"
          style={{
            pointerEvents: 'auto',
            padding: '0 10px',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-raised)',
            color: 'var(--text)',
            fontSize: 13.5,
          }}
        >
          <option value="">All contraventions</option>
          {['01', '02', '12', '21', '23', '24', '30', '40', '45', '46', '47', '99'].map((code) => (
            <option key={code} value={code}>
              Code {code}
            </option>
          ))}
        </select>
      </div>

      {/* Status strip */}
      <div
        style={{
          position: 'absolute',
          left: 14,
          bottom: selected ? 'auto' : 14,
          top: selected ? 66 : 'auto',
          zIndex: 2,
          maxWidth: 340,
        }}
      >
        {state.kind === 'LOADING' && <StatusPill>Loading enforcement data…</StatusPill>}
        {state.kind === 'ERROR' && (
          <StatusPill tone="error">
            {state.message}
            {state.correlationId && (
              <span style={{ display: 'block', marginTop: 4, fontSize: 11, opacity: 0.75 }}>
                Reference {state.correlationId}
              </span>
            )}
          </StatusPill>
        )}
        {state.kind === 'READY' && summary && summary.pcns === 0 && !hasMappableGeography && (
          // The critical distinction. With Camden's data loaded there ARE
          // recorded PCNs — thousands of them — and none carry a coordinate.
          // Saying "no recorded PCNs" here would be a false statement about
          // enforcement, and telling the user to widen the filters would send
          // them looking for something no filter can produce.
          <StatusPill>
            This authority publishes its penalty charge notices without any location coordinates, so
            nothing can be drawn here yet. The activity is real — see{' '}
            <Link href="/hotspots" style={{ color: 'inherit', textDecoration: 'underline' }}>
              hotspots
            </Link>{' '}
            for the same data ranked by street.
          </StatusPill>
        )}
        {state.kind === 'READY' && summary && summary.pcns === 0 && hasMappableGeography && (
          <StatusPill>
            No recorded PCNs in this view for the selected filters. Try widening the time period or
            panning to another area.
          </StatusPill>
        )}
        {usingPlaceholderBasemap && (
          <StatusPill>
            <strong>No basemap configured.</strong> The enforcement data below is real, but there
            are no streets under it: PCNWatch is falling back to MapLibre&rsquo;s demo style, which
            has country outlines only and stops at about zoom 5. Set{' '}
            <code>NEXT_PUBLIC_MAP_STYLE_URL</code> to a street-level style.
          </StatusPill>
        )}
        {basemapError !== null && !usingPlaceholderBasemap && (
          <StatusPill>
            The basemap failed to load ({basemapError}). The enforcement data shown is unaffected —
            it comes from our own database, not the map tiles.
          </StatusPill>
        )}
        {state.kind === 'READY' && summary && summary.pcns > 0 && (
          <StatusPill>
            <span className="fr-numeric">{summary.pcns.toLocaleString('en-GB')}</span> PCNs across{' '}
            <span className="fr-numeric">{summary.locations}</span> locations in view
          </StatusPill>
        )}
        {/*
          Camden publishes coordinates for some of its notices and not others.
          A map of the geolocated subset is true about every point it shows and
          silent about the rest — and on a map, silence reads as an absence of
          enforcement. Say what is missing, wherever there is anything to see.
        */}
        {hasMappableGeography &&
          mappableEventShare !== null &&
          mappableEventShare < 0.99 && (
            <StatusPill>
              {/*
                Two different shares, and quoting either alone misdescribes the
                map. The first says how much of the activity is visible; the
                second how precisely it is placed.
              */}
              {mappedEventShare !== null && (
                <>
                  This map shows the{' '}
                  <span className="fr-numeric">{Math.round(mappedEventShare * 100)}%</span> of
                  recorded notices that are on a street the authority gave a position for.{' '}
                </>
              )}
              Positions are street-level: every notice on a street is drawn at one point on it, not
              where each notice was issued —{' '}
              <span className="fr-numeric">{Math.round(mappableEventShare * 100)}%</span> carry a
              position of their own.{' '}
              <Link href="/hotspots" style={{ color: 'inherit', textDecoration: 'underline' }}>
                Hotspots
              </Link>{' '}
              ranks every notice by street.
            </StatusPill>
          )}
      </div>

      {/* Legend */}
      {!selected && (
        <div
          style={{
            position: 'absolute',
            right: 14,
            bottom: 40,
            zIndex: 2,
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '10px 12px',
            maxWidth: 190,
          }}
        >
          <div className="fr-eyebrow" style={{ marginBottom: 7 }}>
            Activity
          </div>
          {(['VERY_LOW', 'LOW', 'MODERATE', 'HIGH', 'VERY_HIGH'] as const).map((key) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 2,
                  background: CLASSIFICATION_COLOUR[key],
                }}
              />
              {key.replace('_', ' ').toLowerCase()}
            </div>
          ))}
          <p style={{ margin: '9px 0 0', fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.4 }}>
            {SCORE_DISCLAIMER}
          </p>
        </div>
      )}

      {selected && (
        <LocationPanel
          cell={selected}
          authoritySlug={authoritySlug}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function StatusPill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'error';
}) {
  return (
    <div
      role="status"
      style={{
        background: 'var(--surface-raised)',
        border: `1px solid ${tone === 'error' ? 'var(--color-warn)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        padding: '9px 12px',
        fontSize: 13,
        color: 'var(--text-muted)',
        boxShadow: '0 1px 3px rgb(0 0 0 / 0.08)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Location detail. A bottom sheet on mobile, a sidebar on desktop — the same
 * component, positioned by a media query, so there is one source of truth for
 * what a selected location says.
 */
function LocationPanel({
  cell,
  authoritySlug,
  onClose,
}: {
  cell: MapCell;
  authoritySlug: string;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Selected location"
      className="fr-map-panel"
      style={{
        position: 'absolute',
        zIndex: 3,
        background: 'var(--surface-raised)',
        borderTop: '1px solid var(--border)',
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: '62dvh',
        overflowY: 'auto',
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        boxShadow: '0 -6px 24px rgb(0 0 0 / 0.14)',
      }}
    >
      <div style={{ padding: '14px 18px 22px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <div>
            <div className="fr-eyebrow" style={{ marginBottom: 4 }}>
              {cell.isSingleLocation ? 'Location' : `${cell.locationCount} locations`}
            </div>
            <h2 style={{ fontSize: 19, fontWeight: 620 }}>
              {cell.displayName ?? `${cell.locationCount} locations in this area`}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close location details"
            className="fr-touch"
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              background: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ display: 'flex', gap: 24, marginTop: 16, flexWrap: 'wrap' }}>
          <div>
            <div className="fr-eyebrow">Recorded PCNs</div>
            <div className="fr-numeric" style={{ fontSize: 24, fontWeight: 620 }}>
              {cell.pcnCount.toLocaleString('en-GB')}
            </div>
          </div>
          <div>
            <div className="fr-eyebrow">Ticket Activity Score</div>
            <div className="fr-numeric" style={{ fontSize: 24, fontWeight: 620 }}>
              {cell.maxScore ?? '—'}
              {cell.maxScore === null && (
                <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-faint)' }}>
                  {' '}
                  not scored
                </span>
              )}
            </div>
          </div>
        </div>

        {cell.isSingleLocation && cell.locationSlug ? (
          <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
            <Link
              href={`/hotspots/${authoritySlug}/${cell.locationSlug}`}
              className="fr-touch"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 16px',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-md)',
                fontSize: 14,
                fontWeight: 550,
                textDecoration: 'none',
                color: 'var(--text)',
              }}
            >
              Full location detail
            </Link>
            <Link
              href="/analyse"
              className="fr-touch"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 16px',
                background: 'var(--color-ink-900)',
                color: 'var(--color-ink-50)',
                borderRadius: 'var(--radius-md)',
                fontSize: 14,
                fontWeight: 550,
                textDecoration: 'none',
              }}
            >
              Got a PCN here? Analyse it.
            </Link>
          </div>
        ) : (
          <p style={{ marginTop: 14, fontSize: 13.5, color: 'var(--text-muted)' }}>
            Zoom in to see individual streets in this area.
          </p>
        )}

        <p style={{ marginTop: 16, fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.45 }}>
          {SCORE_DISCLAIMER}
        </p>
      </div>
    </aside>
  );
}
