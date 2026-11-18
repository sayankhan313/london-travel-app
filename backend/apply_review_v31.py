#!/usr/bin/env python3
"""Apply manually checked yes/no labels to stored candidate links.

Default: dry run. Requires --apply to write. Uses original identifiers and
checks database candidate identity, rejecting stale or conflicting rows.
A 'yes' means the reviewer independently verified SAME physical hotel.
"""
import argparse
import csv
import os
import sys
import psycopg

p=argparse.ArgumentParser()
p.add_argument('csv_file')
p.add_argument('--apply',action='store_true',help='Persist reviews; default dry run')
a=p.parse_args()
config={'dbname':os.environ.get('PGDATABASE','milemosaic'),
        'user':os.environ.get('PGUSER',os.environ.get('USER','')),
        'host':os.environ.get('PGHOST','/tmp'),'port':os.environ.get('PGPORT','5432')}
with open(a.csv_file,encoding='utf-8',newline='') as f:
    rows=list(csv.DictReader(f))
labels=[r for r in rows if (r.get('same_hotel_yes_no') or '').strip().casefold() in ('yes','no')]
print(f'Rows labelled yes/no: {len(labels)} of {len(rows)}')
if not labels:
    sys.exit('No labelled rows, database unchanged')
seen=set()
try:
    with psycopg.connect(**config) as con:
        with con.cursor() as cur:
            for r in labels:
                key=r.get('hotel_key') or ''
                if key in seen: raise ValueError(f'Duplicate hotel_key in CSV: {key}')
                seen.add(key)
                cur.execute('SELECT osm_type,osm_id,review_state,status,algorithm FROM hotel_entity_links WHERE hotel_key=%s',(key,))
                record=cur.fetchone()
                if not record or record[4]!='rapidfuzz-v3.1':
                    raise ValueError(f'Missing/newer/unmigrated V3.1 candidate for {key}')
                if record[2]!='auto':
                    raise ValueError(f'Previously reviewed hotel {key}; refusing overwrite')
                if record[0]!=r.get('osm_type') or str(record[1])!=r.get('osm_id'):
                    raise ValueError(f'Stale candidate identity in CSV for {key}')
                label=r['same_hotel_yes_no'].strip().casefold()
                if label=='yes':
                    cur.execute("""SELECT hotel_key FROM hotel_entity_links WHERE
                        osm_type=%s AND osm_id=%s AND hotel_key<>%s AND
                        status='confirmed' AND review_state<>'rejected'""",
                        (record[0],record[1],key))
                    if cur.fetchone(): raise ValueError(f'OSM entity already confirmed by another hotel: {key}')
                print(f'{"APPROVE" if label=="yes" else "REJECT"}: {key} -> {record[0]}:{record[1]}')
            if a.apply:
                for r in labels:
                    label=r['same_hotel_yes_no'].strip().casefold()
                    if label=='yes':
                        cur.execute("""UPDATE hotel_entity_links SET review_state='approved',
                            status='confirmed',match_reason='human_verified_yes',updated_at=now()
                            WHERE hotel_key=%s AND review_state='auto'""",(r['hotel_key'],))
                    else:
                        cur.execute("""UPDATE hotel_entity_links SET review_state='rejected',
                            status='unmatched',match_reason='human_verified_no',updated_at=now()
                            WHERE hotel_key=%s AND review_state='auto'""",(r['hotel_key'],))
                con.commit()
                print(f'Committed {len(labels)} human decisions')
            else:
                con.rollback()
                print('DRY RUN only — use --apply after reviewing this list')
except (psycopg.Error,ValueError) as e:
    print('Review not applied:',e,file=sys.stderr)
    sys.exit(1)
