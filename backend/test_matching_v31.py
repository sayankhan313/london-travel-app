#!/usr/bin/env python3
"""Offline no-database safety checks. Run: .venv/bin/python -m unittest -v test_matching_v31.py"""
import unittest
from hotel_match_quality_v31 import score_pair, decide_claims


def pair(xotelo, osm, metres, city, category='hotel', key='g1-d1', osm_id='111'):
    return score_pair({'key':key,'name':xotelo},
        {'osm_id':osm_id,'osm_type':'W','osm_name':osm,'subcategory':category,
         'separation_m':metres,'trigram_score':0.75},city)


class MatchQualityTests(unittest.TestCase):
    def test_balmoral_regression(self):
        self.assertEqual(pair('The Balmoral Hotel','Balmoral Hotel',23,'Edinburgh').decision,'confirmed')

    def test_trafalgar_marketing_suffix(self):
        self.assertEqual(pair('The Trafalgar St. James',
            'The Trafalgar St. James London, Curio Collection by Hilton',21,'London').decision,'confirmed')

    def test_king_street_townhouse(self):
        self.assertEqual(pair('King Street Townhouse Hotel And Spa','King Street Townhouse',1,'Manchester').decision,'confirmed')

    def test_exact_resident_covent_garden(self):
        self.assertEqual(pair('The Resident Covent Garden','The Resident Covent Garden',8,'London').decision,'confirmed')

    def test_different_brand_same_location_does_not_match(self):
        self.assertEqual(pair('Novotel Manchester Centre','Ibis Hotel Manchester City Centre',20,'Manchester').decision,'unmatched')

    def test_hostel_is_not_hotel(self):
        p=pair('Hotel Indigo Edinburgh - Princes Street By IHG','Princes Street Hostel',7,'Edinburgh',category='hostel')
        self.assertEqual(p.decision,'unmatched')
        self.assertEqual(p.reason,'hotel_hostel_type_conflict')

    def test_chain_only_name_is_not_confirmed(self):
        self.assertNotEqual(pair('Premier Inn Manchester City (Piccadilly)','Premier Inn',3,'Manchester').decision,'confirmed')

    def test_chain_with_missing_branch_not_confirmed(self):
        self.assertNotEqual(pair('Club Quarters Hotel Trafalgar Square, London','Club Quarters Hotel',19,'London').decision,'confirmed')

    def test_cross_property_residences(self):
        self.assertEqual(pair('Corinthia London','Corinthia Residences',12,'London').decision,'unmatched')

    def test_distance_matters(self):
        self.assertEqual(pair('The Balmoral Hotel','Balmoral Hotel',145,'Edinburgh').decision,'unmatched')

    def test_conflicting_duplicate_provider_keys_need_manual_review(self):
        a=pair('The Resident Covent Garden','The Resident Covent Garden',8,'London',key='g1-d1',osm_id='111')
        b=pair('The Resident Covent Garden','The Resident Covent Garden',10,'London',key='g1-d2',osm_id='111')
        rows=decide_claims([{'key':'g1-d1','name':a.xotelo_name},{'key':'g1-d2','name':b.xotelo_name}],
                           {'g1-d1':[a],'g1-d2':[b]},set(),set())
        self.assertEqual([r['status'] for r in rows].count('confirmed'),0)
        self.assertEqual([r['status'] for r in rows].count('possible'),2)

    def test_one_to_one_reserved_osm(self):
        a=pair('Great Scotland Yard Hotel','Great Scotland Yard Hotel',5,'London')
        rows=decide_claims([{'key':'g1-d1','name':a.xotelo_name}],{'g1-d1':[a]}, {('W','111')},set())
        self.assertEqual(rows[0]['status'],'possible')


if __name__=='__main__':
    unittest.main()
