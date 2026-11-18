"""MileMosaic hotel identity candidate scoring, Version 3.1.

Safeguards:
- Similar location names are NOT sufficient to associate two hotels.
- Hotel-vs-hostel conflict is rejected without independent verification.
- Chain-only hotel labels are ambiguous unless a distinctive branch is present.
- Scores are heuristics, NOT likelihoods or measured model accuracy.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, replace
from rapidfuzz import fuzz

STOP = frozenset({"a", "an", "and", "at", "by", "collection", "curio", "hotel", "hotels", "of", "resort", "resorts", "spa", "the"})
PLACE_WORDS = frozenset({"city", "centre", "center", "central", "street", "road", "rd", "square", "station", "airport", "north", "south", "east", "west", "place", "district", "downtown"})
# Chain BRAND vocabulary is not a list of fixed hotels or hotel IDs. It helps detect
# repeated chain names which require branch-level evidence before joining prices.
CHAIN_WORDS = frozenset({
    "premier", "inn", "holiday", "express", "travelodge", "ibis", "hilton", "doubletree",
    "hampton", "radisson", "marriott", "motel", "one", "crowne", "plaza", "hyatt",
    "mercure", "novotel", "roomzzz", "voco", "indigo", "yotel", "leonardo",
    "moxy", "wyndham", "staycity", "hub", "intercontinental", "best", "western",
    "club", "quarters", "aparthotel", "aparthotels", "hostel", "hostels", "suites",
    "resident", "point", "apex", "citadines", "malmaison", "radissonblu", "easyhotel",
})


def normalize(value: str) -> str:
    v = unicodedata.normalize("NFKD", value)
    v = "".join(char for char in v if not unicodedata.combining(char))
    v = v.casefold().replace("&", " and ")
    v = re.sub(r"[^a-z0-9]+", " ", v)
    v = re.sub(r"\bsaint\b", "st", v)
    return " ".join(w for w in v.split() if w not in STOP)


def unique_words(name: str) -> set[str]:
    return set(normalize(name).split())


def informative(name: str, city: str) -> set[str]:
    generic = PLACE_WORDS | CHAIN_WORDS | set(normalize(city).split())
    return unique_words(name) - generic


@dataclass(frozen=True)
class Pair:
    hotel_key: str
    xotelo_name: str
    osm_id: str
    osm_type: str
    osm_name: str
    distance_m: int
    name_score: float
    decision: str
    reason: str
    meaningful_shared: int

    def with_decision(self, decision: str, reason: str) -> 'Pair':
        return replace(self, decision=decision, reason=reason)


def score_pair(hotel: dict, osm: dict, city: str) -> Pair:
    x_name = str(hotel["name"])
    o_name = str(osm["osm_name"])
    x_norm, o_norm = normalize(x_name), normalize(o_name)
    x_words, o_words = unique_words(x_name), unique_words(o_name)
    x_info, o_info = informative(x_name, city), informative(o_name, city)
    common = x_info & o_info
    metres = round(float(osm["separation_m"]))
    trgm = max(0., min(1., float(osm.get("trigram_score") or 0)))
    wratio = fuzz.WRatio(x_norm, o_norm) / 100 if x_norm and o_norm else 0.
    token_set = fuzz.token_set_ratio(x_norm, o_norm) / 100 if x_norm and o_norm else 0.
    ratio = fuzz.ratio(x_norm, o_norm) / 100 if x_norm and o_norm else 0.
    score = round(0.35 * wratio + 0.30 * token_set + 0.20 * ratio + 0.15 * trgm, 4)
    exact_core = bool(x_norm and x_norm == o_norm)
    shared_ratio = len(x_words & o_words) / max(1, min(len(x_words), len(o_words)))

    decision, reason = 'unmatched', 'no_safe_identity_evidence'
    # We do not trust a misplaced record, even when names match.
    if metres > 110:
        reason = 'coordinates_too_far'
    else:
        x_raw, o_raw = set(re.sub(r"[^a-z0-9]+", " ", x_name.casefold()).split()), set(re.sub(r"[^a-z0-9]+", " ", o_name.casefold()).split())
        x_hostel = 'hostel' in x_raw or 'hostels' in x_raw
        o_hostel = osm.get('subcategory') == 'hostel' or 'hostel' in o_raw or 'hostels' in o_raw
        x_hotel = 'hotel' in x_raw or 'hotels' in x_raw
        o_hotel = (osm.get('subcategory') == 'hotel' or 'hotel' in o_raw or 'hotels' in o_raw)
        if (x_hotel and o_hostel and not x_hostel) or (x_hostel and o_hotel and not o_hostel):
            reason = 'hotel_hostel_type_conflict'
        elif not common:
            # e.g. Premier Inn Manchester North -> Premier Inn (no branch),
            # or Novotel Manchester Centre -> Ibis Manchester Centre (location alone).
            if exact_core and metres <= 18 and len(x_words) >= 3 and x_words == o_words:
                decision, reason = 'possible', 'chain_only_exact_needs_review'
            else:
                reason = 'only_chain_or_location_words_overlap'
        elif exact_core and metres <= 35:
            decision, reason = 'confirmed', 'exact_distinctive_name_nearby'
        elif len(common) >= 2 and shared_ratio >= 0.80 and score >= 0.82 and metres <= 35:
            decision, reason = 'confirmed', 'multiple_distinctive_words_nearby'
        elif len(common) >= 2 and shared_ratio >= 0.60 and score >= 0.66 and metres <= 65:
            decision, reason = 'possible', 'partial_distinctive_name_needs_review'
        elif len(common) == 1 and common == x_info == o_info and score >= 0.86 and metres <= 25:
            # Balmoral Hotel vs The Balmoral Hotel is already exact_core; this
            # rule also handles a single rare property word with near identity.
            decision, reason = 'possible', 'single_distinctive_word_needs_review'
        elif len(common) >= 1 and score >= 0.72 and metres <= 45:
            decision, reason = 'possible', 'weak_distinctive_name_needs_review'

    return Pair(hotel_key=hotel['key'], xotelo_name=x_name,
                osm_id=str(osm['osm_id']), osm_type=str(osm['osm_type']),
                osm_name=o_name, distance_m=metres,
                name_score=score, decision=decision,
                reason=reason, meaningful_shared=len(common))


from collections import defaultdict

def decide_claims(hotels, match_candidates: dict[str,list[Pair]], occupied: set[tuple[str,str]], reviewed: set[str]):
    """One-to-one allocation; ambiguity is possible, never silently forced."""
    candidates = {k:sorted([p for p in ps if p.decision!='unmatched'],
             key=lambda p:(p.decision=='confirmed',p.meaningful_shared,p.name_score,-p.distance_m),reverse=True)
             for k,ps in match_candidates.items()}
    # If multiple hotel keys are almost equally strong claimants for one OSM ID,
    # don't automatically confirm either key (e.g. duplicated provider hotel).
    claims=defaultdict(list)
    for key, choices in candidates.items():
        if key in reviewed or not choices or choices[0].decision!='confirmed': continue
        top=choices[0]
        claims[(top.osm_type,top.osm_id)].append(top)
    ambiguous_keys=set()
    for pairs in claims.values():
        for i,first in enumerate(pairs):
            for second in pairs[i+1:]:
                if abs(first.name_score-second.name_score)<=0.055 and abs(first.distance_m-second.distance_m)<=25:
                    ambiguous_keys.update((first.hotel_key,second.hotel_key))

    def sort_key(h):
        choices=candidates.get(h['key'],[])
        p=choices[0] if choices else None
        return (p is not None and p.decision=='confirmed',p.meaningful_shared if p else 0,p.name_score if p else 0,-p.distance_m if p else -1000,h['key'])

    rows=[]
    taken=set(occupied)
    for h in sorted(hotels,key=sort_key,reverse=True):
        key=h['key']
        if key in reviewed: continue
        options=candidates.get(key,[])
        top=options[0] if options else None
        if top is None:
            rows.append({'hotel_key':key,'xotelo_name':h['name'],'pair':None,'status':'unmatched','reason':'no_safe_candidate'})
            continue
        status=top.decision
        reason=top.reason
        osm_key=(top.osm_type,top.osm_id)
        if status=='confirmed' and key in ambiguous_keys:
            status='possible'; reason='multiple_xotelo_hotels_claim_same_osm'
        elif status=='confirmed' and osm_key in taken:
            status='possible'; reason='osm_already_confirmed_for_other_hotel'
        elif status=='confirmed' and len(options)>1:
            next_=options[1]
            if next_.decision=='confirmed' and abs(next_.name_score-top.name_score)<0.055 and abs(next_.distance_m-top.distance_m)<25:
                status='possible'; reason='multiple_osm_candidates_for_xotelo'
        if status=='confirmed': taken.add(osm_key)
        rows.append({'hotel_key':key,'xotelo_name':h['name'],'pair':top,'status':status,'reason':reason})
    return rows

