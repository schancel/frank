#!/usr/bin/env python3
"""Builds src/historical/us-electricity-gold.json from two public source files.

Nothing in the output is typed by hand, interpolated or estimated: every value is
copied from one of the two files below. A year or month a source does not cover is
left out.

Sources (download them first, no key needed):
  1. US EIA, Monthly Energy Review, Table 9.8 "Average Prices of Electricity to
     Ultimate Customers", series ESICUUS (industrial, cents per kWh, nominal):
       https://www.eia.gov/totalenergy/data/browser/csv.php?tbl=T09.08
     Rows with month 13 are the annual average.
  2. World Bank Commodity Price Data ("Pink Sheet"), annual prices, nominal US
     dollars, sheet "Annual Prices (Nominal)", column "Gold" ($/troy oz):
       https://thedocs.worldbank.org/en/doc/5d903e848db1d1b83e0ec8f744e55570-0350012021/related/CMO-Historical-Data-Annual.xlsx

Regenerate (from packages/price-feeds):
  python3 -I scripts/build-historical.py <T09.08.csv> <CMO-Historical-Data-Annual.xlsx> \
    > src/historical/us-electricity-gold.json
Check: yarn jest --runInBand historical
"""
import csv
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
SHEET = 'Annual Prices (Nominal)'


def eia_industrial(path):
    annual, monthly = {}, {}
    with open(path, newline='') as handle:
        for row in csv.DictReader(handle):
            if row['MSN'] != 'ESICUUS':
                continue
            try:
                value = float(row['Value'])
            except ValueError:
                continue  # "Not Available"
            year, month = row['YYYYMM'][:4], row['YYYYMM'][4:]
            if month == '13':
                annual[int(year)] = value
            else:
                monthly['%s-%s' % (year, month)] = value
    return annual, monthly


def pink_sheet_gold(path):
    book = zipfile.ZipFile(path)
    shared = [
        ''.join(t.text or '' for t in si.iter('{%s}t' % NS['m']))
        for si in ET.fromstring(book.read('xl/sharedStrings.xml')).findall('m:si', NS)
    ]
    sheets = [s.get('name') for s in ET.fromstring(book.read('xl/workbook.xml')).find('m:sheets', NS)]
    sheet_xml = book.read('xl/worksheets/sheet%d.xml' % (sheets.index(SHEET) + 1))
    rows = []
    for row in ET.fromstring(sheet_xml).iter('{%s}row' % NS['m']):
        cells = {}
        for cell in row.findall('m:c', NS):
            value = cell.find('m:v', NS)
            if value is None:
                continue
            column = re.match(r'[A-Z]+', cell.get('r')).group(0)
            cells[column] = shared[int(value.text)] if cell.get('t') == 's' else value.text
        rows.append(cells)
    edition = next(
        (c['A'] for c in rows if str(c.get('A', '')).startswith('Updated on')), ''
    )
    gold_column = next(
        column for cells in rows for column, text in cells.items() if text == 'Gold'
    )
    gold = {}
    for cells in rows:
        year = str(cells.get('A', ''))
        if re.fullmatch(r'(19|20)\d\d', year) and gold_column in cells:
            gold[int(year)] = round(float(cells[gold_column]), 2)
    return gold, edition


def main():
    annual_cents, monthly_cents = eia_industrial(sys.argv[1])
    gold, edition = pink_sheet_gold(sys.argv[2])
    annual = []
    for year in sorted(annual_cents):
        point = {'year': year, 'centsPerKwh': annual_cents[year]}
        if year in gold:
            point['goldUsd'] = gold[year]
        annual.append(point)
    json.dump(
        {
            'sources': {
                'centsPerKwh': 'US EIA Monthly Energy Review Table 9.8, series ESICUUS: average price of electricity to industrial customers, nominal cents per kWh',
                'goldUsd': 'World Bank Commodity Price Data (Pink Sheet), annual prices, nominal US dollars per troy ounce. %s' % edition,
            },
            'annual': annual,
            'monthlyCentsPerKwh': [
                {'month': month, 'centsPerKwh': monthly_cents[month]}
                for month in sorted(monthly_cents)
            ],
        },
        sys.stdout,
        indent=1,
    )
    sys.stdout.write('\n')


main()
