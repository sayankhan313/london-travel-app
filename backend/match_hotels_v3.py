#!/usr/bin/env python3
"""MileMosaic: conservative OSM <> Xotelo entity resolution.

Run manually to refresh verified/suggested hotel links (not on every API request).
No hotel IDs or hotel names are hard-coded; only three known Xotelo CITY keys
are mapped for the free /list API. Other cities accept --location-key g123.
Only uses the public Xotelo list API; no API keys required.

Safety: unmatched is normal, proposed matches are not always genuine, and
provider prices must ALWAYS be retrieved with the exact Xotelo hotel_key.
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import unicodedata
from dataclasses import dataclass
from typing import Optional

import psycopg
from psycopg.rows import dict_row
import requests
from rapidfuzz import fuzz

CITY_KEYS = {"london": "g186338", "manchester": "g187069", "edinburgh": "g186525"}
STOP = {"a", "an", "and", "at", "by", "collection", "curio", "hotel", "hotels", "of", "resort", "resorts", "spa", "the"}
CATEGORIES = ("hotel", "hostel", "guest_house", "motel")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.casefold().replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(word for word in text.split() if word not in STOP)


def tokens(text: str) -> set[str]:
    return set(normalize(text).split())


@dataclass
class Pair:
    hotel_key: str
    xotelo_name: str
    osm_id: str
    osm_type: str
    osm_name: str
    distance_m: int
    name_score: float
    shared: int
    overlap: float
    exact_core: bool
    decision: str


def score_pair(hotel: dict, osm: dict) -> Pair:
    x_name, o_name = hotel["name"], osm["osm_name"]
    x_norm, o_norm = normalize(x_name), normalize(o_name)
    x_tokens, o_tokens = tokens(x_name), tokens(o_name)
    shared = len(x_tokens & o_tokens)
    shorter = max(1, min(len(x_tokens), len(o_tokens)))
    overlap = shared / shorter
    metres = int(osm["separation_m"])
    trgm = max(0.0, min(1.0, float(osm["trigram_score"] or 0)))
    wratio = fuzz.WRatio(x_norm, o_norm) / 100
    token_set = fuzz.token_set_ratio(x_norm, o_norm) / 100
    ratio = fuzz.ratio(x_norm, o_norm) / 100
    score = 0.35 * wratio + 0.30 * token_set + 0.20 * ratio + 0.15 * trgm
    exact_core = bool(x_norm and o_norm and x_norm == o_norm)

    # A shared brand token alone is dangerous (e.g. 'Corinthia').
    # Only exact, tightly colocated one-token cores can be auto-confirmed.
    if exact_core and metres <= 35:
        decision = "confirmed"
    elif shared >= 2 and overlap >= 0.99 and metres <= 35 and score >= 0.73:
        decision = "confirmed"
    elif shared >= 2 and overlap >= 0.75 and metres <= 50 and score >= 0.84:
        decision = "confirmed"
    elif shared >= 2 and overlap >= 0.6 and metres <= 100 and score >= 0.60:
        decision = "possible"
    elif exact_core and metres <= 100:
        decision = "possible"
    else:
        decision = "unmatched"

    return Pair(
        hotel_key=hotel["key"], xotelo_name=x_name,
        osm_id=str(osm["osm_id"]), osm_type=osm["osm_type"],
        osm_name=o_name, distance_m=metres,
        name_score=round(score, 4), shared=shared,
        overlap=round(overlap, 4), exact_core=exact_core,
        decision=decision,
    )


# Uses the existing indexed ST_Transform(geom,4326)::geography expression;
# one city/page only, with at most 20 candidates per hotel.
CANDIDATES_SQL = """
WITH point AS (
    SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography AS g
)
SELECT p.osm_id::text AS osm_id, p.osm_type, p.name AS osm_name,
       ROUND(ST_Distance(ST_Transform(p.geom,4326)::geography, point.g))::int AS separation_m,
       similarity(lower(p.name), lower(%s))::float AS trigram_score
FROM places p CROSS JOIN point
WHERE p.category='tourism' AND p.subcategory=ANY(%s::text[])
  AND p.name IS NOT NULL AND length(trim(p.name)) > 0
  AND ST_DWithin(ST_Transform(p.geom,4326)::geography, point.g, 120)
