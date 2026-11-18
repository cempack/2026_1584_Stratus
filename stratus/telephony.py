"""Airline radio callsigns ("telephony"): DAL2775 is spoken "Delta 2775". Used to prime the subtitles with the traffic
actually around an airport, so Whisper writes the callsigns it hears instead of guessing words."""

from __future__ import annotations

import re

TELEPHONY = {
    "AAL": "American", "ACA": "Air Canada", "AFR": "Airfrance", "AAY": "Allegiant", "ANA": "All Nippon", "ASA": "Alaska",
    "AUA": "Austrian", "AZA": "Alitalia", "BAW": "Speedbird", "BEL": "Beeline", "CCA": "Air China", "CES": "China Eastern",
    "CPA": "Cathay", "CSN": "China Southern", "DAL": "Delta", "DLH": "Lufthansa", "EDV": "Endeavor", "EIN": "Shamrock",
    "EJA": "Execjet", "ENY": "Envoy", "ETD": "Etihad", "EVA": "Eva", "EWG": "Eurowings", "EZY": "Easy", "FDX": "FedEx",
    "FFT": "Frontier Flight", "FIN": "Finnair", "GJS": "Lindbergh", "IBE": "Iberia", "ICE": "Iceair", "JAL": "Japan Air",
    "JBU": "JetBlue", "JIA": "Blue Streak", "JZA": "Jazz", "KAL": "Korean Air", "KLM": "KLM", "LOT": "Lot",
    "MXY": "Moxy", "NKS": "Spirit Wings", "NAX": "Nor Shuttle", "QFA": "Qantas", "QTR": "Qatari", "RPA": "Brickyard",
    "RYR": "Ryanair", "SAS": "Scandinavian", "SBI": "Siberia", "SIA": "Singapore", "SKW": "Skywest", "SWA": "Southwest",
    "SWR": "Swiss", "TAP": "Air Portugal", "THY": "Turkish", "UAE": "Emirates", "UAL": "United", "UPS": "UPS",
    "VIR": "Virgin", "VOI": "Volaris", "VXP": "Avelo", "WJA": "Westjet", "WZZ": "Wizz Air", "AFL": "Aeroflot",
    "AMX": "Aeromexico", "AVA": "Avianca", "CMP": "Copa", "LAN": "Lan Chile", "TAM": "Tam", "GLO": "Gol",
    "AZU": "Azul", "PAL": "Philippine", "CEB": "Cebu", "VJC": "Vietjet", "HVN": "Viet Nam Airlines", "QXE": "Horizon",
    "ASH": "Air Shuttle", "PDT": "Piedmont", "CPZ": "Compass", "ROU": "Rouge", "TSC": "Air Transat",
}
_CS = re.compile(r"^([A-Z]{3})(\d{1,4}[A-Z]{0,2})$")


def spoken(callsign: str) -> str | None:
    """'DAL2775' -> 'Delta 2775'; registrations and unknown airlines are left as they are; None for nothing."""
    cs = (callsign or "").strip().upper()
    if not cs:
        return None
    m = _CS.match(cs)
    if m and m.group(1) in TELEPHONY:
        return f"{TELEPHONY[m.group(1)]} {m.group(2)}"
    return cs
