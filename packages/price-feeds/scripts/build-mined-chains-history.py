#!/usr/bin/env python3
"""Builds src/historical/mined-chains-monthly.json: the monthly inputs of AVU_hash for the
basket's chains other than Bitcoin (Bitcoin has its own file, btc-mining-monthly.json).

For each chain and calendar month: price (USD per coin), difficulty, subsidy (coins minted
per block, the whole subsidy before any consensus split) and coins in existence. Nothing is
typed by hand or interpolated. A month a source does not cover completely is left out, and
the month the files were downloaded in is never included (it is not over).

Sources (download them into one directory first; no key needed):

  Litecoin, Dogecoin, Bitcoin Cash, eCash: Blockchair's block aggregates, one row a month:
      https://api.blockchair.com/<chain>/blocks?a=month,count(),avg(difficulty),sum(generation),sum(generation_usd)&limit=100&offset=<0,100,...>
    saved as blockchair-<chain>.json = {"url": ..., "data": [all pages' rows]}, and the
    chain's coins in existence on the download day from
      https://api.blockchair.com/<chain>/stats   (field "circulation")
    saved as blockchair-<chain>-stats.json.
    EACH AGGREGATE REQUEST COSTS 42 OF BLOCKCHAIR'S FREE REQUEST POINTS. Five within two
    minutes got the downloading IP blacklisted for several minutes (2026-10-10). Leave at
    least seven minutes between aggregate requests.
      - price      = Litecoin, Dogecoin, Bitcoin Cash: Kraken weekly candles,
                     volume-weighted average price column, the mean of the weeks starting
                     in the month:
                       https://api.kraken.com/0/public/OHLC?pair=<LTCUSD|XDGUSD|BCHUSD>&interval=10080
                     saved as kraken-<pair>.json. Blockchair's own dollar figures are not
                     used for these: for Litecoin they disagree with Kraken by more than
                     15% in 74 of the months before 2020 (0.01 USD throughout 2013-14).
                     eCash: Kraken does not list it, so its price is Blockchair's
                     sum(generation_usd) / sum(generation); nothing here cross-checks it.
      - difficulty = avg(difficulty) over the month's blocks.
      - subsidy    = sum(generation) / count().
      - coins      = the "circulation" on the download day less everything minted after the
                     end of the month (the later rows of the same file).
    A chain is included only if both of its files are in the directory.

  Monero: Blockchair has no aggregates for it.
      - difficulty: block headers sampled every 5,000th block (about weekly) from the
        RandomX activation height 1978433, read with get_block_header_by_height from a
        public node, saved as monero-headers.json =
        {"node": ..., "headers": [{"height","timestamp","difficulty"}, ...]}. A month's
        difficulty is the mean of the samples in it; a month with fewer than three is
        left out.
      - subsidy and coins: the consensus rule get_block_reward
        (monero-project/monero src/cryptonote_basic/cryptonote_basic_impl.cpp, constants in
        src/cryptonote_config.h): (2^64 - 1 - coins already generated) >> 20 atomic units
        per one-minute block before height 1009827, >> 19 per two-minute block from it,
        never less than 0.6 XMR from then on (the tail emission). The block-size penalty is
        ignored; the rule's total at height 3,781,123 is 18,817,137.66 XMR against
        Blockchair's 18,815,849.49 (0.007% apart, 2026-10-10). Values are those at the
        sampled heights, averaged like the difficulty.
      - price: Kraken weekly candles, volume-weighted average price column:
          https://api.kraken.com/0/public/OHLC?pair=XMRUSD&interval=10080
        saved as kraken-XMRUSD.json. A month's price is the mean of the weeks starting in
        it.

Regenerate (from packages/price-feeds):
  python3 -I scripts/build-mined-chains-history.py <directory of the files> \
    <YYYY-MM-DD they were downloaded> > src/historical/mined-chains-monthly.json
Check: npx jest --runInBand historical
"""
import datetime
import json
import os
import re
import sys

BLOCKCHAIR = 'https://api.blockchair.com/%s/blocks?a=month,count(),avg(difficulty),sum(generation),sum(generation_usd)'
# Feed chain id, Blockchair name, base units per coin, first month used and why.
BLOCKCHAIR_CHAINS = [
    ('ltc-mainnet', 'litecoin', 1e8, '2013-11', 'first full month of Kraken LTCUSD candles', 'LTCUSD'),
    ('doge-mainnet', 'dogecoin', 1e8, '2020-01', 'first full month of Kraken XDGUSD candles', 'XDGUSD'),
    ('bch-mainnet', 'bitcoin-cash', 1e8, '2017-09', 'first full month after the chain split of 1 August 2017', 'BCHUSD'),
    ('xec-mainnet', 'ecash', 1e2, '2020-12', 'first full month after the chain split of 15 November 2020', None),
]
MONERO_RANDOMX_HEIGHT = 1978433
MONERO_V2_HEIGHT = 1009827
MONERO_MONEY_SUPPLY = 2 ** 64 - 1
MONERO_TAIL_ATOMIC = 600_000_000_000
MONERO_ATOMIC = 1e12


def significant(value, digits=7):
    return float('%.*g' % (digits, value))


def month_of(timestamp):
    return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y-%m')


