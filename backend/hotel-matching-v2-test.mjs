const BASE = 'http://localhost:3001';
const today = new Date();
const date = (days) => new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
const chkIn = date(14);
const chkOut = date(16);

async function get(label, path) {
  try {
    const response = await fetch(`${BASE}${path}`, {
      signal: AbortSignal.timeout(60000),
    });
    const body = await response.json();
    if (!response.ok || body.success === false) {
      console.log(`❌ ${label}: HTTP ${response.status}`);
      console.log(JSON.stringify(body).slice(0, 500));
      return null;
    }
    console.log(`✅ ${label}: HTTP ${response.status}`);
    return body;
  } catch (error) {
    console.log(`❌ ${label}: ${error.message}`);
    return null;
  }
}

console.log(`Hotel Matching V2 — Test stay: ${chkIn} to ${chkOut}`);
console.log('Hotels use live Xotelo data; price quotes may be empty or change.');

const health = await get('PostgreSQL health', '/health');
console.log('Database:', health?.database ?? 'unavailable');

const testCities = ['London', 'Manchester', 'Edinburgh', 'Leicester'];
let londonHotelKey = null;
let previousConfirmed = { London: 4, Manchester: 4, Edinburgh: 8 };
for (const city of testCities) {
  console.log(`\n=== ${city.toUpperCase()} ===`);
  const places = await get(`Find ${city}`, `/api/cities?search=${encodeURIComponent(city)}`);
  const found = places?.cities?.find((item) => item.name?.toLowerCase() === city.toLowerCase());
  if (!found) {
    console.log('Missing in local cities table; skipping city');
    continue;
  }
  const params = new URLSearchParams({
    city,
    lat: String(found.latitude),
    lon: String(found.longitude),
    radius: '6000',
    limit: '12',
    pages: '2',
  });
  const result = await get('Matched hotels', `/api/hotels/matched?${params}`);
  if (!result) continue;
  console.log('Coverage:', result.coverage);
  console.log('Xotelo hotels:', (result.hotels ?? []).map((h) => ({
    name: h.name,
    match: h.match?.status,
    osm: h.match?.osm?.name ?? null,
    separation_m: h.match?.separation_m,
  })));
  console.log('OSM-only sample:', (result.osm_only ?? []).slice(0, 5).map((h) => h.name));
  if (city === 'London') {
    londonHotelKey = result.hotels?.[0]?.hotel_key ?? null;
    const trafalgar = result.hotels?.find((h) => h.name.toLowerCase().includes('trafalgar st. james'));
    if (trafalgar) console.log('Trafalgar match:', trafalgar.match);
  }
  if (Object.prototype.hasOwnProperty.call(previousConfirmed, city)) {
    console.log('PREVIOUS confirmed (12 hotels):', previousConfirmed[city]);
    console.log('CURRENT confirmed (12 hotels):', result.coverage?.osm_matched);
    console.log('Note: A lower/higher count alone does not establish match accuracy.');
  } else {
    console.log('Expected: OSM-only fallback without Xotelo city key.');
    console.log('Xotelo key available:', result.coverage?.xotelo_key_available);
  }
}

if (londonHotelKey) {
  const params = new URLSearchParams({
    hotel_key: londonHotelKey,
    chk_in: chkIn,
    chk_out: chkOut,
    currency: 'GBP',
    rooms: '1',
    adults: '2',
  });
  const rates = await get('Selected London hotel pricing', `/api/hotels/xotelo/rates?${params}`);
  const quotes = rates?.data?.result?.rates ?? [];
  console.log('Selected hotel key:', londonHotelKey);
  console.log('Price quotes:', quotes.slice(0, 5).map((r) => ({ provider: r.name, GBP_per_room_per_night: r.rate })));
}

await get('OSM nearby restaurants unchanged',
  '/api/nearby?lat=51.5074456&lon=-0.1277653&type=restaurant&limit=3');
await get('TransCAPI stop search unchanged',
  '/api/transport/stops?lat=51.5007&lon=-0.1246&limit=2');
const invalidResponse = await fetch(
  `${BASE}/api/hotels/xotelo/rates?hotel_key=bad&chk_in=${chkIn}&chk_out=${chkOut}`,
  { signal: AbortSignal.timeout(10000) }
);
console.log(invalidResponse.status === 400
  ? '✅ Invalid hotel key correctly rejected: HTTP 400'
  : `❌ Invalid hotel key check returned unexpected HTTP ${invalidResponse.status}`);

console.log('\nTEST COMPLETE — share the output for a review of coverage and possible duplicates.');