ORDER BY ST_Distance(ST_Transform(p.geom,4326)::geography, point.g) ASC
LIMIT 20
"""


def fetch_hotels(session: requests.Session, key: str, pages: int) -> tuple[list[dict], int | None]:
    collected: list[dict] = []
    total: int | None = None
    for page in range(pages):
        response = session.get("https://data.xotelo.com/api/list", params={
            "location_key": key, "offset": page * 100, "limit": 100,
            "sort": "popularity",
        }, timeout=25)
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or body.get("error") or not isinstance(body.get("result"), dict):
            raise RuntimeError(f"Xotelo error on page {page}: {str(body)[:350]}")
        result = body["result"]
        total = result.get("total_count", total)
        hotels = result.get("list", [])
        if not isinstance(hotels, list):
            raise RuntimeError("Xotelo /list returned unexpected data")
        collected.extend(hotels)
        if len(hotels) < 100:
            break
    seen: set[str] = set()
    valid: list[dict] = []
    for hotel in collected:
        if not isinstance(hotel, dict):
            continue
        key = hotel.get("key")
        geo = hotel.get("geo") or {}
        if (not isinstance(key, str) or not re.fullmatch(r"g\d+-d\d+", key)
            or key in seen or not isinstance(hotel.get("name"), str)
            or not hotel["name"].strip() or not isinstance(geo, dict)):
            continue
        try:
            latitude, longitude = float(geo["latitude"]), float(geo["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            continue
        seen.add(key)
        valid.append({"key": key, "name": hotel["name"], "lat": latitude, "lon": longitude})
    return valid, total


def resolve(hotels: list[dict], connection, radius_m: int, center_lat: float, center_lon: float):
    """Score every spatial candidate and select conservative 1:1 links."""
    # DB-side geo is authoritative for calculating candidate distances.
    from math import asin, cos, radians, sin, sqrt

    def haversine(a, b, c, d):
        a, b, c, d = map(radians, (a, b, c, d))
        return 6371000 * 2 * asin(min(1, sqrt(sin((c - a)/2)**2 + cos(a)*cos(c)*sin((d - b)/2)**2)))

    nearby = [h for h in hotels if haversine(center_lat, center_lon, h["lat"], h["lon"]) <= radius_m]
    pair_choices: dict[str, list[Pair]] = {}
    with connection.cursor(row_factory=dict_row) as cur:
        for hotel in nearby:
            cur.execute(CANDIDATES_SQL, (hotel["lon"], hotel["lat"], hotel["name"], list(CATEGORIES)))
            choices = [score_pair(hotel, p) for p in cur.fetchall()]
            choices = [p for p in choices if p.decision != "unmatched"]
            pair_choices[hotel["key"]] = sorted(
                choices, key=lambda x: (x.decision == "confirmed", x.name_score, -x.distance_m), reverse=True
            )

    # Reserve confirmed OSM identities from OTHER city runs (one-to-one).
    keys = [h["key"] for h in nearby]
    with connection.cursor() as cur:
        cur.execute("""SELECT osm_type, osm_id FROM hotel_entity_links
            WHERE status='confirmed' AND review_state <> 'rejected'
              AND NOT (hotel_key = ANY(%s::text[]))""", (keys,))
        occupied = {(r[0], str(r[1])) for r in cur.fetchall()}

    # Manual review rows aren't overwritten by the refresh.
    with connection.cursor() as cur:
        cur.execute("SELECT hotel_key FROM hotel_entity_links WHERE review_state <> 'auto' AND hotel_key = ANY(%s::text[])", (keys,))
        reviewed = {r[0] for r in cur.fetchall()}

    rows = []
    def best_of(key):
        return pair_choices.get(key, [None])[0] if pair_choices.get(key) else None
    for hotel in sorted(nearby, key=lambda h: (
        best_of(h["key"]) is not None and best_of(h["key"]).decision == "confirmed",
        best_of(h["key"]).name_score if best_of(h["key"]) else 0,
    ), reverse=True):
        if hotel["key"] in reviewed:
            continue
        alternatives = pair_choices.get(hotel["key"], [])
        top = alternatives[0] if alternatives else None
        chosen = top
        if chosen is None:
            status = "unmatched"
        else:
            osm_key = (chosen.osm_type, chosen.osm_id)
            status = chosen.decision
            if osm_key in occupied and status == "confirmed":
                status = "possible"
            # If two nearby plausible OSM entities compete, send for review.
            if status == "confirmed" and len(alternatives) > 1:
                second = alternatives[1]
                if (second.decision == "confirmed" and
                    abs(second.name_score - chosen.name_score) < 0.06 and
                    abs(second.distance_m - chosen.distance_m) < 25 and
                    (second.osm_type, second.osm_id) != osm_key):
                    status = "possible"
            if status == "confirmed":
                occupied.add(osm_key)
        rows.append({"hotel_key": hotel["key"], "xotelo_name": hotel["name"],
            "osm_type": chosen.osm_type if chosen else None,
            "osm_id": chosen.osm_id if chosen else None,
            "osm_name": chosen.osm_name if chosen else None,
            "status": status,
            "score": chosen.name_score if chosen else None,
            "distance": chosen.distance_m if chosen else None,
        })
    return rows, len(nearby), len(reviewed)


UPSERT_SQL = """
INSERT INTO hotel_entity_links
(hotel_key, xotelo_name, city, osm_type, osm_id, osm_name, status, name_score, separation_m, algorithm)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'rapidfuzz-v3')
ON CONFLICT (hotel_key) DO UPDATE SET
 xotelo_name=EXCLUDED.xotelo_name, city=EXCLUDED.city, osm_type=EXCLUDED.osm_type,
 osm_id=EXCLUDED.osm_id, osm_name=EXCLUDED.osm_name, status=EXCLUDED.status,
 name_score=EXCLUDED.name_score, separation_m=EXCLUDED.separation_m,
 algorithm=EXCLUDED.algorithm, updated_at=NOW()
