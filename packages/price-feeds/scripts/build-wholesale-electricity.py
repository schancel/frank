#!/usr/bin/env python3
"""Builds src/historical/wholesale-electricity-daily.json: daily wholesale day-ahead
electricity prices in US dollars per kWh, per region.

This file is seed data. The relay is to serve the `electricity/<region>` series itself
(docs/protocol/oracle/README.md); until it does, the app's temporary direct adapter reads
this file. Nothing is typed by hand or interpolated: a day a source does not cover is
absent from that region. How the regions are combined into AVU_spot is the client's rule
(region means over the window, weighted equally), not something stored here.

Sources (download them into one directory first; no key needed):

  de-lu: Germany-Luxembourg bidding zone, day-ahead auction, EUR/MWh, hourly (quarter-hourly
    from October 2025). Fraunhofer ISE Energy-Charts API, data from Bundesnetzagentur |
    SMARD.de, licence CC BY 4.0. One request per calendar year, saved as
    energy-charts-DE-LU-<year>.json:
      https://api.energy-charts.info/price?bzn=DE-LU&start=<year>-01-01&end=<year>-12-31
    The API answers 429 after a few requests: leave a minute or more between them. It is
    not readable from a browser (its Access-Control-Allow-Origin is its own origin).
    A day's price is the mean of its intervals (UTC day); a day with fewer than 23 hours
    of data is left out. Converted to dollars at the ECB euro reference rate of that day,
    or of the latest earlier day that has one (weekends and holidays):
      https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2018-09-01&format=csvdata
    saved as ecb-usd-per-eur.csv.

  us-pjm-west: PJM Western Hub, next-day physical on-peak power traded on the
    Intercontinental Exchange, volume-weighted average price in $/MWh, republished by the
    US EIA ("Wholesale Electricity and Natural Gas Market Data", updated every two weeks):
      https://www.eia.gov/electricity/wholesale/xls/archive/ice_electric-<year>final.xlsx
      https://www.eia.gov/electricity/wholesale/xls/ice_electric-<current year>.xlsx
    saved under their own names. Price hub "PJM WH Real Time Peak"; the price of each
    delivery day from "Delivery start date" to "Delivery end date". On-peak hours only
    (weekdays, daytime): it is above the all-hours price, and weekends have no value.
    EIA republishes these with ICE's permission; check the terms before redistributing.

Regenerate (from packages/price-feeds):
  python3 -I scripts/build-wholesale-electricity.py <directory of the files> \
    <YYYY-MM-DD they were downloaded> > src/historical/wholesale-electricity-daily.json
Check: npx jest --runInBand historical
"""
import csv
import datetime
import glob
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
PJM_HUB = 'PJM WH Real Time Peak'
EXCEL_EPOCH = datetime.date(1899, 12, 30)
UTC = datetime.timezone.utc


def significant(value, digits=5):
    return float('%.*g' % (digits, value))


def ecb_rates(path):
    rates = {}
    with open(path, newline='') as handle:
        for row in csv.DictReader(handle):
            if row['OBS_VALUE']:
                rates[datetime.date.fromisoformat(row['TIME_PERIOD'])] = float(row['OBS_VALUE'])
    return rates


def rate_on(rates, ordered, day):
    """The reference rate of `day`, or of the latest earlier day that has one."""
    low, high = 0, len(ordered) - 1
    if not ordered or day < ordered[0]:
        return None
    while low < high:
        middle = (low + high + 1) // 2
        if ordered[middle] <= day:
            low = middle
        else:
            high = middle - 1
    # A rate more than a week old is not "that day's rate".
    if (day - ordered[low]).days > 7:
        return None
    return rates[ordered[low]]


