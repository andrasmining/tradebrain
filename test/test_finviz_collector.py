import copy
import importlib.util
import json
import math
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COLLECTOR_PATH = ROOT / "scripts" / "collect_finviz.py"
CONFIG_PATH = ROOT / "config" / "finviz.json"
RAW_FIXTURE_PATH = ROOT / "test" / "fixtures" / "finviz" / "raw-success.json"
FUTURES_HTML_PATH = ROOT / "test" / "fixtures" / "finviz" / "futures-current.html"

SPEC = importlib.util.spec_from_file_location("tradebrain_collect_finviz", COLLECTOR_PATH)
collector = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(collector)


class FinvizCollectorTests(unittest.TestCase):
    def setUp(self):
        self.config = collector.load_config(CONFIG_PATH)
        self.raw = json.loads(RAW_FIXTURE_PATH.read_text(encoding="utf-8"))
        self.now = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)

    def build(self, raw=None, failures=None):
        return collector.build_context(
            self.config,
            self.raw if raw is None else raw,
            failures=failures,
            generated_at=self.now,
        )

    def test_fully_successful_collection_normalizes_all_sections(self):
        context = self.build()

        self.assertEqual(context["collectionStatus"], "ok")
        self.assertEqual(context["warnings"], [])
        self.assertEqual(context["calendar"]["events"][0]["rawDateTime"], "2026-01-15T08:30:00")
        self.assertEqual(context["calendar"]["events"][0]["rawImpact"], "3")
        self.assertEqual(context["calendar"]["timezoneStatus"], "unverified")
        self.assertEqual(context["breadth"]["sectors"][0]["changePct"], 1.25)
        self.assertEqual(context["breadth"]["performanceBasis"], "latest-session")
        self.assertFalse(context["breadth"]["realTimePricePath"])
        self.assertEqual(len(context["breadth"]["industries"]), 4)
        self.assertEqual(context["megacaps"]["items"][0]["symbol"], "AAPL")
        self.assertEqual(context["megacaps"]["availableCount"], 8)
        self.assertEqual(context["megacaps"]["positiveCount"], 4)
        self.assertEqual(context["megacaps"]["negativeCount"], 3)
        self.assertEqual(context["megacaps"]["unchangedCount"], 1)
        self.assertEqual(context["megacaps"]["positivePct"], 50.0)
        self.assertEqual(context["megacaps"]["meanChangePct"], 0.25)
        self.assertEqual(context["megacaps"]["medianChangePct"], 0.5)
        self.assertEqual(context["semiconductors"]["medianChangePct"], 1.5)
        self.assertTrue(context["futures"]["delayedContextOnly"])
        self.assertEqual(context["futures"]["items"][0]["changePct"], -0.15)
        self.assertEqual(context["earnings"]["items"][0]["rawTimingCode"], "a")
        self.assertTrue(context["news"]["discoveryOnly"])

    def test_partial_section_failure_preserves_surviving_data(self):
        raw = copy.deepcopy(self.raw)
        del raw["futures"]
        context = self.build(raw, {"futures": ValueError("parser changed")})

        self.assertEqual(context["collectionStatus"], "partial")
        self.assertFalse(context["futures"]["available"])
        self.assertEqual(context["futures"]["items"], [])
        self.assertTrue(context["calendar"]["available"])
        self.assertEqual(context["megacaps"]["availableCount"], 8)
        self.assertTrue(any("futures unavailable" in warning for warning in context["warnings"]))
        self.assertTrue(collector.has_meaningful_data(context))

    def test_missing_and_malformed_tickers_are_not_fabricated(self):
        basket, dropped = collector.normalize_basket(
            [
                {"Ticker": "AAAPL", "Change %": "1.00%"},
                {"Ticker": "MMSFT", "Change %": "not-a-percent"},
                {"Ticker": "XNVDA", "Change %": "5.00%"},
                {"Ticker": None, "Change %": "2.00%"},
            ],
            ["AAPL", "MSFT", "NVDA"],
        )

        self.assertEqual([item["symbol"] for item in basket["items"]], ["AAPL"])
        self.assertEqual(basket["missingSymbols"], ["MSFT", "NVDA"])
        self.assertEqual(basket["coverageStatus"], "partial")
        self.assertEqual(dropped, 1)

    def test_basket_aggregation_handles_even_median_and_zero_available(self):
        basket, _ = collector.normalize_basket(
            [
                {"Ticker": "AAPL", "Change": "4%"},
                {"Ticker": "MSFT", "Change": "-2%"},
                {"Ticker": "NVDA", "Change": "0%"},
                {"Ticker": "AMZN", "Change": "2%"},
            ],
            ["AAPL", "MSFT", "NVDA", "AMZN"],
        )
        self.assertEqual(basket["meanChangePct"], 1.0)
        self.assertEqual(basket["medianChangePct"], 1.0)
        self.assertEqual(basket["positivePct"], 50.0)

        empty, _ = collector.normalize_basket([], ["AAPL", "MSFT"])
        self.assertFalse(empty["available"])
        self.assertEqual(empty["availableCount"], 0)
        self.assertEqual(empty["missingSymbols"], ["AAPL", "MSFT"])
        for field in ("positivePct", "meanChangePct", "medianChangePct", "dispersionPct"):
            self.assertIsNone(empty[field])

    def test_earnings_excludes_past_and_distant_dates_and_handles_year_rollover(self):
        items, dropped = collector.normalize_earnings(
            [
                {"Ticker": "AAPL", "Earnings": "Jan 10/a"},
                {"Ticker": "MSFT", "Earnings": "Jan 15/b"},
                {"Ticker": "NVDA", "Earnings": "May 20/a"},
                {"Ticker": "AMZN", "Earnings": "not-a-date"},
            ],
            ["AAPL", "MSFT", "NVDA", "AMZN"],
            date(2026, 1, 15),
            120,
        )
        self.assertEqual(items, [{
            "symbol": "MSFT",
            "rawDateTime": "Jan 15/b",
            "date": "2026-01-15",
            "dateResolution": "year-inferred",
            "daysUntil": 0,
            "rawTimingCode": "b",
        }])
        self.assertEqual(dropped, 1)

        rollover, _ = collector.normalize_earnings(
            [{"Ticker": "AVGO", "Earnings": "Jan 05/a"}],
            ["AVGO"],
            date(2026, 12, 30),
            120,
        )
        self.assertEqual([item["symbol"] for item in rollover], ["AVGO"])
        self.assertEqual(rollover[0]["date"], "2027-01-05")
        self.assertEqual(rollover[0]["daysUntil"], 6)

    def test_missing_earnings_column_does_not_discard_valid_basket_performance(self):
        raw = copy.deepcopy(self.raw)
        for row in raw["screen"]:
            del row["Earnings"]
        context = self.build(raw)

        self.assertEqual(context["collectionStatus"], "partial")
        self.assertEqual(context["megacaps"]["coverageStatus"], "complete")
        self.assertEqual(context["semiconductors"]["coverageStatus"], "complete")
        self.assertFalse(context["earnings"]["available"])
        self.assertEqual(context["earnings"]["availabilityStatus"], "unavailable")
        self.assertTrue(any("expected Earnings column" in warning for warning in context["warnings"]))

    def test_empty_calendar_and_news_do_not_claim_availability(self):
        raw = copy.deepcopy(self.raw)
        raw["calendar"] = []
        raw["news"] = {"news": []}
        context = self.build(raw)

        self.assertFalse(context["calendar"]["available"])
        self.assertEqual(context["calendar"]["availabilityStatus"], "empty")
        self.assertFalse(context["news"]["available"])
        self.assertEqual(context["news"]["availabilityStatus"], "empty")
        self.assertEqual(context["collectionStatus"], "partial")
        self.assertTrue(any("calendar: no configured" in warning for warning in context["warnings"]))
        self.assertTrue(any("news: no usable" in warning for warning in context["warnings"]))

    def test_malformed_rows_fail_soft_without_discarding_other_sections(self):
        raw = copy.deepcopy(self.raw)
        raw["calendar"] = ["not a mapping"]
        context = self.build(raw)

        self.assertEqual(context["collectionStatus"], "partial")
        self.assertFalse(context["calendar"]["available"])
        self.assertEqual(context["calendar"]["availabilityStatus"], "unavailable")
        self.assertEqual(context["calendar"]["events"], [])
        self.assertEqual(context["megacaps"]["availableCount"], 8)
        self.assertTrue(context["news"]["available"])
        self.assertTrue(any("calendar: dropped 1" in warning for warning in context["warnings"]))

    def test_current_futures_wrapper_parser_is_deterministic(self):
        rows = collector.parse_futures_html(FUTURES_HTML_PATH.read_text(encoding="utf-8"))
        self.assertEqual(rows[0], {"ticker": "NQ", "label": "Nasdaq 100", "group": "INDICES", "perf": -0.15})
        self.assertEqual(rows[1]["ticker"], "GC")

    def test_json_serialization_is_atomic_and_contains_no_nonfinite_values(self):
        context = self.build()
        serialized = json.dumps(context, allow_nan=False)
        self.assertNotIn("NaN", serialized)
        self.assertNotIn("Infinity", serialized)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "nested" / "latest.json"
            collector.atomic_write_json(output, context)
            decoded = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(decoded, context)
            self.assertEqual(list(output.parent.glob("*.tmp")), [])

    def test_nonfinite_and_out_of_range_values_are_rejected(self):
        for value in (math.nan, math.inf, -math.inf, "NaN", "Infinity", "-101%", "10001%"):
            self.assertIsNone(collector.parse_percent(value, numeric_is_ratio=False))

    def test_total_live_failure_preserves_previous_good_file(self):
        def fail():
            raise RuntimeError("fixture outage")

        adapters = {name: fail for name in collector.SOURCE_NAMES}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "latest.json"
            previous = b'{"previous":"good"}\n'
            output.write_bytes(previous)
            status = collector.run_collection(CONFIG_PATH, output, adapters=adapters, now=self.now)
            self.assertEqual(status, 1)
            self.assertEqual(output.read_bytes(), previous)

    def test_successful_fixture_run_writes_valid_json(self):
        adapters = {name: (lambda name=name: copy.deepcopy(self.raw[name])) for name in collector.SOURCE_NAMES}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "latest.json"
            status = collector.run_collection(CONFIG_PATH, output, adapters=adapters, now=self.now)
            self.assertEqual(status, 0)
            decoded = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(decoded["collectionStatus"], "ok")
            self.assertTrue(decoded["megacaps"]["available"])

    def test_overlength_news_row_is_dropped_without_losing_healthy_sections(self):
        raw = copy.deepcopy(self.raw)
        raw["news"]["news"][0]["Title"] = "x" * 501
        adapters = {name: (lambda name=name: copy.deepcopy(raw[name])) for name in collector.SOURCE_NAMES}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "latest.json"
            status = collector.run_collection(CONFIG_PATH, output, adapters=adapters, now=self.now)
            self.assertEqual(status, 0)
            decoded = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(decoded["collectionStatus"], "partial")
            self.assertEqual(len(decoded["news"]["items"]), 1)
            self.assertEqual(decoded["megacaps"]["coverageStatus"], "complete")
            self.assertTrue(any("news: dropped 1" in warning for warning in decoded["warnings"]))

    def test_semantically_invalid_candidate_preserves_previous_good_file(self):
        adapters = {name: (lambda name=name: copy.deepcopy(self.raw[name])) for name in collector.SOURCE_NAMES}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "latest.json"
            previous = b'{"previous":"good"}\n'
            output.write_bytes(previous)
            future_now = datetime.now(timezone.utc) + timedelta(days=1)
            status = collector.run_collection(CONFIG_PATH, output, adapters=adapters, now=future_now)
            self.assertEqual(status, 1)
            self.assertEqual(output.read_bytes(), previous)


if __name__ == "__main__":
    unittest.main()
