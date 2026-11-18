
require('dotenv').config();

const express = require('express');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const API_KEY = process.env.GOOGLE_ROUTES_API_KEY;

const GOOGLE_ROUTES_URL =
  'https://routes.googleapis.com/directions/v2:computeRoutes';

app.use(express.json({limit: '10kb'}));

// ----------------------------------------
// HELPERS
// ----------------------------------------

function validPoint(point) {
  return (
    point &&
    typeof point.latitude === 'number' &&
    typeof point.longitude === 'number' &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180
  );
}

function distanceBetween(a, b) {
  const rad = value => (value * Math.PI) / 180;

  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(dLon / 2) ** 2;

  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function validateStops(stops) {
  if (
    !Array.isArray(stops) ||
    stops.length < 2 ||
    stops.length > 5 ||
    !stops.every(validPoint)
  ) {
    return 'Provide between 2 and 5 valid locations';
  }

  for (let i = 1; i < stops.length; i++) {
    const distance = distanceBetween(
      stops[i - 1],
      stops[i],
    );

    if (distance > 4000) {
      return 'Each consecutive stop must be within 4 km for walking';
    }

    if (distance < 5) {
      return 'Consecutive stops must be different';
    }
  }

  return null;
}

function toWaypoint(point) {
  return {
    location: {
      latLng: {
        latitude: point.latitude,
        longitude: point.longitude,
      },
    },
  };
}

function toPoints(polyline) {
  const coordinates =
    polyline?.geoJsonLinestring?.coordinates;

  if (!Array.isArray(coordinates)) {
    return [];
  }

  return coordinates
    .filter(
      pair =>
        Array.isArray(pair) &&
        pair.length >= 2 &&
        Number.isFinite(pair[0]) &&
        Number.isFinite(pair[1]) &&
        Math.abs(pair[0]) <= 180 &&
        Math.abs(pair[1]) <= 90,
    )
    .map(([longitude, latitude]) => ({
      latitude,
      longitude,
    }));
}

function toMinutes(duration) {
  const seconds = Number.parseFloat(duration);

  return Number.isFinite(seconds)
    ? Math.ceil(seconds / 60)
    : null;
}

// ----------------------------------------
// GOOGLE ROUTES API
// ----------------------------------------

async function requestGoogleRoutes(body, fieldMask) {
  if (!API_KEY) {
    throw new Error(
      'GOOGLE_ROUTES_API_KEY missing in routes-poc/.env',
    );
  }

  const response = await fetch(GOOGLE_ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': fieldMask.join(','),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  const raw = await response.text();

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Google returned non-JSON (HTTP ${response.status})`,
    );
  }

  if (!response.ok) {
    console.error(
      'Google Routes API:',
      response.status,
      data.error?.message,
    );

    throw new Error('Google Routes request failed');
  }

  return data;
}

// ----------------------------------------
// WALKING ROUTE CALCULATION
// ----------------------------------------

async function computeWalkingRoute(stops) {
  const data = await requestGoogleRoutes(
    {
      origin: toWaypoint(stops[0]),
      destination: toWaypoint(
        stops[stops.length - 1],
      ),

      intermediates: stops
        .slice(1, -1)
        .map(toWaypoint),

      travelMode: 'WALK',
      polylineEncoding: 'GEO_JSON_LINESTRING',
    },
    [
      'routes.duration',
      'routes.distanceMeters',
      'routes.polyline.geoJsonLinestring',
      'routes.legs.duration',
      'routes.legs.distanceMeters',
      'routes.legs.polyline.geoJsonLinestring',
      'routes.warnings',
    ],
  );

  const route = data.routes?.[0];

  if (!route) {
    return null;
  }

  const points = toPoints(route.polyline);

  const legs = (route.legs || []).map(
    (leg, index) => ({
      fromIndex: index,
      toIndex: index + 1,
      distanceMeters: leg.distanceMeters,
      durationMinutes: toMinutes(leg.duration),
      points: toPoints(leg.polyline),
    }),
  );

  if (
    points.length < 2 ||
    legs.length !== stops.length - 1
  ) {
    throw new Error(
      'Google returned incomplete walking geometry or legs',
    );
  }

  return {
    points,
    legs,
    distanceMeters: route.distanceMeters,
    durationMinutes: toMinutes(route.duration),
    warnings: route.warnings || [],
  };
}

// ----------------------------------------
// HEALTH CHECK
// ----------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'UK Travel Planner Routes POC',
  });
});

// ----------------------------------------
// 1. SINGLE WALKING ROUTE
// ----------------------------------------

app.post('/walking-route', async (req, res) => {
  const {origin, destination} = req.body || {};

  const stops = [origin, destination];
  const error = validateStops(stops);

  if (error) {
    return res.status(400).json({error});
  }

  try {
    const route = await computeWalkingRoute(stops);

    if (!route) {
      return res.status(404).json({
        error: 'No walking route found',
      });
    }

    return res.json(route);
  } catch (err) {
    console.error(
      'Walking route error:',
      err.message,
    );

    return res.status(502).json({
      error: 'Unable to calculate walking route',
    });
  }
});

// ----------------------------------------
// 2. MULTI-STOP WALKING ROUTE
// ----------------------------------------

app.post('/multi-walking-route', async (req, res) => {
  const stops = req.body?.stops;
  const error = validateStops(stops);

  if (error) {
    return res.status(400).json({error});
  }

  try {
    const route = await computeWalkingRoute(stops);

    if (!route) {
      return res.status(404).json({
        error: 'No walking route found',
      });
    }

    return res.json(route);
  } catch (err) {
    console.error(
      'Multi-stop walking error:',
      err.message,
    );

    return res.status(502).json({
      error: 'Unable to calculate full walking trip',
    });
  }
});

// ----------------------------------------
// 3. BUS AND PUBLIC TRANSPORT
// ----------------------------------------

app.post('/transit-route', async (req, res) => {
  const {
    origin,
    destination,
    mode = 'ALL',
  } = req.body || {};

  if (
    !validPoint(origin) ||
    !validPoint(destination)
  ) {
    return res.status(400).json({
      error: 'Valid origin and destination required',
    });
  }

  if (!['BUS', 'ALL'].includes(mode)) {
    return res.status(400).json({
      error: 'Mode must be BUS or ALL',
    });
  }

  const distance = distanceBetween(
    origin,
    destination,
  );

  if (distance < 5) {
    return res.status(400).json({
      error: 'Origin and destination must be different',
    });
  }

  // POC limit: walking is 4 km per leg,
  // public transport can cover up to 25 km.
  if (distance > 25000) {
    return res.status(400).json({
      error:
        'Transit POC supports points up to 25 km apart',
    });
  }

  try {
    const data = await requestGoogleRoutes(
      {
        origin: toWaypoint(origin),
        destination: toWaypoint(destination),

        travelMode: 'TRANSIT',
        polylineEncoding: 'GEO_JSON_LINESTRING',

        ...(mode === 'BUS'
          ? {
              transitPreferences: {
                allowedTravelModes: ['BUS'],
              },
            }
          : {}),
      },
      [
        'routes.duration',
        'routes.distanceMeters',
        'routes.polyline.geoJsonLinestring',
        'routes.legs.steps.travelMode',
        'routes.legs.steps.transitDetails',
        'routes.localizedValues.transitFare',
      ],
    );

    const route = data.routes?.[0];

    if (!route) {
      return res.status(404).json({
        error:
          'No public transport route found',
      });
    }

    const points = toPoints(route.polyline);

    if (points.length < 2) {
      return res.status(502).json({
        error:
          'Transit route geometry unavailable',
      });
    }

    // Extract bus/train line, boarding stop
    // and alighting stop from each transit step.
    const steps = (route.legs || []).flatMap(
      leg =>
        (leg.steps || []).map(step => {
          const details = step.transitDetails;
          const line = details?.transitLine;

          return {
            type:
              step.travelMode === 'TRANSIT'
                ? line?.vehicle?.type ||
                  'TRANSIT'
                : step.travelMode || 'WALK',

            line:
              line?.nameShort ||
              line?.name ||
              null,

            from:
              details?.stopDetails
                ?.departureStop?.name || null,

            to:
              details?.stopDetails
                ?.arrivalStop?.name || null,
          };
        }),
    );

    return res.json({
      points,

      distanceMeters:
        route.distanceMeters ?? 0,

      durationMinutes:
        toMinutes(route.duration),

      // Google may omit this field when
      // fare information is incomplete.
      fare:
        route.localizedValues
          ?.transitFare?.text || null,

      steps,
    });
  } catch (err) {
    console.error(
      'Transit route error:',
      err.message,
    );

    return res.status(502).json({
      error:
        'Unable to calculate public transport route',
    });
  }
});

// ----------------------------------------
// JSON ERROR HANDLING
// ----------------------------------------

app.use((err, _req, res, _next) => {
  if (
    err instanceof SyntaxError &&
    'body' in err
  ) {
    return res.status(400).json({
      error: 'Invalid JSON body',
    });
  }

  console.error(
    'Unexpected Express error:',
    err.message,
  );

  return res.status(500).json({
    error: 'Unexpected server error',
  });
});

// ----------------------------------------
// START SERVER
// ----------------------------------------

app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `Routes backend running on http://127.0.0.1:${PORT}`,
  );
});
