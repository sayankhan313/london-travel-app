// Run with Node.js 22; backend running on port 3001.
// Uses actual Xotelo keys returned by API; no hotel keys are hard-coded.
const API = 'http://localhost:3001';

async function get(path) {
  const resp = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(40000) });
  const body = await resp.json();
  console.log(`HTTP ${resp.status}: ${path.split('?')[0]}`);
  if (!resp.ok || body.success === false) {
    console.log('ERROR:', JSON.stringify(body).slice(0, 700));
    return null;
  }
  return body;
}

const today = new Date();
const ymd = days => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days)).toISOString().slice(0, 10);

console.log('=== HOTEL ENTITY RESOLUTION V3 REGRESSION ===');
const health = await get('/health');
console.log('DB:', health?.database ?? 'not connected');

const stats = await get('/api/hotels/matching/stats');
console.log('V3 persisted stats:', stats?.counts ?? 'No statistics');

const coords = {
  London: [51.5074456, -0.1277653],
  Manchester: [53.4794892, -2.2451148],
  Edinburgh: [55.9533, -3.1883],
  Leicester: [52.6362, -1.1331969],
};

let selectedHotel = null;
for (const [city, [lat, lon]] of Object.entries(coords)) {
  console.log(`\n===== ${city.toUpperCase()} =====`);
  const q = new URLSearchParams({ city, lat: String(lat), lon: String(lon), radius: '6000', pages: '2', limit: '12' });
  const result = await get(`/api/hotels/matched?${q}`);
  if (!result) continue;
  console.log('Coverage:', result.coverage);
  const hotelRows = (result.hotels ?? []).map(h => ({
    xotelo: h.name,
    osm: h.match?.osm?.name ?? null,
    status: h.match?.status ?? 'unknown',
    engine: h.match?.engine ?? 'v2',
    name_score: h.match?.name_score ?? null,
    distance_m: h.match?.separation_m ?? null,
  }));
  console.table(hotelRows);

  const confirmed = (result.hotels ?? []).filter(h => h.match?.status === 'confirmed' && h.match?.osm);
  const ids = confirmed.map(h => `${h.match.osm.osm_type}:${h.match.osm.osm_id}`);
  console.log('Duplicate confirmed OSM associations:', ids.length - new Set(ids).size);
  console.log('OSM-only fallback:', result.osm_only?.slice(0, 4).map(h => h.name));
  if (city === 'London') {
    for (const part of ['Trafalgar', 'Club Quarters', 'Corinthia']) {
      const item = result.hotels?.find(h => h.name.toLowerCase().includes(part.toLowerCase()));
      console.log(`Spot-check ${part}:`, item ? { status: item.match?.status, osm: item.match?.osm?.name, engine: item.match?.engine } : 'not in first 12');
    }
    selectedHotel = result.hotels?.find(h => h.hotel_key && h.match?.status === 'confirmed') ?? null;
  }
  if (city === 'Edinburgh') {
    const balmoral = result.hotels?.find(h => h.name.toLowerCase().includes('balmoral'));
    console.log('Spot-check Balmoral:', balmoral ? { status: balmoral.match?.status, osm: balmoral.match?.osm?.name, engine: balmoral.match?.engine } : 'not in first 12');
  }
}

if (selectedHotel) {
  console.log(`\n=== PRICE CHECK — ${selectedHotel.name} ===`);
  const q = new URLSearchParams({ hotel_key: selectedHotel.hotel_key, chk_in: ymd(14), chk_out: ymd(16), currency: 'GBP', adults: '2', rooms: '1' });
  const rates = await get(`/api/hotels/xotelo/rates?${q}`);
  const raw = rates?.data?.result?.rates ?? [];
  console.log('Quotes:', raw.slice(0, 5).map(q => ({ provider: q.name, per_room_per_night_gbp: q.rate })));
  console.log('Missing quotes are not zero-price hotels.');
}

console.log('\n=== REGRESSION CHECKS ===');
const places = await get('/api/attractions?lat=51.5074&lon=-0.1278&radius=3000&limit=3');
console.log('Attractions returned:', places?.places?.length ?? 0);
const transport = await get('/api/transport/stops?lat=51.5007&lon=-0.1246&radius=500&limit=2');
console.log('Transport stops returned:', transport?.data?.member?.length ?? 0);
console.log('\nTEST COMPLETE. Please share terminal output.');