def de_lu(directory, rates):
    seconds_by_day = {}
    value_by_day = {}
    paths = sorted(glob.glob(os.path.join(directory, 'energy-charts-DE-LU-*.json')))
    for path in paths:
        with open(path) as handle:
            year = json.load(handle)
        if year.get('unit') != 'EUR / MWh':
            sys.exit('%s: unexpected unit %r' % (path, year.get('unit')))
        times, prices = year['unix_seconds'], year['price']
        for index, (time, price) in enumerate(zip(times, prices)):
            if price is None:
                continue
            length = times[index + 1] - time if index + 1 < len(times) else times[index] - times[index - 1]
            if length not in (900, 3600):
                continue
            day = datetime.datetime.fromtimestamp(time, UTC).date()
            seconds_by_day[day] = seconds_by_day.get(day, 0) + length
            value_by_day[day] = value_by_day.get(day, 0.0) + price * length
    ordered = sorted(rates)
    daily = {}
    for day in sorted(seconds_by_day):
        if seconds_by_day[day] < 23 * 3600:
            continue
        rate = rate_on(rates, ordered, day)
        if rate is None:
            continue
        eur_per_mwh = value_by_day[day] / seconds_by_day[day]
        daily[day] = eur_per_mwh * rate / 1000.0
    return daily, [os.path.basename(p) for p in paths]


def workbook_rows(path):
    book = zipfile.ZipFile(path)
    shared = [
        ''.join(t.text or '' for t in si.iter('{%s}t' % NS['m']))
        for si in ET.fromstring(book.read('xl/sharedStrings.xml')).findall('m:si', NS)
    ]
    for row in ET.fromstring(book.read('xl/worksheets/sheet1.xml')).iter('{%s}row' % NS['m']):
        cells = {}
        for cell in row.findall('m:c', NS):
            value = cell.find('m:v', NS)
            if value is None:
                continue
            column = re.match(r'[A-Z]+', cell.get('r')).group(0)
            cells[column] = shared[int(value.text)] if cell.get('t') == 's' else value.text
        yield cells


def pjm_west(directory):
    daily = {}
    paths = sorted(glob.glob(os.path.join(directory, 'ice_electric-*.xlsx')))
    for path in paths:
        header = None
        for cells in workbook_rows(path):
            if header is None:
                if cells.get('A') == 'Price hub':
                    header = {' '.join(text.split()): column for column, text in cells.items()}
                continue
            if cells.get(header['Price hub']) != PJM_HUB:
                continue
            try:
                start = EXCEL_EPOCH + datetime.timedelta(days=int(float(cells[header['Delivery start date']])))
                end = EXCEL_EPOCH + datetime.timedelta(days=int(float(cells[header['Delivery end date']])))
                price = float(cells[header['Wtd avg price $/MWh']])
            except (KeyError, ValueError):
                continue
            day = start
            while day <= end and (day - start).days < 7:
                daily[day] = price / 1000.0
                day += datetime.timedelta(days=1)
    return daily, [os.path.basename(p) for p in paths]


def points(daily):
    return [[day.isoformat(), significant(daily[day])] for day in sorted(daily)]


def main():
    directory, retrieved = sys.argv[1], sys.argv[2]
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', retrieved):
        sys.exit('second argument: the date the source files were downloaded, YYYY-MM-DD')
    last_day = datetime.date.fromisoformat(retrieved) - datetime.timedelta(days=1)
    rates = ecb_rates(os.path.join(directory, 'ecb-usd-per-eur.csv'))
    de, de_files = de_lu(directory, rates)
    us, us_files = pjm_west(directory)
    de = {day: value for day, value in de.items() if day <= last_day}
    us = {day: value for day, value in us.items() if day <= last_day}
    json.dump(
        {
            'unit': 'USD per kWh; one value per UTC day',
            'retrieved': retrieved,
            'regions': {
                'de-lu': {
                    'label': 'Germany-Luxembourg day-ahead auction, all hours',
                    'attribution': 'Bundesnetzagentur | SMARD.de via Fraunhofer ISE Energy-Charts, CC BY 4.0; euro reference rates: European Central Bank',
                    'sourceUrl': 'https://api.energy-charts.info/price?bzn=DE-LU',
                    'currencyUrl': 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A',
                    'files': de_files,
                    'daily': points(de),
                },
                'us-pjm-west': {
                    'label': 'PJM Western Hub next-day on-peak (ICE)',
                    'attribution': 'Intercontinental Exchange, republished by the US Energy Information Administration',
                    'sourceUrl': 'https://www.eia.gov/electricity/wholesale/',
                    'files': us_files,
                    'daily': points(us),
                },
            },
        },
        sys.stdout,
        separators=(',', ':'),
    )
    sys.stdout.write('\n')


main()
