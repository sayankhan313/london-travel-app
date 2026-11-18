
const API = "https://ovp.dresel.systems/api/interpreter";

// Replace with a real developer contact email.
// No registration is required.
const USER_AGENT =
  "MileMosaicPOC/0.1 (contact: YOUR_EMAIL)";

const lat = 51.5007;
const lon = -0.1246;

const query = `
[out:json][timeout:15];
(
  nwr["tourism"~"^(attraction|museum|gallery)$"]["name"]
    (around:900,${lat},${lon});

  nwr["tourism"~"^(hotel|hostel|guest_house)$"]["name"]
    (around:900,${lat},${lon});

  nwr["amenity"~"^(restaurant|cafe)$"]["name"]
    (around:900,${lat},${lon});
);
out center 80;
`;

async function test() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  console.log("Testing FREE OpenStreetMap places API...");
  console.log("Server:", API);

  const started = Date.now();

  try {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({data: query}).toString(),
      signal: controller.signal,
    });

    console.log("HTTP:", res.status);
    console.log("Time:", Date.now() - started, "ms");

    if (!res.ok) {
      console.log("Error:", (await res.text()).slice(0, 400));
      return;
    }

    const data = await res.json();
    const places = data.elements || [];

    const getCategory = tags => {
      if (["hotel", "hostel", "guest_house"].includes(tags.tourism)) {
        return "HOTEL";
      }
      if (["restaurant", "cafe"].includes(tags.amenity)) {
        return "FOOD";
      }
      return "ATTRACTION";
    };

    console.log("SUCCESS! Total records:", places.length);

    for (const place of places) {
      const tags = place.tags || {};
      console.log(
        getCategory(tags),
        "|",
        tags.name,
        "|",
        place.lat ?? place.center?.lat,
        place.lon ?? place.center?.lon
      );
    }
  } catch (err) {
    console.log("FAILED:", err.message);
    if (err.cause) {
      console.log("CAUSE:", err.cause.message);
    }
  } finally {
    clearTimeout(timeout);
  }
}

test();
