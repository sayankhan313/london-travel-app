
import { Router, type Response } from 'express';

const router = Router();

const BASE_URL = 'https://api.transcapi.com';

type CacheEntry = {
  expiresAt: number;
  data: unknown;
};

const cache = new Map<string, CacheEntry>();

function readNumber(value: unknown, fallback?: number): number {
  if (value === undefined) return fallback ?? NaN;

  if (typeof value !== 'string' || !value.trim()) {
    return NaN;
  }

  return Number(value);
}

function validCoordinates(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function invalid(res: Response, message: string): void {
  res.status(400).json({
    success: false,
    error: message,
  });
}

async function requestTransCAPI(
  res: Response,
  path: string,
  params: URLSearchParams,
  cacheMs: number
): Promise<void> {
  const apiKey = process.env.TRANSCAPI_API_KEY?.trim();

  if (!apiKey) {
    res.status(503).json({
      success: false,
      error: 'TransCAPI API key is not configured',
    });
    return;
  }

  const url = `${BASE_URL}${path}?${params.toString()}`;
  const cached = cache.get(url);

  if (cached && cached.expiresAt > Date.now()) {
    res.set('X-Cache', 'HIT');

    res.json({
      success: true,
      source: 'TransCAPI',
      data: cached.data,
    });
    return;
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        'X-Api-Key': apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    const data: unknown = await upstream.json();

    if (!upstream.ok) {
      const retryAfter = upstream.headers.get('retry-after');

      if (retryAfter) {
        res.set('Retry-After', retryAfter);
      }

      res.status(
        upstream.status === 429
          ? 429
          : upstream.status >= 500 ||
              upstream.status === 401 ||
              upstream.status === 403
            ? 502
            : upstream.status
      ).json({
        success: false,
        error: 'TransCAPI request failed',
        providerStatus: upstream.status,
        details: data,
      });
      return;
    }

    // Small in-memory cache for the free API allowance.
    if (cache.size >= 100) {
      cache.clear();
    }

    cache.set(url, {
      expiresAt: Date.now() + cacheMs,
      data,
    });

    res.set('X-Cache', 'MISS');

    res.json({
      success: true,
      source: 'TransCAPI',
      data,
    });
  } catch (error) {
    console.error('TransCAPI request error:', error);

    res.status(
      error instanceof Error && error.name === 'TimeoutError'
        ? 504
        : 502
    ).json({
      success: false,
      error: 'Unable to reach TransCAPI',
    });
  }
}

// --------------------------------------------
// GET /api/transport/stops
// Nearby bus/tram stops
// --------------------------------------------

router.get('/stops', (req, res) => {
  const lat = readNumber(req.query.lat);
  const lon = readNumber(req.query.lon);
  const radius = readNumber(req.query.radius, 500);
  const limit = readNumber(req.query.limit, 10);

  if (
    !validCoordinates(lat, lon) ||
    !Number.isFinite(radius) ||
    radius < 1 ||
    radius > 5000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  ) {
    invalid(res, 'Invalid coordinates, radius or limit');
    return;
  }

  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    radius: String(radius),
    limit: String(limit),
  });

  void requestTransCAPI(
    res,
    '/v1/bus/stops.json',
    params,
    10 * 60 * 1000
  );
});

// --------------------------------------------
// GET /api/transport/journey
// Journey between two coordinates
// --------------------------------------------

router.get('/journey', (req, res) => {
  const fromLat = readNumber(req.query.from_lat);
  const fromLon = readNumber(req.query.from_lon);
  const toLat = readNumber(req.query.to_lat);
  const toLon = readNumber(req.query.to_lon);
  const limit = readNumber(req.query.limit, 3);

  if (
    !validCoordinates(fromLat, fromLon) ||
    !validCoordinates(toLat, toLon) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10
  ) {
    invalid(res, 'Invalid journey coordinates or limit');
    return;
  }

  const params = new URLSearchParams({
    from_lat: String(fromLat),
    from_lon: String(fromLon),
    to_lat: String(toLat),
    to_lon: String(toLon),
    limit: String(limit),
    include_fares: 'true',
    include_live: 'true',
  });

  if (req.query.datetime !== undefined) {
    const datetime = req.query.datetime;

    if (
      typeof datetime !== 'string' ||
      !datetime.trim() ||
      Number.isNaN(Date.parse(datetime))
    ) {
      invalid(res, 'Invalid datetime');
      return;
    }

    params.set('datetime', datetime);
  }

  if (req.query.arrive_by !== undefined) {
    if (
      req.query.arrive_by !== 'true' &&
      req.query.arrive_by !== 'false'
    ) {
      invalid(res, 'arrive_by must be true or false');
      return;
    }

    params.set('arrive_by', req.query.arrive_by);
  }

  void requestTransCAPI(
    res,
    '/v1/journey.json',
    params,
    60 * 1000
  );
});

// --------------------------------------------
// GET /api/transport/bus/departures
// Bus departure times
// --------------------------------------------

router.get('/bus/departures', (req, res) => {
  const atcocode = req.query.atcocode;

  if (
    typeof atcocode !== 'string' ||
    !/^[a-zA-Z0-9]{5,20}$/.test(atcocode)
  ) {
    invalid(res, 'Provide a valid ATCO stop code');
    return;
  }

  const params = new URLSearchParams({
    live: 'true',
    limit: '10',
  });

  void requestTransCAPI(
    res,
    `/v1/bus/stop_timetables/${atcocode}.json`,
    params,
    30 * 1000
  );
});

// --------------------------------------------
// GET /api/transport/rail/stations
// Nearby railway stations
// --------------------------------------------

router.get('/rail/stations', (req, res) => {
  const lat = readNumber(req.query.lat);
  const lon = readNumber(req.query.lon);
  const radius = readNumber(req.query.radius, 5000);

  if (
    !validCoordinates(lat, lon) ||
    !Number.isFinite(radius) ||
    radius < 1 ||
    radius > 15000
  ) {
    invalid(res, 'Invalid station search coordinates or radius');
    return;
  }

  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    radius: String(radius),
    limit: '10',
  });

  void requestTransCAPI(
    res,
    '/v1/rail/stations.json',
    params,
    10 * 60 * 1000
  );
});

// --------------------------------------------
// GET /api/transport/rail/departures
// Train departure times
// --------------------------------------------

router.get('/rail/departures', (req, res) => {
  const crs = req.query.crs;

  if (
    typeof crs !== 'string' ||
    !/^[a-zA-Z]{3}$/.test(crs)
  ) {
    invalid(res, 'Provide a valid three-letter CRS station code');
    return;
  }

  const params = new URLSearchParams({
    limit: '10',
  });

  void requestTransCAPI(
    res,
    `/v1/rail/station_timetables/${crs.toUpperCase()}.json`,
    params,
    30 * 1000
  );
});

export default router;
