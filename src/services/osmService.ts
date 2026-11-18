
export type NearbyPlaceType = 'hotel' | 'restaurant';

export type NearbyPlace = {
  id: string;
  name: string;
  type: NearbyPlaceType;
  category: string;
  time: string;
  price: null;
  latitude: number;
  longitude: number;
  emoji: string;
};

type OSMElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: {
    lat: number;
    lon: number;
  };
  tags?: Record<string, string>;
};

const OVERPASS_URL =
  'https://overpass.private.coffee/api/interpreter';

function distanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const rad = (value: number) =>
    (value * Math.PI) / 180;

  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) *
      Math.cos(rad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export async function fetchNearbyPlaces(
  type: NearbyPlaceType,
  latitude: number,
  longitude: number,
  radiusMeters = 1500,
): Promise<NearbyPlace[]> {
  const tagFilter =
    type === 'hotel'
      ? '["tourism"~"^(hotel|hostel|guest_house|motel)$"]'
      : '["amenity"~"^(restaurant|cafe|fast_food)$"]';

  const query = `
    [out:json][timeout:25];
    (
      nwr${tagFilter}["name"]
      (around:${radiusMeters},${latitude},${longitude});
    );
    out center;
  `;

  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type':
        'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!response.ok) {
    throw new Error(
      `Overpass request failed: HTTP ${response.status}`,
    );
  }

  const data = (await response.json()) as {
    elements?: OSMElement[];
  };

  if (!Array.isArray(data.elements)) {
    throw new Error('Invalid Overpass response');
  }

  const places = data.elements
    .map((element): NearbyPlace | null => {
      const name = element.tags?.name;
      const lat = element.lat ?? element.center?.lat;
      const lon = element.lon ?? element.center?.lon;

      if (
        !name ||
        lat === undefined ||
        lon === undefined ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      ) {
        return null;
      }

      return {
        id: `osm-${element.type}-${element.id}`,
        name,
        type,
        category:
          element.tags?.amenity ??
          element.tags?.tourism ??
          type,
        time: 'Time not selected',
        price: null,
        latitude: lat,
        longitude: lon,
        emoji: type === 'hotel' ? '🏨' : '🍽️',
      };
    })
    .filter(
      (place): place is NearbyPlace =>
        place !== null,
    );

  return places
    .sort(
      (a, b) =>
        distanceKm(
          latitude,
          longitude,
          a.latitude,
          a.longitude,
        ) -
        distanceKm(
          latitude,
          longitude,
          b.latitude,
          b.longitude,
        ),
    )
    .slice(0, 12);
}
