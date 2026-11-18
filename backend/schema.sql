-- Hotel Entity Resolution V3. Run once against the EXISTING milemosaic database.
-- Does NOT drop or modify cities / places or any previous tables.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Spatial candidate retrieval already uses your places_geography_idx.
-- This index additionally supports future name-first / similarity searches.
CREATE INDEX IF NOT EXISTS places_hotel_name_trgm_idx
ON places USING GIN (lower(name) gin_trgm_ops)
WHERE category = 'tourism'
  AND subcategory IN ('hotel', 'hostel', 'guest_house', 'motel')
  AND name IS NOT NULL;

CREATE TABLE IF NOT EXISTS hotel_entity_links (
    hotel_key TEXT PRIMARY KEY,
    xotelo_name TEXT NOT NULL,
    city TEXT NOT NULL,
    osm_type TEXT,
    osm_id TEXT,
    osm_name TEXT,
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'possible', 'unmatched')),
    review_state TEXT NOT NULL DEFAULT 'auto'
        CHECK (review_state IN ('auto', 'approved', 'rejected')),
    name_score DOUBLE PRECISION,
    separation_m INTEGER,
    algorithm TEXT NOT NULL DEFAULT 'rapidfuzz-v3',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((osm_type IS NULL AND osm_id IS NULL) OR
           (osm_type IS NOT NULL AND osm_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS hotel_entity_links_city_idx
 ON hotel_entity_links(lower(city));

CREATE INDEX IF NOT EXISTS hotel_entity_links_osm_lookup
 ON hotel_entity_links(osm_type, osm_id);

-- Enforce one-to-one automatic confirmation. Uncertain pairs are not unique.
CREATE UNIQUE INDEX IF NOT EXISTS hotel_entity_links_one_confirmed_osm
 ON hotel_entity_links(osm_type, osm_id)
 WHERE status = 'confirmed' AND review_state <> 'rejected'
       AND osm_type IS NOT NULL AND osm_id IS NOT NULL;
