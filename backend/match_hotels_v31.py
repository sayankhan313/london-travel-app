#!/usr/bin/env python3
"""Offline and versioned OSM/Xotelo hotel entity resolution.

No frontend changes. No hotel keys/prices hardcoded. No live API key required.
Old V3 automatic links are replaced ONLY for the selected city on --apply.
Approved/rejected human review decisions are preserved.
"""
from __future__ import annotations

import argparse
import csv
import os
import random
import re
import sys
from collections import Counter, defaultdict
from dataclasses import replace
from math import asin, cos, radians, sin, sqrt

import psycopg
from psycopg.rows import dict_row
import requests
from hotel_match_quality_v31 import Pair, score_pair, decide_claims

CITY_KEYS = {"london": "g186338", "manchester": "g187069", "edinburgh": "g186525"}
CATEGORIES = ('hotel', 'hostel', 'guest_house', 'motel')

SQL_CANDIDATES = """
WITH point AS (SELECT ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography AS g)
SELECT p.osm_id::text AS osm_id, p.osm_type, p.name AS osm_name, p.subcategory,
       ROUND(ST_Distance(ST_Transform(p.geom,4326)::geography,point.g))::int AS separation_m,
       similarity(lower(p.name),lower(%s))::float AS trigram_score
FROM places p CROSS JOIN point
WHERE p.category='tourism' AND p.subcategory=ANY(%s::text[])
  AND p.name IS NOT NULL AND length(trim(p.name))>0
  AND ST_DWithin(ST_Transform(p.geom,4326)::geography,point.g,120)
ORDER BY ST_Distance(ST_Transform(p.geom,4326)::geography,point.g)
LIMIT 25
"""

UPSERT_SQL = """
INSERT INTO hotel_entity_links
(hotel_key,xotelo_name,city,osm_type,osm_id,osm_name,status,name_score,
 separation_m,algorithm,match_reason)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'rapidfuzz-v3.1',%s)
ON CONFLICT (hotel_key) DO UPDATE SET
 xotelo_name=EXCLUDED.xotelo_name,city=EXCLUDED.city,
 osm_type=EXCLUDED.osm_type,osm_id=EXCLUDED.osm_id,osm_name=EXCLUDED.osm_name,
 status=EXCLUDED.status,name_score=EXCLUDED.name_score,
 separation_m=EXCLUDED.separation_m,algorithm=EXCLUDED.algorithm,
 match_reason=EXCLUDED.match_reason,updated_at=now()
WHERE hotel_entity_links.review_state='auto'
"""


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    a,b,c,d = map(radians,(lat1,lon1,lat2,lon2))
    return 12742000*asin(min(1,sqrt(sin((c-a)/2)**2 + cos(a)*cos(c)*sin((d-b)/2)**2)))


def fetch_hotels(session, location_key: str, pages: int):
    data = []
    total = None
    for page in range(pages):
        response = session.get('https://data.xotelo.com/api/list',params={
            'location_key':location_key,'offset':page*100,'limit':100,'sort':'popularity'
        },timeout=25)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload,dict) or payload.get('error') or not isinstance(payload.get('result'),dict):
            raise ValueError(f'Unexpected Xotelo payload on page {page}: {str(payload)[:200]}')
        result=payload['result']
        total=result.get('total_count',total)
        batch=result.get('list',[])
        if not isinstance(batch,list):
            raise ValueError('Xotelo returned invalid hotel list')
        data.extend(batch)
        if len(batch)<100:
            break
    hotels=[]
    keys=set()
    for h in data:
        if not isinstance(h,dict):
            continue
        k=h.get('key')
        geo=h.get('geo')
        if not isinstance(k,str) or not re.fullmatch(r'g\d+-d\d+',k) or k in keys or not isinstance(h.get('name'),str) or not isinstance(geo,dict):
            continue
        try: lat=float(geo['latitude']); lon=float(geo['longitude'])
        except (KeyError,ValueError,TypeError): continue
        if not (-90<=lat<=90 and -180<=lon<=180): continue
        if not h['name'].strip(): continue
        keys.add(k)
        hotels.append({'key':k,'name':h['name'].strip(),'lat':lat,'lon':lon})
    return hotels,total



def resolve(hotels, con, city: str, radius: int, lat: float, lon: float):
    nearby=[h for h in hotels if distance_m(lat,lon,h['lat'],h['lon'])<=radius]
    scores={}
    with con.cursor(row_factory=dict_row) as cur:
        for h in nearby:
            cur.execute(SQL_CANDIDATES,(h['lon'],h['lat'],h['name'],list(CATEGORIES)))
            scores[h['key']]=[score_pair(h,p,city) for p in cur.fetchall()]
    keys=[h['key'] for h in nearby]
    with con.cursor() as cur:
        cur.execute("""SELECT osm_type,osm_id FROM hotel_entity_links
            WHERE status='confirmed' AND review_state<>'rejected'
              AND NOT (hotel_key = ANY(%s::text[]) AND review_state='auto')""",(keys,))
        occupied={(t,str(i)) for t,i in cur.fetchall()}
        cur.execute("""SELECT hotel_key FROM hotel_entity_links
            WHERE review_state<>'auto' AND hotel_key=ANY(%s::text[])""",(keys,))
        reviewed={x[0] for x in cur.fetchall()}
    return decide_claims(nearby,scores,occupied,reviewed),len(nearby),len(reviewed)