def kraken_monthly(directory, pair):
    with open(os.path.join(directory, 'kraken-%s.json' % pair)) as handle:
        kraken = json.load(handle)
    if kraken.get('error'):
        sys.exit('kraken-%s.json: %s' % (pair, kraken['error']))
    candles = next(v for k, v in kraken['result'].items() if k != 'last')
    weeks = {}
    for candle in candles:
        vwap = float(candle[5])
        if vwap > 0:
            weeks.setdefault(month_of(int(candle[0])), []).append(vwap)
    return {month: sum(values) / len(values) for month, values in weeks.items()}


def blockchair_chain(directory, name, unit, first_month, download_month, pair):
    rows_path = os.path.join(directory, 'blockchair-%s.json' % name)
    stats_path = os.path.join(directory, 'blockchair-%s-stats.json' % name)
    if not (os.path.exists(rows_path) and os.path.exists(stats_path)):
        return None
    with open(rows_path) as handle:
        rows = json.load(handle)['data']
    with open(stats_path) as handle:
        circulation = float(json.load(handle)['data']['circulation'])
    prices = kraken_monthly(directory, pair) if pair else None
    rows.sort(key=lambda row: row['month'])
    if rows[-1]['month'] != download_month:
        sys.exit('%s: the last row is not the download month' % name)
    monthly = []
    minted_after = 0.0
    for row in reversed(rows):
        if row['month'] != download_month and row['month'] >= first_month:
            generation = float(row['sum(generation)'])
            usd = float(row['sum(generation_usd)'])
            blocks = float(row['count()'])
            price = prices.get(row['month'], 0) if prices else (usd / (generation / unit) if generation > 0 else 0)
            if generation > 0 and price > 0 and blocks > 0:
                monthly.append([
                    row['month'],
                    significant(price),
                    significant(float(row['avg(difficulty)']), 9),
                    significant(generation / unit / blocks),
                    significant((circulation - minted_after) / unit, 9),
                ])
        minted_after += float(row['sum(generation)'])
    monthly.reverse()
    return monthly


def monero_emission(heights):
    """Rule-derived block reward and coins generated before each of `heights`."""
    wanted = set(heights)
    generated = 0
    result = {}
    for height in range(max(heights) + 1):
        shift = 20 if height < MONERO_V2_HEIGHT else 19
        reward = (MONERO_MONEY_SUPPLY - generated) >> shift
        if height >= MONERO_V2_HEIGHT and reward < MONERO_TAIL_ATOMIC:
            reward = MONERO_TAIL_ATOMIC
        if height in wanted:
            result[height] = (reward / MONERO_ATOMIC, generated / MONERO_ATOMIC)
        generated += reward
    return result


def monero(directory, download_month):
    headers_path = os.path.join(directory, 'monero-headers.json')
    kraken_path = os.path.join(directory, 'kraken-XMRUSD.json')
    if not (os.path.exists(headers_path) and os.path.exists(kraken_path)):
        return None, None
    with open(headers_path) as handle:
        sampled = json.load(handle)
    prices = kraken_monthly(directory, 'XMRUSD')
    headers = [h for h in sampled['headers'] if h['height'] >= MONERO_RANDOMX_HEIGHT]
    emission = monero_emission([h['height'] for h in headers])
    months = {}
    for header in headers:
        months.setdefault(month_of(header['timestamp']), []).append(header)
    monthly = []
    for month in sorted(months):
        samples = months[month]
        if month == download_month or len(samples) < 3 or month not in prices:
            continue
        mean = lambda values: sum(values) / len(values)
        monthly.append([
            month,
            significant(prices[month]),
            significant(mean([float(h['difficulty']) for h in samples]), 9),
            significant(mean([emission[h['height']][0] for h in samples])),
            significant(mean([emission[h['height']][1] for h in samples]), 9),
        ])
    return monthly, sampled.get('node', '')


def main():
    directory, retrieved = sys.argv[1], sys.argv[2]
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', retrieved):
        sys.exit('second argument: the date the source files were downloaded, YYYY-MM-DD')
    download_month = retrieved[:7]
    chains = {}
    for chain_id, name, unit, first_month, why, pair in BLOCKCHAIR_CHAINS:
        monthly = blockchair_chain(directory, name, unit, first_month, download_month, pair)
        if monthly is None:
            continue
        chains[chain_id] = {
            'source': 'Difficulty, subsidy and coins: Blockchair block aggregates by month (coins in existence from Blockchair /stats on the retrieval date less later issuance). Price: %s.' % ('Kraken %s weekly candles (volume-weighted average), monthly mean' % pair if pair else "Blockchair's dollar value of the coins minted in the month divided by the coins minted"),
            'sourceUrl': BLOCKCHAIR % name,
            'firstMonth': '%s: %s' % (first_month, why),
            'monthly': monthly,
        }
    monthly, node = monero(directory, download_month)
    if monthly is not None:
        chains['xmr-mainnet'] = {
            'source': 'Difficulty: every 5,000th block header from a public Monero node (%s), monthly mean of the samples. Subsidy and coins: consensus rule get_block_reward. Price: Kraken XMRUSD weekly candles (volume-weighted average), monthly mean.' % node,
            'sourceUrl': 'https://api.kraken.com/0/public/OHLC?pair=XMRUSD&interval=10080',
            'firstMonth': '2019-12: first full month after RandomX activated (block 1978433, 30 November 2019)',
            'monthly': monthly,
        }
    json.dump(
        {
            'columns': ['month', 'priceUsd', 'difficulty', 'subsidyCoinsPerBlock', 'circulatingCoins'],
            'retrieved': retrieved,
            'chains': chains,
        },
        sys.stdout,
        indent=None,
        separators=(',', ':'),
    )
    sys.stdout.write('\n')


main()
