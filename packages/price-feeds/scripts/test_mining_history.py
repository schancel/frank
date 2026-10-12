"""Run: python3 -I packages/price-feeds/scripts/test_mining_history.py"""
import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('history', pathlib.Path(__file__).with_name('build-mined-chains-history.py'))
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


class MiningHistoryTest(unittest.TestCase):
    def generate(self, fee=100, work=1000, omit=None):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            row = {'month': '2026-09', 'sum(generation)': 10000,
                   'sum(generation_usd)': 100, 'count()': 10,
                   'avg(difficulty)': 99999999, 'sum(difficulty)': work,
                   'sum(fee_total)': fee}
            if omit:
                del row[omit]
            (root / 'blockchair-ecash.json').write_text(json.dumps({'data': [
                row, {'month': '2026-10', 'sum(generation)': 100}]}))
            (root / 'blockchair-ecash-stats.json').write_text(json.dumps({'data': {'circulation': 100000}}))
            return history.blockchair_chain(directory, 'ecash', 100, '2020-12', '2026-10', None)[0]

    def test_observed_work_and_total_receipts_same_calendar_window(self):
        row = self.generate()
        seconds = 30 * 86400
        self.assertAlmostEqual(row[5], 1000 * 2 ** 32 / seconds, places=5)
        self.assertAlmostEqual(row[6], (10000 + 100) / 100 / seconds, places=12)
        # avg difficulty deliberately unrelated: actual accumulated work is the input.
        self.assertNotEqual(row[5], row[2])

    def test_observed_zero_fees_is_valid(self):
        self.assertGreater(self.generate(fee=0)[6], 0)

    def test_missing_fees_never_becomes_zero(self):
        with self.assertRaises(SystemExit):
            self.generate(omit='sum(fee_total)')

    def test_bad_fees_or_work_is_unavailable(self):
        for fee, work in [(-1, 1000), (0, 0)]:
            with self.assertRaises(SystemExit):
                self.generate(fee=fee, work=work)


if __name__ == '__main__':
    unittest.main()
