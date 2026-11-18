#!/usr/bin/env python3
"""Estimate precision on manually labelled V3 candidate links. No dependencies."""
import argparse
import csv

parser = argparse.ArgumentParser()
parser.add_argument('csv_file', help='CSV exported by match_hotels_v3.py --review-csv')
args = parser.parse_args()
with open(args.csv_file, encoding='utf-8', newline='') as f:
    rows = list(csv.DictReader(f))

labelled = [r for r in rows if r['same_hotel_yes_no'].strip().lower() in ('yes', 'no')]
confirmed = [r for r in labelled if r['status'] == 'confirmed']
correct = sum(r['same_hotel_yes_no'].strip().lower() == 'yes' for r in confirmed)
incorrect = len(confirmed) - correct
print(f'Labelled pairs: {len(labelled)} / {len(rows)}')
print(f'Reviewed confirmed links: {len(confirmed)}')
print(f'True confirmed matches: {correct}; false confirmed matches: {incorrect}')
print(f'Observed precision on labelled confirmed links: {correct/len(confirmed):.1%}' if confirmed else 'Label confirmed links to estimate precision.')
print('Not population-wide accuracy; recall cannot be measured without exhaustive labelled OSM candidate pairs.')
