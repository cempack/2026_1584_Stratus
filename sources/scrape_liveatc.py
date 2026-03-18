import os
import sys
import json
import time
import requests

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import server

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
OUTPUT_FILE = os.path.join(DATA_DIR, "liveatc_feeds.json")

def check_stream(url):
    try:
        response = requests.head(url, headers=server.LIVEATC_BROWSER_HEADERS, timeout=5)
        if response.status_code < 400:
            return True
        # fallback to GET if HEAD isn't allowed
        response = requests.get(url, headers=server.LIVEATC_BROWSER_HEADERS, timeout=5, stream=True)
        is_ok = response.status_code < 400
        response.close()
        return is_ok
    except Exception as e:
        print(f"Stream {url} failed: {e}")
        return False

def scrape():
    print("Scraping LiveATC feeds...")
    airports_by_icao = server.load_ourairports_metadata(force_refresh=True)

    # Let's collect streams from the playlist, which has a lot of good ones
    try:
        playlist_response = requests.get(server.ATC_COMMUNITY_PLAYLIST_URL, timeout=(8, 20))
        playlist_response.raise_for_status()
        streams_by_icao = server.parse_atc_playlist_streams(playlist_response.text)
    except Exception as e:
        print(f"Failed to fetch playlist: {e}")
        streams_by_icao = {}

    # add emergency streams
    streams_by_icao.update(server.emergency_atc_streams())

    # also try feed index? Feed index doesn't have direct stream URLs in it immediately,
    # except via parsing individual pages, which takes too long for ALL airports.
    # The current server logic parsed streams_by_icao from playlist, and fallback emergency.

    # We will build an airport list only for working streams
    final_airports = []

    total = len(streams_by_icao)
    print(f"Found {total} potential streams to check.")

    for icao, stream_info in streams_by_icao.items():
        stream_url = stream_info.get("stream_url")
        if not stream_url:
            continue

        print(f"Checking {icao} -> {stream_url}")
        if check_stream(stream_url):
            airport_meta = airports_by_icao.get(icao) or {}
            label = (stream_info.get("label") or icao).strip()
            lat = server.numeric_or_none(airport_meta.get("lat"))
            lng = server.numeric_or_none(airport_meta.get("lng"))

            final_airports.append({
                "icao": icao,
                "label": label,
                "name": airport_meta.get("name") or label or icao,
                "city": airport_meta.get("city") or "",
                "country": airport_meta.get("country") or "",
                "lat": lat,
                "lng": lng,
                "page_url": server.ATC_COMMUNITY_PLAYLIST_URL,
                "stream_url": stream_url,
                "feed_id": stream_info.get("feed_id") or "",
            })
            print(f"  -> Added {icao}")
        else:
            print(f"  -> {icao} stream is dead, skipping.")

    print(f"Done. Found {len(final_airports)} working streams.")

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUTPUT_FILE, "w") as f:
        json.dump({"airports": final_airports, "fetched_at": time.time()}, f, indent=2)

    print(f"Saved to {OUTPUT_FILE}")

if __name__ == "__main__":
    scrape()
