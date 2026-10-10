#!/usr/bin/env python3
"""Builds docs/protocol/oracle/seed.json: the history and curated steps the relay compiles in
and serves through GET /oracle/v1/feed (backend/cashweb/cashweb-registry/src/oracle/seed.rs).

Source: the JSON files in packages/price-feeds/src/historical (each made by its own script in
this directory). This script fetches nothing; it only reshapes those files into feed series:

    basket.json                       -> basket (verbatim, without "about")
    btc-mining-monthly.json           -> price/, difficulty/, blockReward/, marketCap/ for
                                         btc-mainnet and efficiency/sha256, one point a month
    curated-steps.json (if present)   -> efficiency/<algorithm> dated steps
    wholesale-electricity-daily.json  -> electricity/<region> daily points and the regions'
      (if present)                       labels (the aggregate is computed by the relay)

Regenerate:  python3 packages/price-feeds/scripts/build-oracle-seed.py
Check:       python3 packages/price-feeds/scripts/build-oracle-seed.py --check
             (exit 1 when seed.json is not what the sources give)
"""
import calendar
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
SOURCES = ROOT / "packages/price-feeds/src/historical"
OUTPUT = ROOT / "docs/protocol/oracle/seed.json"
JOULES_PER_KWH = 3.6e6


def unix(date):
    """00:00 UTC of YYYY-MM-DD, or of the first of the month for YYYY-MM."""
    parts = [int(part) for part in date.split("-")] + [1]
    return calendar.timegm((parts[0], parts[1], parts[2], 0, 0, 0))


def load(name):
    path = SOURCES / name
    return json.loads(path.read_text()) if path.exists() else None


def series(unit, source, as_of, points):
    points = sorted((time, value) for time, value in points if value is not None)
    return {"unit": unit, "source": source, "asOf": as_of, "points": [list(p) for p in points]}


def build():
    basket = load("basket.json")
    basket.pop("about", None)
    out = {}
    regions = []

    btc = load("btc-mining-monthly.json")
    retrieved = unix(btc["sources"]["retrieved"])
    months = [(unix(m["month"]), m) for m in btc["monthly"]]
    chain_source = "blockchain.com charts, monthly means"
    out["price/btc-mainnet"] = series(
        "USD", chain_source, retrieved, [(t, m.get("btcUsd")) for t, m in months])
    out["difficulty/btc-mainnet"] = series(
        "difficulty", chain_source, retrieved, [(t, m.get("difficulty")) for t, m in months])
    out["blockReward/btc-mainnet"] = series(
        "coins per block to the miner", "Bitcoin consensus subsidy schedule", retrieved,
        [(t, m.get("subsidyBtc")) for t, m in months])
    out["marketCap/btc-mainnet"] = series(
        "USD", "price x coins in existence (blockchain.com charts)", retrieved,
        [(t, m["btcUsd"] * m["supplyBtc"]) for t, m in months
         if m.get("btcUsd") and m.get("supplyBtc")])
    out["efficiency/sha256"] = series(
        "hashes/kWh", "Cambridge CBECI, monthly", retrieved,
        [(t, JOULES_PER_KWH / (m["joulesPerTerahash"] * 1e-12)) for t, m in months
         if m.get("joulesPerTerahash")])

    steps = load("curated-steps.json")
    for algorithm, entry in ((steps or {}).get("efficiency") or {}).items():
        rows = entry.get("steps") if isinstance(entry, dict) else None
        if not rows or algorithm == "sha256":
            continue
        out[f"efficiency/{algorithm}"] = series(
            "hashes/kWh", "most efficient hardware on sale, curated",
            max(unix(row["retrieved"]) for row in rows),
            [(unix(row["from"]), row["hashesPerSecond"] * JOULES_PER_KWH / row["watts"])
             for row in rows])

    power = load("wholesale-electricity-daily.json")
    for region, entry in ((power or {}).get("regions") or {}).items():
        out[f"electricity/{region}"] = series(
            "USD/kWh", entry["attribution"], unix(power["retrieved"]),
            [(unix(day), value) for day, value in entry["daily"]])
        regions.append(
            {"id": region, "label": entry["label"], "attribution": entry["attribution"]})

    # A series the sources have no value for is absent, not empty.
    out = {name: entry for name, entry in out.items() if entry["points"]}
    return {"basket": basket, "regions": regions, "series": dict(sorted(out.items()))}


def main():
    text = json.dumps(build(), separators=(",", ":")) + "\n"
    if "--check" in sys.argv:
        if not OUTPUT.exists() or OUTPUT.read_text() != text:
            sys.exit(f"{OUTPUT.relative_to(ROOT)} is out of date: run {sys.argv[0]}")
        return
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text)
    print(f"wrote {OUTPUT.relative_to(ROOT)}: {len(text)} bytes")


if __name__ == "__main__":
    main()
