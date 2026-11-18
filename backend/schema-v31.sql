-- MileMosaic Hotel Matching V3.1 (additive migration).
-- Requires the existing V3 hotel_entity_links table and pg_trgm.
-- Does not drop/recreate existing OSM data or previously reviewed hotel links.
ALTER TABLE hotel_entity_links ADD COLUMN IF NOT EXISTS match_reason TEXT;
CREATE INDEX IF NOT EXISTS hotel_entity_links_version_idx
  ON hotel_entity_links (algorithm, review_state);
