const BASE = 'http://localhost:3001';

async function call(label, path) {
  console.log(`\n=== ${label} ===`);
  try {
    const response = await fetch(BASE + path, { signal: AbortSignal.timeout(35000) });
    const body = await response.json();
    console.log('HTTP:', response.status, '| X-Cache:', response.headers.get('x-cache') ?? 'none');
    if (!response.ok || body.success === false) {
      console.log('ERROR:', JSON.stringify(body).slice(0, 1000));
      return null;
    }
    return body;
  } catch (error) {
    console.log('ERROR:', error.message);
    return null;
  }
}

const health = await call('1. Backend health', '/health');
console.log(health ? health : 'FAIL');

const city = await call('2. London city search', '/api/cities?search=London');
console.log('Exact match:', city?.cities?.find(c => c.name === 'London') ?? 'not found');

const osm = await call('3. Existing OSM London hotels', '/api/nearby?lat=51.5074&lon=-0.1278&type=hotel&radius=3000&limit=3');
console.log('OSM hotels:', osm?.places?.map(x => ({name:x.name,distance_m:x.distance_m})) ?? []);

const listPath = '/api/hotels/xotelo/list?location_key=g186338&limit=8&sort=popularity';
const hotels = await call('4. Xotelo London hotel list', listPath);
const list = hotels?.data?.result?.list ?? [];
console.log('Total available in provider:', hotels?.data?.result?.total_count ?? 'unknown');
console.log('Returned hotels:', list.map(x => ({
  name:x.name, hotel_key:x.key, rating:x.review_summary?.rating,
  coords:x.geo, has_image:Boolean(x.image),
  has_price_range:Boolean(x.price_ranges)
})));

const cached = await call('5. Repeat list: cache check', listPath);
console.log('Cache call returned hotels:', cached?.data?.result?.list?.length ?? 0);

const iso = d => d.toISOString().slice(0,10);
const today = new Date();
const checkIn = iso(new Date(today.getTime() + 14*86400000));
const checkOut = iso(new Date(today.getTime() + 16*86400000));
console.log('\nStay:', checkIn, 'to', checkOut, 'GBP, 1 room, 2 adults');

const hotelCandidates = list.filter(h => /^g\d+-d\d+$/.test(h.key ?? '')).slice(0, 2);
for (const [i, hotel] of hotelCandidates.entries()) {
  const params = new URLSearchParams({ hotel_key:hotel.key, chk_in:checkIn,
    chk_out:checkOut, currency:'GBP', rooms:'1', adults:'2' });
  const rates = await call(`6.${i+1}. Xotelo rates: ${hotel.name}`, `/api/hotels/xotelo/rates?${params}`);
  const offers = rates?.data?.result?.rates ?? [];
  console.log('OTA quotes:', offers.length);
  console.log('Quote details:', offers.slice(0,8).map(r => ({provider:r.name,GBP_per_room_per_night:r.rate,tax:r.tax??null})));
  console.log('Provider timestamp:', rates?.data?.timestamp ?? null);
  console.log('Note: quoted rates are not booking confirmation or necessarily tax-inclusive');
}

const bad = await call('7. Validation: invalid hotel key (should be HTTP 400)', '/api/hotels/xotelo/rates?hotel_key=BAD&chk_in=2026-12-01&chk_out=2026-12-03');
console.log('Expected rejection:', bad === null ? 'yes' : 'no');

const transport = await call('8. Existing transport smoke test', '/api/transport/stops?lat=51.5007&lon=-0.1246&radius=500&limit=2');
console.log('Transport stops:', transport?.data?.member?.map(s => s.name) ?? []);

console.log('\nTESTS COMPLETE — send the console output to review any unavailable prices/errors.');
