const BASE = 'http://localhost:3001';

async function request(label, path) {
  console.log(`\n=== ${label} ===`);
  try {
    const response = await fetch(BASE + path, {
      signal: AbortSignal.timeout(60000),
    });
    const json = await response.json();
    console.log('HTTP:', response.status);
    if (!response.ok || json.success === false) {
      console.log('Error:', JSON.stringify(json).slice(0, 750));
      return null;
    }
    return json;
  } catch (error) {
    console.log('Request error:', error.message);
    return null;
  }
}

const iso = (date) => date.toISOString().slice(0, 10);
const now = new Date();
const chkIn = iso(new Date(now.getTime() + 14 * 86400000));
const chkOut = iso(new Date(now.getTime() + 16 * 86400000));
console.log('TEST STAY:', chkIn, 'to', chkOut);

const cities = ['London', 'Manchester', 'Edinburgh'];
for (const cityName of cities) {
  const cityResponse = await request(`Find ${cityName} in local cities`,
    '/api/cities?search=' + encodeURIComponent(cityName));
  const location = cityResponse?.cities?.find(
    (c) => c.name.toLowerCase() === cityName.toLowerCase()
  );
  if (!location) {
    console.log('SKIPPED: City not found in local database');
    continue;
  }
  const qs = new URLSearchParams({
    city: cityName,
    lat: String(location.latitude),
    lon: String(location.longitude),
    radius: '6000',
    limit: '12',
    pages: '2',
    priced_limit: cityName === 'London' ? '1' : '0',
  });
  if (cityName === 'London') {
    qs.set('chk_in', chkIn);
    qs.set('chk_out', chkOut);
  }
  const result = await request(`MATCHED HOTELS: ${cityName}`, `/api/hotels/matched?${qs}`);
  if (!result) continue;
  console.log('Coverage:', result.coverage);
  console.log('OSM-only fallback (no Xotelo price):', (result.osm_only ?? []).slice(0, 5).map((h) => ({ name: h.name, distance_m: h.distance_m })));
  console.log('Only confirmed matches are safe to join automatically. Possible matches need review.');
  console.log('Hotels:', (result.hotels ?? []).map((h) => ({
    xotelo_name: h.name,
    distance_m: h.distance_m,
    rating: h.rating,
    image: Boolean(h.image),
    match_status: h.match?.status,
    confidence: h.match?.confidence,
    osm_name: h.match?.osm?.name ?? null,
    separation_m: h.match?.separation_m,
    score: h.match?.name_score,
    lowest_rate_gbp_per_night: h.rates?.lowest_price_per_room_per_night_gbp ?? null,
    rate_error: h.rates_error ?? null,
  })));
  if (result.coverage?.scan_limited) {
    console.log('Note: Only a portion of this city\'s Xotelo hotels was scanned.');
  }
}

const invalid = await request('Validation: missing location key',
  '/api/hotels/matched?city=UnknownCity&lat=51.5074&lon=-0.1278');
console.log('Expected HTTP 400:', invalid === null ? 'PASS' : 'FAIL');

const osm = await request('Existing OSM hotels still work',
  '/api/nearby?lat=51.5074&lon=-0.1278&type=hotel&radius=3000&limit=3');
console.log('OSM hotels found:', osm?.places?.length ?? 'unknown');

const transport = await request('Existing TransCAPI stops still work',
  '/api/transport/stops?lat=51.5007&lon=-0.1246&limit=2');
console.log('Transport stops found:', transport?.data?.member?.length ?? 'unknown');

console.log('\nMATCHING TESTS COMPLETE. Share terminal output for review.');
