from stratus.enrich import parse_aircraft, parse_photo, parse_route, route_plausible

CDG = {"icao": "LFPG", "lat": 49.0097, "lon": 2.5479}
LHR = {"icao": "EGLL", "lat": 51.4706, "lon": -0.4619}
JFK = {"icao": "KJFK", "lat": 40.6398, "lon": -73.7789}


def route(o, d):
    return {"origin": o, "destination": d}


def test_plausible_when_on_the_great_circle():
    r = route(CDG, LHR)
    assert route_plausible(r, 50.2, 1.0)  # about midway
    assert route_plausible(route(CDG, JFK), 52.0, -30.0)  # North Atlantic great circle bows north


def test_implausible_when_far_off_track_or_beyond_the_ends():
    assert not route_plausible(route(CDG, LHR), 41.0, 2.5)  # Spain
    assert not route_plausible(route(CDG, JFK), 30.0, -30.0)
    assert not route_plausible(route(CDG, LHR), 55.0, -8.0)  # beyond the destination, roughly in line


def test_ground_plane_must_be_at_one_of_the_airports():
    r = route(CDG, LHR)
    assert route_plausible(r, 49.01, 2.55, gnd=True)
    assert route_plausible(r, 51.47, -0.46, gnd=True)
    assert not route_plausible(r, 48.0, 5.0, gnd=True)


def test_missing_airport_coordinates_are_not_plausible():
    assert not route_plausible(route({**CDG, "lat": None}, LHR), 50.0, 1.0)


def test_parse_adsbdb_aircraft_route_and_photo():
    a = parse_aircraft({"response": {"aircraft": {
        "type": "A320-214", "icao_type": "A320", "manufacturer": "Airbus", "registration": "D-AIZB",
        "registered_owner": "Lufthansa", "registered_owner_operator_flag_code": "DLH",
        "registered_owner_country_name": "Germany"}}})
    assert a["type"] == "A320" and a["type_name"] == "Airbus A320-214" and a["operator_icao"] == "DLH"
    assert parse_aircraft({"response": "unknown aircraft"}) is None

    ap = {"icao_code": "EDDM", "iata_code": "MUC", "name": "Munich", "municipality": "Munich",
          "country_name": "Germany", "latitude": 48.35, "longitude": 11.78}
    r = parse_route({"response": {"flightroute": {"callsign": "DLH4AB", "airline": {"name": "Lufthansa", "iata": "LH", "icao": "DLH"},
                                                  "origin": ap, "destination": {**ap, "icao_code": "LFPG"}}}})
    assert r["airline"] == "Lufthansa" and r["airline_iata"] == "LH" and r["airline_icao"] == "DLH" and r["origin"]["icao"] == "EDDM" and r["destination"]["lat"] == 48.35
    assert parse_route({"response": "unknown callsign"}) is None

    p = parse_photo({"photos": [{"thumbnail": {"src": "t"}, "thumbnail_large": {"src": "l"},
                                 "photographer": "Jane", "link": "https://www.planespotters.net/x"}]})
    assert p == {"thumb": "t", "large": "l", "photographer": "Jane", "link": "https://www.planespotters.net/x"}
    assert parse_photo({"photos": []}) is None
