/**
 * Unit tests for the Google Solar API building insights helper.
 *
 * Mocks fetch to test response parsing, sqft calculation, and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBuildingInsights } from '@/lib/solar/building-insights';

const MOCK_API_KEY = 'test-api-key';
const MOCK_LAT = 49.0504;
const MOCK_LNG = -122.3045;

/** A realistic Solar API response shape with multiple roof segments. */
const MOCK_SOLAR_RESPONSE = {
  solarPotential: {
    roofSegmentStats: [
      { pitchDegrees: 22.5, stats: { areaMeters2: 50 } },
      { pitchDegrees: 22.5, stats: { areaMeters2: 50 } },
      { pitchDegrees: 10, stats: { areaMeters2: 30 } },
      { pitchDegrees: 15, stats: { areaMeters2: 20 } },
    ],
  },
};

describe('fetchBuildingInsights', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sums all roof segments and converts m2 to sqft', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_SOLAR_RESPONSE), { status: 200 }),
    );

    const result = await fetchBuildingInsights(MOCK_LAT, MOCK_LNG, MOCK_API_KEY);

    expect(result.found).toBe(true);
    if (result.found) {
      // Total m2: 50 + 50 + 30 + 20 = 150
      // 150 * 10.764 = 1614.6 → rounded to 1 decimal = 1614.6
      expect(result.totalRoofSqft).toBe(1614.6);
      expect(result.segmentCount).toBe(4);
    }
  });

  it('calls the correct Solar API URL', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_SOLAR_RESPONSE), { status: 200 }),
    );

    await fetchBuildingInsights(MOCK_LAT, MOCK_LNG, MOCK_API_KEY);

    expect(fetch).toHaveBeenCalledWith(
      `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${MOCK_LAT}&location.longitude=${MOCK_LNG}&key=${MOCK_API_KEY}`,
    );
  });

  it('returns found: false on 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const result = await fetchBuildingInsights(MOCK_LAT, MOCK_LNG, MOCK_API_KEY);
    expect(result).toEqual({ found: false });
  });

  it('returns found: false on 500', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const result = await fetchBuildingInsights(MOCK_LAT, MOCK_LNG, MOCK_API_KEY);
    expect(result).toEqual({ found: false });
  });

  it('returns found: false on network error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network request failed'));

    const result = await fetchBuildingInsights(MOCK_LAT, MOCK_LNG, MOCK_API_KEY);
    expect(result).toEqual({ found: false });
  });

  it('returns found: false when solarPotential is missing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const result = await fetchBuildingInsights(MOCK_LAT, MOCK_LNG, MOCK_API_KEY);
    expect(result).toEqual({ found: false });
  });

  it('returns found: false when roofSegmentStats is empty', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ solarPotential: { roofSegmentStats: [] } }), { status: 200 }),
    );

    const result = await fetchBuildingInsights(MOCK_LAT, MOCK_LNG, MOCK_API_KEY);
    expect(result).toEqual({ found: false });
  });

  it('returns found: false when all segments have zero area', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          solarPotential: {
            roofSegmentStats: [
              { pitchDegrees: 10, stats: { areaMeters2: 0 } },
              { pitchDegrees: 15, stats: { areaMeters2: 0 } },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await fetchBuildingInsights(MOCK_LAT, MOCK_LNG, MOCK_API_KEY);
    expect(result).toEqual({ found: false });
  });

  it('handles a single roof segment', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          solarPotential: {
            roofSegmentStats: [{ pitchDegrees: 30, stats: { areaMeters2: 100 } }],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await fetchBuildingInsights(MOCK_LAT, MOCK_LNG, MOCK_API_KEY);

    expect(result.found).toBe(true);
    if (result.found) {
      // 100 * 10.764 = 1076.4
      expect(result.totalRoofSqft).toBe(1076.4);
      expect(result.segmentCount).toBe(1);
    }
  });

  it('handles segments with missing stats gracefully', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          solarPotential: {
            roofSegmentStats: [
              { pitchDegrees: 10, stats: { areaMeters2: 100 } },
              { pitchDegrees: 15 }, // missing stats
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const result = await fetchBuildingInsights(MOCK_LAT, MOCK_LNG, MOCK_API_KEY);

    expect(result.found).toBe(true);
    if (result.found) {
      // Only the first segment counts: 100 * 10.764 = 1076.4
      expect(result.totalRoofSqft).toBe(1076.4);
      expect(result.segmentCount).toBe(2);
    }
  });
});
