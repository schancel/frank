#!/usr/bin/env python3
"""Builds src/historical/btc-mining-monthly.json: the monthly inputs of AVU_hash for Bitcoin.

AVU_hash for a mined coin is the inverse of the dollars one kWh of mining earns:
  price [$/coin] x subsidy [coins/block] / hashes per block x efficiency [hashes/kWh]
This file holds each input per calendar month, so the app can apply that formula itself
(packages/wallet/oracle/energy-basket.ts). Nothing is typed by hand, interpolated or
estimated here: every figure is the plain mean of the daily values a source published
for that month. A month a source does not fully cover is left out.

Sources (download them first, no key needed):
  1. blockchain.com charts API, daily, unsampled:
       https://api.blockchain.info/charts/market-price?timespan=all&sampled=false&format=json
       https://api.blockchain.info/charts/difficulty?timespan=all&sampled=false&format=json
       https://api.blockchain.info/charts/hash-rate?timespan=all&sampled=false&format=json
       https://api.blockchain.info/charts/total-bitcoins?timespan=all&sampled=false&format=json
  2. Cambridge Bitcoin Electricity Consumption Index (CBECI), "Download data" CSV, daily
     estimated network power demand in GW (lower bound, best guess, upper bound):
       https://ccaf.io/cbeci/api/v1.4.0/download/data?price=0.05

What is derived, and how:
  - supplyBtc: the mean of the total-bitcoins chart over the month (coins in existence;
    times the price it is the market capitalisation the basket is weighted by).
  - subsidyBtc: the consensus rule GetBlockSubsidy (Bitcoin Core src/validation.cpp:
    50 BTC, halved every nSubsidyHalvingInterval = 210,000 blocks), applied to the supply
    the total-bitcoins chart reports. The supply at which each halving happens follows
    from the rule alone; the chart says when that supply was reached.
  - joulesPerTerahash: CBECI's best-guess power demand divided by the network hashrate,
    i.e. the electricity the mining fleet drew per terahash, cooling included. This is
    the one input that is somebody's estimate and not a reading of the chain: CBECI
    models which hardware is running, and its best guess assumes miners pay 0.05 USD/kWh
    when deciding which machines are still profitable. The lower and upper bounds are
    bundled beside it.

Regenerate (from packages/price-feeds):
  python3 -I scripts/build-btc-mining-history.py <market-price.json> <difficulty.json> \
    <hash-rate.json> <total-bitcoins.json> <cbeci-data.csv> \
    <YYYY-MM-DD the files were downloaded> > src/historical/btc-mining-monthly.json
Check: yarn jest --runInBand historical
"""
import calendar
import csv
import datetime
import json
import re
import sys

CHARTS = 'https://api.blockchain.info/charts/%s?timespan=all&sampled=false&format=json'
CBECI_URL = 'https://ccaf.io/cbeci/api/v1.4.0/download/data?price=0.05'

# Bitcoin Core consensus: GetBlockSubsidy in src/validation.cpp and
# nSubsidyHalvingInterval in src/kernel/chainparams.cpp.
INITIAL_SUBSIDY_BTC = 50.0
HALVING_INTERVAL_BLOCKS = 210_000


def subsidy_at_supply(supply_btc):
    """The subsidy of the next block once `supply_btc` coins exist."""
    subsidy = INITIAL_SUBSIDY_BTC
    era_end = HALVING_INTERVAL_BLOCKS * subsidy
    while supply_btc >= era_end:
        subsidy /= 2
        era_end += HALVING_INTERVAL_BLOCKS * subsidy
    return subsidy


def day_of(timestamp):
    return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).date()


def chart_by_day(path):
    """The last value a chart reports for each UTC day."""
    with open(path) as handle:
        chart = json.load(handle)
    if chart.get('status') != 'ok':
        sys.exit('%s: not a blockchain.com chart' % path)
    days = {}
    for point in sorted(chart['values'], key=lambda p: p['x']):
        days[day_of(point['x'])] = float(point['y'])
    return days, chart['unit']


def cbeci_by_day(path):
    days = {}
    with open(path, newline='') as handle:
        rows = csv.reader(handle)
        assumption = next(rows)[0]
        header = next(rows)
        columns = {name: index for index, name in enumerate(header)}
        for row in rows:
            days[day_of(int(row[columns['Timestamp']]))] = {
                'min': float(row[columns['power MIN, GW']]),
                'guess': float(row[columns['power GUESS, GW']]),
                'max': float(row[columns['power MAX, GW']]),
            }
    return days, assumption


def mean(values):
    return sum(values) / len(values)


def significant(value, digits=6):
    return float('%.*g' % (digits, value))


def main():
    price, price_unit = chart_by_day(sys.argv[1])
    difficulty, _ = chart_by_day(sys.argv[2])
    hashrate, hashrate_unit = chart_by_day(sys.argv[3])
    supply, _ = chart_by_day(sys.argv[4])
    power, assumption = cbeci_by_day(sys.argv[5])
    retrieved = sys.argv[6]
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', retrieved):
        sys.exit('sixth argument: the date the source files were downloaded, YYYY-MM-DD')
    if price_unit != 'USD' or hashrate_unit != 'Hash Rate TH/s':
        sys.exit('unexpected chart units: %s, %s' % (price_unit, hashrate_unit))

    months = sorted({(d.year, d.month) for d in power})
    monthly = []
    for year, month in months:
        days = [
            datetime.date(year, month, day)
            for day in range(1, calendar.monthrange(year, month)[1] + 1)
        ]
        # Only months every source covers on every day, with a market price on each.
        if not all(
            d in power and d in difficulty and d in hashrate and d in supply
            and price.get(d, 0) > 0 and hashrate[d] > 0
            for d in days
        ):
            continue
        terahash_per_second = mean([hashrate[d] for d in days])

        def joules_per_terahash(bound):
            watts = mean([power[d][bound] for d in days]) * 1e9
            return significant(watts / terahash_per_second, 5)

        monthly.append({
            'month': '%04d-%02d' % (year, month),
            'btcUsd': significant(mean([price[d] for d in days])),
            'difficulty': significant(mean([difficulty[d] for d in days]), 9),
            'subsidyBtc': significant(mean([subsidy_at_supply(supply[d]) for d in days])),
            'supplyBtc': significant(mean([supply[d] for d in days]), 9),
            'joulesPerTerahash': joules_per_terahash('guess'),
            'joulesPerTerahashLow': joules_per_terahash('min'),
            'joulesPerTerahashHigh': joules_per_terahash('max'),
        })

    json.dump(
        {
            'sources': {
                'chain': 'blockchain.com charts API, daily values: market-price (USD), difficulty, hash-rate (TH/s), total-bitcoins. Each monthly figure is the mean of the days in that month.',
                'chainUrls': [CHARTS % name for name in ('market-price', 'difficulty', 'hash-rate', 'total-bitcoins')],
                'subsidy': 'Bitcoin consensus rule GetBlockSubsidy (50 BTC halved every 210,000 blocks), applied to the supply in the total-bitcoins chart.',
                'efficiency': 'Cambridge Bitcoin Electricity Consumption Index (CBECI), daily estimated network power demand, divided by the hash-rate chart: joules drawn per terahash. An estimate of the hardware in use, not a chain reading. %s.' % assumption.strip(),
                'efficiencyUrl': CBECI_URL,
                'retrieved': retrieved,
            },
            'monthly': monthly,
        },
        sys.stdout,
        indent=1,
    )
    sys.stdout.write('\n')


main()