WHERE hotel_entity_links.review_state='auto'
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--city", required=True, help="Exact UK city name, e.g. London")
    parser.add_argument("--location-key", help="Verified Xotelo city key, e.g. g186338")
    parser.add_argument("--pages", type=int, default=2, choices=range(1, 11), metavar="1-10")
    parser.add_argument("--radius", type=int, default=6000, help="Metres from chosen city centre (500..30000)")
    parser.add_argument("--dry-run", action="store_true", help="Print decisions, do NOT write matches")
    parser.add_argument("--review-csv", help="Export matching suggestions for manual precision review")
    args = parser.parse_args()
    if not 500 <= args.radius <= 30000 or not 1 <= args.pages <= 10:
        parser.error("radius must be 500-30000; pages must be 1-10")
    location_key = args.location_key or CITY_KEYS.get(args.city.strip().lower())
    if not location_key or not re.fullmatch(r"g\d+", location_key):
        parser.error("Xotelo free /list needs --location-key gNNNN for this city. OSM-only fallback remains in server.ts")

    conn_kwargs = {
        "dbname": os.environ.get("PGDATABASE", "milemosaic"),
        "user": os.environ.get("PGUSER", os.environ.get("USER", "")),
        "host": os.environ.get("PGHOST", "/tmp"),
        "port": os.environ.get("PGPORT", "5432"),
    }
    with psycopg.connect(**conn_kwargs) as con:
        with con.cursor() as cur:
            cur.execute("""SELECT name, ST_Y(geom), ST_X(geom)
                FROM cities WHERE lower(name)=lower(%s)
                ORDER BY CASE place_type WHEN 'city' THEN 1 WHEN 'town' THEN 2 ELSE 3 END
                LIMIT 1""", (args.city.strip(),))
            city = cur.fetchone()
            if not city:
                raise SystemExit(f"City {args.city!r} not found in local cities table")
        with requests.Session() as session:
            hotels, total = fetch_hotels(session, location_key, args.pages)
        matches, checked, skipped_reviewed = resolve(hotels, con, args.radius, city[1], city[2])
        counts = {status: sum(1 for x in matches if x["status"] == status)
                  for status in ("confirmed", "possible", "unmatched")}
        print(f"City: {city[0]} | Xotelo location_key: {location_key}")
        print(f"Provider hotels: {total}; scanned: {len(hotels)}; within {args.radius}m: {checked}")
        print(f"V3 decisions: {counts}; manually reviewed links preserved: {skipped_reviewed}")
        for row in matches:
            if row["status"] != "unmatched":
                print(f"{row['status']:9s} | {row['xotelo_name'][:34]:34s} -> {(row['osm_name'] or '')[:34]:34s} | {str(row['distance']):>4s}m | score={row['score']}")
        if args.review_csv:
            with open(args.review_csv, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=["hotel_key", "xotelo_name", "osm_name", "status", "name_score", "separation_m", "same_hotel_yes_no"])
                writer.writeheader()
                for row in matches:
                    writer.writerow({"hotel_key": row["hotel_key"], "xotelo_name": row["xotelo_name"],
                        "osm_name": row["osm_name"] or "", "status": row["status"],
                        "name_score": row["score"], "separation_m": row["distance"],
                        "same_hotel_yes_no": ""})
            print(f"Review CSV exported to {args.review_csv}; do not edit hotel identities without checking sources.")
        if args.dry_run:
            print("DRY RUN: nothing written to PostgreSQL")
            return
        with con.cursor() as cur:
            for row in matches:
                cur.execute(UPSERT_SQL, (row["hotel_key"], row["xotelo_name"], city[0],
                    row["osm_type"], row["osm_id"], row["osm_name"],
                    row["status"], row["score"], row["distance"]))
        con.commit()
        print(f"Saved {len(matches)} decisions to hotel_entity_links. No hotel prices were modified.")


if __name__ == "__main__":
    try:
        main()
    except (psycopg.Error, requests.RequestException, RuntimeError) as exc:
        print(f"V3 matching failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
