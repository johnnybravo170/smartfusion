/**
 * Google Solar API client for fetching building roof data.
 *
 * Uses the Building Insights endpoint to get roof segment areas for a given
 * lat/lng. This is called client-side using the same API key as Google Maps.
 *
 * @see https://developers.google.com/maps/documentation/solar/building-insights
 */

const SOLAR_API_BASE = 'https://solar.googleapis.com/v1/buildingInsights:findClosest';
const SQ_METERS_TO_SQ_FEET = 10.764;

type RoofSegmentStats = {
  pitchDegrees: number;
  stats: {
    areaMeters2: number;
  };
};

type BuildingInsightsResponse = {
  solarPotential?: {
    roofSegmentStats?: RoofSegmentStats[];
  };
};

export type BuildingInsightsResult =
  | { found: true; totalRoofSqft: number; segmentCount: number }
  | { found: false };

/**
 * Fetch building insights from the Google Solar API.
 *
 * Returns total roof area (sqft) summed across all roof segments. If the API
 * returns no data, errors, or the building has no segments, returns { found: false }.
 * Never throws; errors are logged and swallowed so the quoting flow is not blocked.
 */
export async function fetchBuildingInsights(
  lat: number,
  lng: number,
  apiKey: string,
): Promise<BuildingInsightsResult> {
  try {
    const url = `${SOLAR_API_BASE}?location.latitude=${lat}&location.longitude=${lng}&key=${apiKey}`;
    const res = await fetch(url);

    if (!res.ok) {
      console.warn(`[Solar API] ${res.status} for (${lat}, ${lng})`);
      return { found: false };
    }

    const data: BuildingInsightsResponse = await res.json();
    const segments = data.solarPotential?.roofSegmentStats;

    if (!segments || segments.length === 0) {
      return { found: false };
    }

    const totalM2 = segments.reduce((sum, seg) => sum + (seg.stats?.areaMeters2 ?? 0), 0);

    if (totalM2 <= 0) {
      return { found: false };
    }

    const totalRoofSqft = Math.round(totalM2 * SQ_METERS_TO_SQ_FEET * 10) / 10;

    return { found: true, totalRoofSqft, segmentCount: segments.length };
  } catch (err) {
    console.warn('[Solar API] Network error:', err);
    return { found: false };
  }
}
