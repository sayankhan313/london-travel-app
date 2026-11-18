#!/usr/bin/env python3
"""Evaluate manually labelled candidate pair precision by decision class.

Sampling is stratified by decision, so the overall labelled estimate is NOT
population-wide precision and cannot provide recall without exhaustive labels.
"""
import csv
import sys
from collections import Counter

if len(sys.argv) != 2:
    print('Usage: .venv/bin/python evaluate_review_v31.py london-review.csv')
    sys.exit(2)
with open(sys.argv[1],encoding='utf-8',newline='') as f:
    rows=list(csv.DictReader(f))
by=Counter()
labelled=0
for r in rows:
    label=(r.get('same_hotel_yes_no') or '').strip().casefold()
    if label not in ('yes','no'):
        continue
    labelled+=1
    by[(r.get('status','unknown'),label)]+=1
print(f'Labelled: {labelled}/{len(rows)}')
for decision in ['confirmed','possible','unmatched']:
    yes=by[(decision,'yes')]
    no=by[(decision,'no')]
    if yes+no:
        print(f'{decision:9}: genuinely same={yes}, different={no}, same-property share among labelled pairs={yes/(yes+no):.1%}')
    else:
        print(f'{decision:9}: no manual labels')
print('CAUTION: This is a stratified/non-exhaustive candidate sample. It does NOT measure recall or population-wide accuracy.')
