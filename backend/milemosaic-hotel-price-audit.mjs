/**
 * MileMosaic: Xotelo hotel rate coverage audit.
 * Place this file in UKTravelMapsPOC/backend/ and run from backend/.
 * Reads hotel_entity_links; never writes to PostgreSQL.
 * Calls your existing GET /api/hotels/xotelo/rates endpoint, not Xotelo directly.
 */
import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const pool = new pg.Pool();
const startDate = process.env.TEST_CHECKIN || '2026-12-01';
const endDate = process.env.TEST_CHECKOUT || '2026-12-02';
const limit = Math.max(1, Number(process.env.TEST_LIMIT || 20));
const delayMs = Math.max(2000, Number(process.env.TEST_DELAY_MS || 2500));
const baseUrl = process.env.TEST_API_BASE || 'http://localhost:3001';
const resultsPath = path.resolve(process.cwd(), `hotel-price-audit-${startDate}-to-${endDate}.jsonl`);
const csvPath = resultsPath.replace(/\.jsonl$/, '.csv');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const csv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;

if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
    Date.parse(`${startDate}T00:00:00Z`) >= Date.parse(`${endDate}T00:00:00Z`)) {
  throw new Error('Choose valid future TEST_CHECKIN / TEST_CHECKOUT dates (checkout after checkin)');
}

async function priceCheck(hotel) {
  const url = new URL('/api/hotels/xotelo/rates', baseUrl);
  for (const [k, v] of Object.entries({
    hotel_key: hotel.hotel_key, chk_in: startDate, chk_out: endDate,
    currency: 'GBP', rooms: '1', adults: '2'
  })) url.searchParams.set(k, v);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(35000) });
    let payload;
    try { payload = await response.json(); }
    catch { return { outcome: 'error', statusCode: response.status, reason: 'Non-JSON response' }; }
    if (!response.ok || payload?.success !== true) {
      return {
        outcome: 'error', statusCode: response.status,
        reason: String(payload?.error ?? payload?.details ?? 'API returned failure').slice(0, 300)
      };
    }
    const result = payload?.data?.result;
    if (!result || typeof result !== 'object') {
      return { outcome: 'error', statusCode: response.status, reason: 'Unexpected response shape' };
    }
    const offers = Array.isArray(result.rates) ? result.rates : [];
    const prices = offers.map(o => Number(o?.rate)).filter(v => Number.isFinite(v) && v > 0);
    return {
      outcome: prices.length ? 'price_found' : 'no_price',
      statusCode: response.status,
      offers: prices.length,
      minRateGbpPerRoomPerNight: prices.length ? Math.min(...prices) : null
    };
  } catch (error) {
    return { outcome: 'error', statusCode: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

function loadResults() {
  const map = new Map();
  if (!fs.existsSync(resultsPath)) return map;
  for (const line of fs.readFileSync(resultsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.hotel_key) map.set(obj.hotel_key, obj);
    } catch { /* tolerate truncated last line */ }
  }
  return map;
}

function report(rows, results) {
  const counters = { price_found: 0, no_price: 0, error: 0, unchecked: 0 };
  const confirmed = { total: 0, price_found: 0 };
  const output = [];
  for (const hotel of rows) {
    const previous = results.get(hotel.hotel_key);
    const outcome = previous?.outcome ?? 'unchecked';
    counters[outcome] = (counters[outcome] || 0) + 1;
    if (hotel.status === 'confirmed') {
      confirmed.total++;
      if (outcome === 'price_found') confirmed.price_found++;
    }
    output.push({ ...hotel, ...previous, outcome });
  }
  const columns = ['hotel_key','city','xotelo_name','status','outcome','minRateGbpPerRoomPerNight','offers','statusCode','reason'];
  fs.writeFileSync(csvPath, [columns.join(','), ...output.map(r => columns.map(c => csv(r[c])).join(','))].join('\n') + '\n');
  console.log('\n== Price coverage audit ==');
  console.log({ totalStoredHotels: rows.length, ...counters,
    confirmedHotels: confirmed.total, confirmedWithPrice: confirmed.price_found });
  console.log(`CSV report: ${csvPath}`);
}

try {
  const db = await pool.query(`
    SELECT DISTINCT ON (hotel_key)
      hotel_key, city, xotelo_name, status
    FROM hotel_entity_links
    WHERE hotel_key ~ '^g[0-9]+-d[0-9]+$'
    ORDER BY hotel_key,
      CASE status WHEN 'confirmed' THEN 1 WHEN 'possible' THEN 2 ELSE 3 END
  `);
  const hotels = db.rows;
  console.log(`Stored unique Xotelo hotel keys: ${hotels.length}`);
  if (!hotels.length) throw new Error('No hotel keys found in hotel_entity_links');
  if (hotels.length !== 527) console.warn('NOTE: Stored key count differs from V3 sample of 527. Confirm dataset before interpreting results.');
  console.log(`Check-in: ${startDate}; Check-out: ${endDate}; 1 room, 2 adults, GBP`);
  const results = loadResults();
  const pending = hotels.filter(h => !['price_found', 'no_price'].includes(results.get(h.hotel_key)?.outcome));
  console.log(`Already completed (price/no-price): ${hotels.length - pending.length}; will attempt up to ${limit} keys.`);
  let tried = 0, consecutiveErrors = 0;
  for (const hotel of pending.slice(0, limit)) {
    const result = await priceCheck(hotel);
    tried++;
    const entry = { ...hotel, ...result, checkedAt: new Date().toISOString(), checkin: startDate, checkout: endDate };
    fs.appendFileSync(resultsPath, JSON.stringify(entry) + '\n');
    results.set(hotel.hotel_key, entry);
    console.log(`${tried}. ${hotel.hotel_key} | ${hotel.status} | ${result.outcome}${result.minRateGbpPerRoomPerNight != null ? ` | £${result.minRateGbpPerRoomPerNight}` : ''}${result.reason ? ` | ${result.reason}` : ''}`);
    if (result.outcome === 'error') consecutiveErrors++;
    else consecutiveErrors = 0;
    if (result.statusCode === 429 || consecutiveErrors >= 3) {
      console.warn('STOP: rate limit or consecutive errors; do not keep hammering the provider.');
      break;
    }
    if (tried < pending.length && tried < limit) await sleep(delayMs);
  }
  report(hotels, results);
} catch (e) {
  console.error('Audit failed:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await pool.end();
}
