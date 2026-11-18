// Run with Node.js 18+ after the backend restarts. No static hotel IDs.
const API = 'http://localhost:3001';
let failures = 0;
async function get(label, path, expect = 200) {
  try {
    const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(45000) });
    const body = await res.json();
    const ok = res.status === expect;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: HTTP ${res.status}`);
    if (!ok) { console.log(JSON.stringify(body).slice(0, 600)); failures++; }
    return ok ? body : null;
  } catch (error) {
    console.log(`FAIL ${label}: ${error.message}`);
    failures++;
    return null;
  }
}
console.log('=== HOTEL MATCHING V3.1 — REGRESSION ===');
const health = await get('Database health','/health');
console.log('DB:',health?.database ?? 'unknown');
const stats = await get('Persisted stats','/api/hotels/matching/stats');
console.log('Engine:',stats?.engine,'Results:',stats?.counts);
const cities = {
  London: [51.5074456,-0.1277653],
  Manchester: [53.4794892,-2.2451148],
  Edinburgh: [55.9533,-3.1883],
  Leicester: [52.6362,-1.1331969],
};
let selected = null;
for (const [city, [lat,lon]] of Object.entries(cities)) {
  console.log(`\n--- ${city} ---`);
  const qs = new URLSearchParams({city,lat:String(lat),lon:String(lon),radius:'6000',limit:'12',pages:'2'});
  const r = await get(`${city} hotels`,`/api/hotels/matched?${qs}`);
  if (!r) continue;
  console.log('Coverage:',r.coverage);
  const confirmed = r.hotels.filter(h=>h.match?.status==='confirmed' && h.match.osm);
  const ids=confirmed.map(h=>`${h.match.osm.osm_type}:${h.match.osm.osm_id}`);
  const duplicates=ids.length-new Set(ids).size;
  console.log('Duplicate CONFIRMED OSM IDs:',duplicates);
  if (duplicates) failures++;
  console.table(r.hotels.map(h=>({name:h.name, status:h.match.status,
      reason:h.match.decision_reason??null,osm:h.match.osm?.name??null,
      source:h.match.engine??null})));
  if (city==='London') {
    selected=r.hotels.find(h=>h.hotel_key && h.match.status==='confirmed') ?? r.hotels[0] ?? null;
    const x=r.hotels.find(h=>h.name.includes('Corinthia'));
    if(x) console.log('Corinthia (should not be wrongly confirmed to residences):',x.match);
  }
  if (city==='Edinburgh') {
    const b=r.hotels.find(h=>h.name.includes('Balmoral'));
    console.log('Balmoral regression:',b?.match??'not in scanned page');
  }
  if(city==='Leicester' && r.hotels.length===0 && r.osm_only.length>0) console.log('PASS Leicester OSM-only fallback');
}
if (selected) {
  const today = new Date();
  const date = n => new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()+n)).toISOString().slice(0,10);
  const qs = new URLSearchParams({hotel_key:selected.hotel_key,chk_in:date(14),chk_out:date(16),currency:'GBP',rooms:'1',adults:'2'});
  const r=await get('Direct native Xotelo hotel_key prices',`/api/hotels/xotelo/rates?${qs}`);
  console.log('Provider quotes:',(r?.data?.result?.rates??[]).slice(0,5).map(x=>({provider:x.name,GBP:x.rate})));
}
await get('OSM attractions','/api/attractions?lat=51.5074&lon=-0.1278&radius=3000&limit=3');
await get('OSM restaurants','/api/nearby?lat=51.5074&lon=-0.1278&type=restaurant&radius=3000&limit=3');
await get('TransCAPI stops','/api/transport/stops?lat=51.5007&lon=-0.1246&radius=500&limit=2');
await get('Reject invalid Xotelo hotel_key',`/api/hotels/xotelo/rates?hotel_key=INVALID&chk_in=${new Date(Date.now()+14*86400000).toISOString().slice(0,10)}&chk_out=${new Date(Date.now()+16*86400000).toISOString().slice(0,10)}`,400);
console.log(`\nDONE — ${failures} API test failures`);
if(failures) process.exitCode=1;