def export_review_csv(path:str, rows:list[dict], sample_size:int, seed:int):
    rng=random.Random(seed)
    by_status=defaultdict(list)
    for r in rows:
        if r['pair'] is not None and r['status'] in ('confirmed','possible'):
            by_status[r['status']].append(r)
    if sample_size:
        # A deliberate STRATIFIED sample, not a random population sample.
        confirmed=by_status.get('confirmed',[])
        possible=by_status.get('possible',[])
        first=rng.sample(confirmed,min(len(confirmed),round(sample_size*0.65)))
        second=rng.sample(possible,min(len(possible),sample_size-len(first)))
        chosen=first+second
        remaining=[r for r in confirmed+possible if r not in chosen]
        chosen+=rng.sample(remaining,min(len(remaining),max(0,sample_size-len(chosen))))
        rng.shuffle(chosen)
    else:
        chosen=by_status['confirmed']+by_status['possible']
    columns=['hotel_key','osm_type','osm_id','xotelo_name','osm_name','status',
             'name_score','separation_m','reason','same_hotel_yes_no']
    with open(path,'w',encoding='utf-8',newline='') as handle:
        out=csv.DictWriter(handle,fieldnames=columns)
        out.writeheader()
        for r in chosen:
            p=r['pair']
            out.writerow({'hotel_key':r['hotel_key'],'osm_type':p.osm_type,'osm_id':p.osm_id,
                'xotelo_name':r['xotelo_name'],'osm_name':p.osm_name,'status':r['status'],
                'name_score':p.name_score,'separation_m':p.distance_m,
                'reason':r['reason'],'same_hotel_yes_no':''})
    return Counter(r['status'] for r in chosen)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--city',required=True)
    parser.add_argument('--location-key',help='Optional verified Xotelo city key g1234')
    parser.add_argument('--pages',type=int,default=2)
    parser.add_argument('--radius',type=int,default=6000)
    parser.add_argument('--apply',action='store_true',help='Persist V3.1 results; default is SAFE DRY RUN')
    parser.add_argument('--review-csv',help='Export pairs for manual yes/no labels')
    parser.add_argument('--review-size',type=int,default=60,help='Number of stratified review rows; 0 = all pairs')
    parser.add_argument('--seed',type=int,default=31)
    args=parser.parse_args()
    if not 1<=args.pages<=10 or not 500<=args.radius<=30000 or not 0<=args.review_size<=1000:
        parser.error('pages=1..10, radius=500..30000, review-size=0..1000')
    location_key=args.location_key or CITY_KEYS.get(args.city.strip().lower())
    if not location_key or not re.fullmatch(r'g\d+',location_key):
        parser.error('Use a verified Xotelo location key for this city (otherwise use OSM-only fallback)')
    config={'dbname':os.environ.get('PGDATABASE','milemosaic'),
            'user':os.environ.get('PGUSER',os.environ.get('USER','')),
            'host':os.environ.get('PGHOST','/tmp'),'port':os.environ.get('PGPORT','5432')}
    with psycopg.connect(**config) as con:
        with con.cursor() as cur:
            cur.execute("""SELECT name,ST_Y(geom),ST_X(geom) FROM cities
               WHERE lower(name)=lower(%s)
               ORDER BY CASE place_type WHEN 'city' THEN 1 WHEN 'town' THEN 2 ELSE 3 END
               LIMIT 1""",(args.city.strip(),))
            c=cur.fetchone()
            if c is None: raise ValueError(f'No local OSM city named {args.city!r}')
        with requests.Session() as session:
            hotels,total=fetch_hotels(session,location_key,args.pages)
        rows,nearby,reviewed=resolve(hotels,con,c[0],args.radius,c[1],c[2])
        counts=Counter(r['status'] for r in rows)
        print(f'City {c[0]} | provider total {total} | scanned {len(hotels)} | nearby {nearby} | human decisions preserved {reviewed}')
        print(f'V3.1 proposed decisions: {dict(counts)}')
        for r in rows:
            if r['status']=='unmatched': continue
            p=r['pair']
            print(f"{r['status']:9} | {r['xotelo_name'][:37]:37} -> {p.osm_name[:37]:37} | {p.distance_m:3}m | {p.name_score:.3f} | {r['reason']}")
        if args.review_csv:
            breakdown=export_review_csv(args.review_csv,rows,args.review_size,args.seed)
            print(f'Review CSV: {args.review_csv}; status counts: {dict(breakdown)}; label yes/no only after manual verification')
        if not args.apply:
            print('DRY RUN: database unchanged; use --apply after inspecting results')
            return
        # Clear prior AUTO confirmation status for this city's keys first, to
        # avoid transient unique-index clashes when the best matches change.
        # Human approved/rejected rows are untouched.
        keys=[r['hotel_key'] for r in rows]
        with con.cursor() as cur:
            cur.execute("""UPDATE hotel_entity_links SET status='possible'
               WHERE hotel_key=ANY(%s::text[]) AND review_state='auto' AND status='confirmed'""",(keys,))
            for r in rows:
                p=r['pair']
                cur.execute(UPSERT_SQL,(r['hotel_key'],r['xotelo_name'],c[0],
                    p.osm_type if p else None,p.osm_id if p else None,
                    p.osm_name if p else None,r['status'],p.name_score if p else None,
                    p.distance_m if p else None,r['reason']))
        con.commit()
        print(f'Applied {len(rows)} automatic V3.1 decisions. Prices untouched. Manual approvals/rejections preserved.')


if __name__=='__main__':
    try: main()
    except (ValueError,psycopg.Error,requests.RequestException) as exc:
        print(f'ERROR: {exc}',file=sys.stderr)
        sys.exit(1)
