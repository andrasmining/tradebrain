#!/usr/bin/env python3
"""Collect bounded, supplementary Finviz context for TradeBrain.

The module intentionally keeps finvizfinance imports inside the live adapter so
normalization and failure semantics can be tested without network dependencies.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from datetime import date, datetime, timezone
from numbers import Real
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlsplit


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = REPO_ROOT / "config" / "finviz.json"
DEFAULT_OUTPUT_PATH = REPO_ROOT / "data" / "finviz" / "latest.json"
FINVIZ_LIBRARY_VERSION = "1.3.0"
FINVIZ_FUTURES_URL = "https://finviz.com/futures_performance.ashx"
FINVIZ_CALENDAR_URL = "https://finviz.com/calendar.ashx"
SOURCE_NAMES = ("calendar", "sectors", "industries", "screen", "futures", "news")
MAX_WARNINGS = 30
MAX_WARNING_LENGTH = 300
MAX_CHANGE_PCT = 10_000
MONTH_NUMBERS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, Real) and not isinstance(value, bool) and not math.isfinite(float(value)):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def _bounded(value: str, minimum: int, maximum: int) -> bool:
    return minimum <= len(value) <= maximum


def _valid_http_url(value: str) -> bool:
    if not _bounded(value, 1, 2000) or re.search(r"\s", value):
        return False
    try:
        parsed = urlsplit(value)
        return parsed.scheme.lower() in {"http", "https"} and bool(parsed.hostname)
    except ValueError:
        return False


def _normalized_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", _clean_text(value).lower())


def _row_value(row: Mapping[str, Any], *aliases: str) -> Any:
    keys = {_normalized_key(key): value for key, value in row.items()}
    for alias in aliases:
        normalized = _normalized_key(alias)
        if normalized in keys:
            return keys[normalized]
    return None


def _mapping_rows(value: Any) -> tuple[list[Mapping[str, Any]], int]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return [], 1
    rows = [row for row in value if isinstance(row, Mapping)]
    return rows, len(value) - len(rows)


def _has_column(rows: Sequence[Mapping[str, Any]], *aliases: str) -> bool:
    expected = {_normalized_key(alias) for alias in aliases}
    return any(expected.intersection(_normalized_key(key) for key in row) for row in rows)


def _require_columns(
    rows: Sequence[Mapping[str, Any]], source: str, alias_groups: Sequence[Sequence[str]]
) -> None:
    for aliases in alias_groups:
        if not _has_column(rows, *aliases):
            raise ValueError(f"{source} is missing expected column {'/'.join(aliases)}")


def _source_rows_usable(value: Any, alias_groups: Sequence[Sequence[str]]) -> bool:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return False
    if not value:
        return True
    rows, _ = _mapping_rows(value)
    return bool(rows) and all(_has_column(rows, *aliases) for aliases in alias_groups)


def _rounded(value: float) -> float:
    result = round(float(value), 4)
    return 0.0 if result == 0 else result


def parse_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Real):
        number = float(value)
    else:
        text = _clean_text(value).replace(",", "")
        if not text or text in {"-", "--", "N/A", "n/a"}:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    return number if math.isfinite(number) else None


def parse_percent(value: Any, *, numeric_is_ratio: bool) -> float | None:
    """Return percent-points from Finviz's mixed percent representations.

    finvizfinance converts most group percentages to decimal ratios, while some
    fields (notably screener Change %) remain strings such as ``"1.25%"``.
    Futures ``perf`` values are already percent-points.
    """

    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Real):
        number = float(value)
        if numeric_is_ratio:
            number *= 100
    else:
        text = _clean_text(value).replace(",", "").replace("−", "-")
        if not text or text in {"-", "--", "N/A", "n/a"}:
            return None
        has_percent = text.endswith("%")
        if has_percent:
            text = text[:-1].strip()
        try:
            number = float(text)
        except ValueError:
            return None
        if numeric_is_ratio and not has_percent:
            number *= 100
    if not math.isfinite(number) or number < -100 or number > MAX_CHANGE_PCT:
        return None
    return _rounded(number)


def _normalized_symbol(value: Any, requested: set[str] | None = None) -> str | None:
    raw = _clean_text(value).upper()
    if not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", raw):
        return None
    if requested is None or raw in requested:
        return raw
    # finvizfinance 1.3.0 can prepend the ticker logo's first letter to the
    # actual ticker. Repair only the exact duplicated-prefix form requested by
    # configuration; never guess an unrelated ticker.
    if len(raw) > 1 and raw[0] == raw[1] and raw[1:] in requested:
        return raw[1:]
    return None


def _unique_symbols(values: Sequence[Any], field: str) -> list[str]:
    symbols: list[str] = []
    seen: set[str] = set()
    for value in values:
        symbol = _normalized_symbol(value)
        if symbol is None:
            raise ValueError(f"{field} contains an invalid ticker identifier")
        if symbol in seen:
            raise ValueError(f"{field} contains duplicate ticker {symbol}")
        symbols.append(symbol)
        seen.add(symbol)
    if not symbols:
        raise ValueError(f"{field} must not be empty")
    return symbols


def load_config(path: Path | str = DEFAULT_CONFIG_PATH) -> dict[str, Any]:
    config_path = Path(path)
    with config_path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    if not isinstance(config, dict) or config.get("schemaVersion") != "1.0.0":
        raise ValueError("Finviz config schemaVersion must be 1.0.0")
    for field, lower, upper in (
        ("freshnessMinutes", 1, 360),
        ("requestTimeoutSeconds", 1, 60),
        ("maximumHeadlines", 1, 50),
        ("earningsLookaheadDays", 1, 366),
    ):
        value = config.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or not lower <= value <= upper:
            raise ValueError(f"{field} must be an integer from {lower} to {upper}")
    for field in ("megacapSymbols", "semiconductorSymbols", "futuresSymbols"):
        if not isinstance(config.get(field), list):
            raise ValueError(f"{field} must be an array")
        config[field] = _unique_symbols(config[field], field)
    impacts = config.get("calendarImpacts")
    if not isinstance(impacts, list) or not impacts:
        raise ValueError("calendarImpacts must be a non-empty array")
    normalized_impacts = [_clean_text(value).lower() for value in impacts]
    if len(set(normalized_impacts)) != len(normalized_impacts) or not set(normalized_impacts) <= {"high", "medium"}:
        raise ValueError("calendarImpacts may contain unique high and medium values only")
    config["calendarImpacts"] = normalized_impacts
    breadth = config.get("breadth")
    if not isinstance(breadth, dict) or not isinstance(breadth.get("sectorAliases"), dict):
        raise ValueError("breadth.sectorAliases must be an object")
    for canonical, aliases in breadth["sectorAliases"].items():
        if not _clean_text(canonical) or not isinstance(aliases, list) or not aliases or not all(_clean_text(item) for item in aliases):
            raise ValueError("breadth.sectorAliases must map names to non-empty string arrays")
    includes = breadth.get("industryNameIncludes")
    if not isinstance(includes, list) or not includes or not all(_clean_text(item) for item in includes):
        raise ValueError("breadth.industryNameIncludes must be a non-empty string array")
    return config


def normalize_calendar(rows: Any, impacts: Sequence[str]) -> tuple[list[dict[str, Any]], int]:
    allowed = set(impacts)
    events: list[dict[str, Any]] = []
    mapped_rows, dropped = _mapping_rows(rows)
    for row in mapped_rows:
        raw_impact_value = _row_value(row, "Impact", "Importance")
        raw_impact = _clean_text(raw_impact_value)
        lowered = raw_impact.lower()
        if lowered in {"high", "3", "3.0"}:
            impact = "high"
        elif lowered in {"medium", "med", "2", "2.0"}:
            impact = "medium"
        else:
            continue
        if impact not in allowed:
            continue
        raw_datetime = _clean_text(_row_value(row, "Datetime", "Date"))
        release = _clean_text(_row_value(row, "Release", "Event"))
        period = _clean_text(_row_value(row, "For", "Reference"))
        actual = _clean_text(_row_value(row, "Actual"))
        expected = _clean_text(_row_value(row, "Expected", "Forecast"))
        prior = _clean_text(_row_value(row, "Prior", "Previous"))
        category = _clean_text(_row_value(row, "Category"))
        source_ticker = _clean_text(_row_value(row, "Ticker"))
        if not (
            _bounded(raw_datetime, 1, 120)
            and _bounded(release, 1, 300)
            and _bounded(raw_impact, 1, 40)
            and all(_bounded(value, 0, 120) for value in (period, actual, expected, prior, category, source_ticker))
        ):
            dropped += 1
            continue
        item: dict[str, Any] = {
            "rawDateTime": raw_datetime,
            "release": release,
            "impact": impact,
            "rawImpact": raw_impact,
            "period": period,
            "actual": actual,
            "expected": expected,
            "prior": prior,
        }
        if category:
            item["category"] = category
        if source_ticker:
            item["sourceTicker"] = source_ticker
        events.append(item)
    return events, dropped


def normalize_sectors(
    rows: Any, sector_aliases: Mapping[str, Sequence[str]]
) -> tuple[list[dict[str, Any]], int]:
    aliases: dict[str, str] = {}
    order: dict[str, int] = {}
    for index, (canonical, raw_aliases) in enumerate(sector_aliases.items()):
        order[canonical] = index
        for alias in raw_aliases:
            aliases[_normalized_key(alias)] = canonical
    items: list[dict[str, Any]] = []
    mapped_rows, dropped = _mapping_rows(rows)
    for row in mapped_rows:
        raw_name = _clean_text(_row_value(row, "Name"))
        canonical = aliases.get(_normalized_key(raw_name))
        if canonical is None:
            continue
        if not _bounded(raw_name, 1, 160) or not _bounded(canonical, 1, 160):
            dropped += 1
            continue
        change = parse_percent(_row_value(row, "Change %", "Change"), numeric_is_ratio=True)
        if change is None:
            dropped += 1
            continue
        items.append({"name": canonical, "rawName": raw_name, "changePct": change})
    items.sort(key=lambda item: order.get(item["name"], len(order)))
    return items, dropped


def normalize_industries(
    rows: Any, name_includes: Sequence[str]
) -> tuple[list[dict[str, Any]], int]:
    needles = [_normalized_key(value) for value in name_includes]
    items: list[dict[str, Any]] = []
    mapped_rows, dropped = _mapping_rows(rows)
    for row in mapped_rows:
        raw_name = _clean_text(_row_value(row, "Name"))
        normalized_name = _normalized_key(raw_name)
        if not raw_name or not any(needle in normalized_name for needle in needles):
            continue
        if not _bounded(raw_name, 1, 160):
            dropped += 1
            continue
        change = parse_percent(_row_value(row, "Change %", "Change"), numeric_is_ratio=True)
        if change is None:
            dropped += 1
            continue
        items.append({"name": raw_name, "rawName": raw_name, "changePct": change})
    items.sort(key=lambda item: item["rawName"].casefold())
    return items, dropped


def normalize_basket(rows: Any, requested_symbols: Sequence[str]) -> tuple[dict[str, Any], int]:
    requested = list(requested_symbols)
    requested_set = set(requested)
    by_symbol: dict[str, dict[str, Any]] = {}
    mapped_rows, dropped = _mapping_rows(rows)
    for row in mapped_rows:
        symbol = _normalized_symbol(_row_value(row, "Ticker", "Symbol"), requested_set)
        if symbol is None or symbol in by_symbol:
            continue
        change = parse_percent(_row_value(row, "Change %", "Change"), numeric_is_ratio=True)
        if change is None:
            dropped += 1
            continue
        item: dict[str, Any] = {"symbol": symbol, "changePct": change}
        price = parse_number(_row_value(row, "Price"))
        if price is not None and 0 <= price <= 10_000_000:
            item["price"] = _rounded(price)
        by_symbol[symbol] = item
    items = [by_symbol[symbol] for symbol in requested if symbol in by_symbol]
    missing = [symbol for symbol in requested if symbol not in by_symbol]
    changes = [item["changePct"] for item in items]
    positive = sum(value > 0 for value in changes)
    negative = sum(value < 0 for value in changes)
    unchanged = len(changes) - positive - negative
    if changes:
        positive_pct = _rounded(positive * 100 / len(changes))
        mean = _rounded(statistics.fmean(changes))
        median = _rounded(statistics.median(changes))
        dispersion = _rounded(statistics.pstdev(changes))
        coverage = "complete" if not missing else "partial"
    else:
        positive_pct = mean = median = dispersion = None
        coverage = "unavailable"
    return {
        "available": bool(items),
        "performanceBasis": "latest-session",
        "sourceAsOfStatus": "not-provided",
        "realTimePricePath": False,
        "coverageStatus": coverage,
        "symbolsRequested": requested,
        "missingSymbols": missing,
        "items": items,
        "availableCount": len(items),
        "positiveCount": positive,
        "negativeCount": negative,
        "unchangedCount": unchanged,
        "positivePct": positive_pct,
        "meanChangePct": mean,
        "medianChangePct": median,
        "dispersionPct": dispersion,
    }, dropped


def normalize_futures(
    rows: Any, requested_symbols: Sequence[str]
) -> tuple[dict[str, Any], int]:
    requested = list(requested_symbols)
    requested_set = set(requested)
    by_symbol: dict[str, dict[str, Any]] = {}
    mapped_rows, dropped = _mapping_rows(rows)
    for row in mapped_rows:
        symbol = _normalized_symbol(_row_value(row, "ticker", "symbol"), requested_set)
        if symbol is None or symbol in by_symbol:
            continue
        label = _clean_text(_row_value(row, "label", "name"))
        group = _clean_text(_row_value(row, "group"))
        change = parse_percent(_row_value(row, "perf", "performance", "change"), numeric_is_ratio=False)
        if not _bounded(label, 1, 160) or not _bounded(group, 0, 120) or change is None:
            dropped += 1
            continue
        by_symbol[symbol] = {
            "symbol": symbol,
            "label": label,
            "group": group,
            "changePct": change,
        }
    items = [by_symbol[symbol] for symbol in requested if symbol in by_symbol]
    missing = [symbol for symbol in requested if symbol not in by_symbol]
    coverage = "complete" if items and not missing else "partial" if items else "unavailable"
    return {
        "available": bool(items),
        "coverageStatus": coverage,
        "symbolsRequested": requested,
        "missingSymbols": missing,
        "delayedContextOnly": True,
        "usage": "supporting-context-only",
        "items": items,
    }, dropped


def _upcoming_earnings_date(
    raw_datetime: str, reference_date: date, lookahead_days: int
) -> date | None:
    """Resolve Finviz's month/day label only within a conservative forward window.

    The screener can retain a company's most recently reported date. Finviz does
    not include a year in values such as ``Aug 26/a``, so a year rollover is
    accepted only when the resulting date is inside the configured forward window.
    """

    raw_date = raw_datetime.split("/", 1)[0].strip()
    match = re.fullmatch(r"([A-Za-z]{3})\s+(\d{1,2})(?:,?\s+(\d{4}))?", raw_date)
    if not match:
        return None
    raw_month, raw_day, raw_year = match.groups()
    month = MONTH_NUMBERS.get(raw_month.lower())
    if month is None:
        return None
    years = [int(raw_year)] if raw_year else [reference_date.year, reference_date.year + 1]
    for year in years:
        try:
            candidate = date(year, month, int(raw_day))
        except ValueError:
            return None
        days_until = (candidate - reference_date).days
        if 0 <= days_until <= lookahead_days:
            return candidate
    return None


def normalize_earnings(
    rows: Any,
    requested_symbols: Sequence[str],
    reference_date: date,
    lookahead_days: int,
) -> tuple[list[dict[str, Any]], int]:
    requested = list(dict.fromkeys(requested_symbols))
    requested_set = set(requested)
    by_symbol: dict[str, dict[str, Any]] = {}
    mapped_rows, dropped = _mapping_rows(rows)
    for row in mapped_rows:
        symbol = _normalized_symbol(_row_value(row, "Ticker", "Symbol"), requested_set)
        if symbol is None or symbol in by_symbol:
            continue
        raw_datetime = _clean_text(_row_value(row, "Earnings", "Earnings Date"))
        if not raw_datetime or raw_datetime in {"-", "--"}:
            continue
        if not _bounded(raw_datetime, 1, 120):
            dropped += 1
            continue
        raw_date = raw_datetime.split("/", 1)[0].strip()
        date_match = re.fullmatch(r"[A-Za-z]{3}\s+\d{1,2}(?:,?\s+(\d{4}))?", raw_date)
        if not date_match:
            dropped += 1
            continue
        resolved_date = _upcoming_earnings_date(raw_datetime, reference_date, lookahead_days)
        if resolved_date is None:
            continue
        item: dict[str, Any] = {
            "symbol": symbol,
            "rawDateTime": raw_datetime,
            "date": resolved_date.isoformat(),
            "dateResolution": "source-year" if date_match.group(1) else "year-inferred",
            "daysUntil": (resolved_date - reference_date).days,
        }
        timing_match = re.search(r"/([^/\s]+)$", raw_datetime)
        if timing_match:
            if not _bounded(timing_match.group(1), 1, 20):
                dropped += 1
                continue
            item["rawTimingCode"] = timing_match.group(1)
        by_symbol[symbol] = item
    return [by_symbol[symbol] for symbol in requested if symbol in by_symbol], dropped


def normalize_news(raw: Any, maximum: int) -> tuple[list[dict[str, Any]], int]:
    rows = raw.get("news", []) if isinstance(raw, Mapping) else raw
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes)):
        return [], 1
    items: list[dict[str, Any]] = []
    dropped = 0
    for row in rows:
        if len(items) >= maximum:
            break
        if not isinstance(row, Mapping):
            dropped += 1
            continue
        headline = _clean_text(_row_value(row, "Title", "Headline"))
        url = _clean_text(_row_value(row, "Link", "URL"))
        raw_datetime = _clean_text(_row_value(row, "Date", "Datetime"))
        source = _clean_text(_row_value(row, "Source"))
        if not (
            _bounded(raw_datetime, 0, 120)
            and _bounded(headline, 1, 500)
            and _bounded(source, 0, 160)
            and _valid_http_url(url)
        ):
            dropped += 1
            continue
        items.append(
            {
                "rawDateTime": raw_datetime,
                "headline": headline,
                "source": source,
                "url": url,
            }
        )
    return items, dropped


def _warning_text(source: str, error: BaseException) -> str:
    detail = re.sub(r"\s+", " ", str(error)).strip()
    value = f"{source} unavailable: {type(error).__name__}"
    if detail:
        value += f": {detail}"
    return value[:MAX_WARNING_LENGTH]


def _add_warning(warnings: list[str], value: str) -> None:
    cleaned = re.sub(r"\s+", " ", value).strip()[:MAX_WARNING_LENGTH]
    if cleaned and cleaned not in warnings and len(warnings) < MAX_WARNINGS:
        warnings.append(cleaned)


def build_context(
    config: Mapping[str, Any],
    raw_sources: Mapping[str, Any],
    failures: Mapping[str, BaseException] | None = None,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    failures = failures or {}
    warnings: list[str] = []
    timestamp = generated_at or utc_now()
    reference_date = (
        timestamp.astimezone(timezone.utc).date() if timestamp.tzinfo is not None else timestamp.date()
    )
    for source in SOURCE_NAMES:
        if source in failures:
            _add_warning(warnings, _warning_text(source, failures[source]))

    calendar_rows = raw_sources.get("calendar", [])
    calendar_events, calendar_dropped = normalize_calendar(calendar_rows, config["calendarImpacts"])
    calendar_source_usable = "calendar" in raw_sources and _source_rows_usable(
        calendar_rows, [("Datetime", "Date"), ("Release", "Event"), ("Impact", "Importance")]
    )
    calendar_available = calendar_source_usable and bool(calendar_events)
    calendar_status = "available" if calendar_available else "empty" if calendar_source_usable else "unavailable"
    if "calendar" in raw_sources and not calendar_source_usable:
        _add_warning(warnings, "calendar: source rows did not expose the expected event columns")
    if "calendar" in raw_sources and not calendar_events:
        _add_warning(warnings, "calendar: no configured high/medium-impact events were available")
    if calendar_dropped:
        _add_warning(warnings, f"calendar: dropped {calendar_dropped} malformed relevant row(s)")

    sectors, sectors_dropped = normalize_sectors(
        raw_sources.get("sectors", []), config["breadth"]["sectorAliases"]
    )
    industries, industries_dropped = normalize_industries(
        raw_sources.get("industries", []), config["breadth"]["industryNameIncludes"]
    )
    sector_available = "sectors" in raw_sources and bool(sectors)
    industry_available = "industries" in raw_sources and bool(industries)
    if "sectors" in raw_sources and not sectors:
        _add_warning(warnings, "sectors: no configured relevant values were available")
    if "industries" in raw_sources and not industries:
        _add_warning(warnings, "industries: no configured relevant values were available")
    if sectors_dropped:
        _add_warning(warnings, f"sectors: dropped {sectors_dropped} malformed relevant row(s)")
    if industries_dropped:
        _add_warning(warnings, f"industries: dropped {industries_dropped} malformed relevant row(s)")

    screen_rows = raw_sources.get("screen", [])
    mapped_screen_rows, _ = _mapping_rows(screen_rows)
    earnings_source_usable = (
        "screen" in raw_sources
        and bool(mapped_screen_rows)
        and _has_column(mapped_screen_rows, "Earnings", "Earnings Date")
    )
    if "screen" in raw_sources and not earnings_source_usable:
        _add_warning(warnings, "earnings: configured screen did not expose the expected Earnings column")
    megacaps, megacap_dropped = normalize_basket(screen_rows, config["megacapSymbols"])
    semiconductors, semiconductor_dropped = normalize_basket(screen_rows, config["semiconductorSymbols"])
    if "screen" in raw_sources:
        for label, basket, dropped in (
            ("megacaps", megacaps, megacap_dropped),
            ("semiconductors", semiconductors, semiconductor_dropped),
        ):
            if basket["missingSymbols"]:
                _add_warning(warnings, f"{label}: missing configured symbols {', '.join(basket['missingSymbols'])}")
            if dropped:
                _add_warning(warnings, f"{label}: dropped {dropped} row(s) without usable daily change")

    futures, futures_dropped = normalize_futures(raw_sources.get("futures", []), config["futuresSymbols"])
    if "futures" in raw_sources and futures["missingSymbols"]:
        _add_warning(warnings, f"futures: missing configured symbols {', '.join(futures['missingSymbols'])}")
    if futures_dropped:
        _add_warning(warnings, f"futures: dropped {futures_dropped} malformed relevant row(s)")

    earnings_items, earnings_dropped = normalize_earnings(
        screen_rows,
        [*config["megacapSymbols"], *config["semiconductorSymbols"]],
        reference_date,
        config["earningsLookaheadDays"],
    )
    if earnings_dropped:
        _add_warning(warnings, f"earnings: dropped {earnings_dropped} malformed row(s)")
    earnings_available = earnings_source_usable and bool(earnings_items)
    earnings_status = (
        "available" if earnings_available else "empty" if earnings_source_usable else "unavailable"
    )

    raw_news = raw_sources.get("news", [])
    news_rows = raw_news.get("news") if isinstance(raw_news, Mapping) else raw_news
    news_source_usable = "news" in raw_sources and _source_rows_usable(
        news_rows, [("Title", "Headline"), ("Link", "URL")]
    )
    news_items, news_dropped = normalize_news(raw_news, config["maximumHeadlines"])
    news_available = news_source_usable and bool(news_items)
    news_status = "available" if news_available else "empty" if news_source_usable else "unavailable"
    if "news" in raw_sources and not news_source_usable:
        _add_warning(warnings, "news: source rows did not expose the expected headline columns")
    if "news" in raw_sources and not news_items:
        _add_warning(warnings, "news: no usable headlines were available")
    if news_dropped:
        _add_warning(warnings, f"news: dropped {news_dropped} malformed row(s)")

    partial = bool(warnings) or not (
        calendar_available
        and sector_available
        and industry_available
        and megacaps["coverageStatus"] == "complete"
        and semiconductors["coverageStatus"] == "complete"
        and futures["coverageStatus"] == "complete"
        and earnings_source_usable
        and news_available
    )
    return {
        "schemaVersion": "1.0.0",
        "source": "finviz",
        "generatedAt": iso_utc(timestamp),
        "freshnessMinutes": config["freshnessMinutes"],
        "collectionStatus": "partial" if partial else "ok",
        "warnings": warnings,
        "library": {"name": "finvizfinance", "version": FINVIZ_LIBRARY_VERSION},
        "calendar": {
            "available": calendar_available,
            "availabilityStatus": calendar_status,
            "timezoneStatus": "unverified",
            "timezoneNote": "Finviz calendar timestamps have no verified timezone; raw source values are preserved without conversion.",
            "events": calendar_events,
        },
        "breadth": {
            "available": sector_available or industry_available,
            "performanceBasis": "latest-session",
            "sourceAsOfStatus": "not-provided",
            "realTimePricePath": False,
            "sectorAvailable": sector_available,
            "industryAvailable": industry_available,
            "sectors": sectors,
            "industries": industries,
        },
        "megacaps": megacaps,
        "semiconductors": semiconductors,
        "futures": futures,
        "earnings": {
            "available": earnings_available,
            "availabilityStatus": earnings_status,
            "lookaheadDays": config["earningsLookaheadDays"],
            "items": earnings_items,
        },
        "news": {
            "available": news_available,
            "availabilityStatus": news_status,
            "discoveryOnly": True,
            "items": news_items,
        },
    }


def has_meaningful_data(context: Mapping[str, Any]) -> bool:
    return any(
        (
            context["calendar"]["events"],
            context["breadth"]["sectors"],
            context["breadth"]["industries"],
            context["megacaps"]["items"],
            context["semiconductors"]["items"],
            context["futures"]["items"],
            context["earnings"]["items"],
            context["news"]["items"],
        )
    )


def _records_from_frame(frame: Any, source: str) -> list[dict[str, Any]]:
    if frame is None or not hasattr(frame, "to_dict"):
        raise ValueError(f"{source} did not return a data frame")
    records = frame.to_dict(orient="records")
    if not isinstance(records, list) or not all(isinstance(row, dict) for row in records):
        raise ValueError(f"{source} returned malformed records")
    return records


def parse_futures_html(html: str) -> list[dict[str, Any]]:
    call = re.search(r"FinvizInitFuturesPerformance\(\s*", html)
    if call:
        fragment = html[call.end() :].lstrip()
        if fragment.startswith("["):
            value, _ = json.JSONDecoder().raw_decode(fragment)
            if isinstance(value, list) and all(isinstance(row, dict) for row in value):
                return value
    declaration = re.search(r"var\s+rows\s*=\s*", html)
    if declaration:
        value, _ = json.JSONDecoder().raw_decode(html[declaration.end() :].lstrip())
        if isinstance(value, list) and all(isinstance(row, dict) for row in value):
            return value
    raise ValueError("Finviz futures payload marker was not found")


class LiveFinvizAdapter:
    """Thin, bounded live adapter around finvizfinance 1.3.0."""

    def __init__(self, config: Mapping[str, Any]):
        self.config = config
        self._prepared = False

    def _prepare(self) -> None:
        if self._prepared:
            return
        from finvizfinance.util import set_timeout

        set_timeout(self.config["requestTimeoutSeconds"])
        self._prepared = True

    def calendar(self) -> list[dict[str, Any]]:
        self._prepare()
        from finvizfinance.calendar import Calendar

        legacy = _records_from_frame(Calendar().calendar(), "calendar")
        if legacy:
            _require_columns(
                legacy,
                "calendar",
                [("Datetime", "Date"), ("Release", "Event"), ("Impact", "Importance")],
            )
            return legacy
        # Finviz's current calendar route embeds structured JSON; 1.3.0's old
        # table parser silently returns an empty frame after the route change.
        from finvizfinance.util import web_scrap

        soup = web_scrap(FINVIZ_CALENDAR_URL)
        script = soup.find("script", id="route-init-data")
        if script is None or not script.string:
            raise ValueError("Finviz calendar route payload was not found")
        payload = json.loads(script.string)
        entries = payload.get("data", {}).get("entries")
        if not isinstance(entries, list) or not all(isinstance(row, dict) for row in entries):
            raise ValueError("Finviz calendar route payload was malformed")
        if entries:
            _require_columns(
                entries,
                "calendar",
                [("Datetime", "Date"), ("Release", "Event"), ("Impact", "Importance")],
            )
        return entries

    def sectors(self) -> list[dict[str, Any]]:
        self._prepare()
        from finvizfinance.group.performance import Performance

        rows = _records_from_frame(Performance().screener_view(group="Sector", order="Name"), "sectors")
        if rows:
            _require_columns(rows, "sectors", [("Name",), ("Change %", "Change")])
        return rows

    def industries(self) -> list[dict[str, Any]]:
        self._prepare()
        from finvizfinance.group.performance import Performance

        frame = Performance().screener_view(group="Industry (Technology)", order="Name")
        rows = _records_from_frame(frame, "industries")
        if rows:
            _require_columns(rows, "industries", [("Name",), ("Change %", "Change")])
        return rows

    def screen(self) -> list[dict[str, Any]]:
        self._prepare()
        from finvizfinance.screener.custom import Custom

        symbols = list(dict.fromkeys([*self.config["megacapSymbols"], *self.config["semiconductorSymbols"]]))
        screener = Custom()
        screener.set_filter(ticker=",".join(symbols))
        # Pass a fresh list because finvizfinance mutates the columns argument.
        frame = screener.screener_view(
            order="Ticker",
            limit=len(symbols),
            verbose=0,
            columns=[1, 65, 66, 68],
            sleep_sec=1,
        )
        rows = _records_from_frame(frame, "configured ticker screen")
        if not rows:
            raise ValueError("configured ticker screen returned no rows")
        _require_columns(
            rows,
            "configured ticker screen",
            [("Ticker", "Symbol"), ("Change %", "Change")],
        )
        return rows

    def futures(self) -> list[dict[str, Any]]:
        self._prepare()
        from finvizfinance.future import Future

        try:
            rows = _records_from_frame(Future().performance(timeframe="D"), "futures")
            if rows:
                _require_columns(rows, "futures", [("ticker", "symbol"), ("perf", "performance", "change")])
            return rows
        except json.JSONDecodeError:
            # One compatibility fetch handles Finviz's current inline-array
            # wrapper. HTTP/access failures are not retried or bypassed.
            from finvizfinance.util import web_scrap

            rows = parse_futures_html(web_scrap(FINVIZ_FUTURES_URL).prettify())
            _require_columns(rows, "futures", [("ticker", "symbol"), ("perf", "performance", "change")])
            return rows

    def news(self) -> dict[str, list[dict[str, Any]]]:
        self._prepare()
        from finvizfinance.news import News

        raw = News().get_news()
        if not isinstance(raw, dict) or "news" not in raw:
            raise ValueError("news did not return the expected mapping")
        rows = _records_from_frame(raw["news"], "news")
        if not rows:
            raise ValueError("news returned no rows")
        _require_columns(rows, "news", [("Title", "Headline"), ("Link", "URL")])
        return {"news": rows}

    def adapters(self) -> dict[str, Callable[[], Any]]:
        return {name: getattr(self, name) for name in SOURCE_NAMES}


def collect_context(
    config: Mapping[str, Any],
    adapters: Mapping[str, Callable[[], Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    active_adapters = adapters or LiveFinvizAdapter(config).adapters()
    raw_sources: dict[str, Any] = {}
    failures: dict[str, BaseException] = {}
    for name in SOURCE_NAMES:
        adapter = active_adapters.get(name)
        if adapter is None:
            failures[name] = RuntimeError("adapter is not configured")
            continue
        try:
            raw_sources[name] = adapter()
        except Exception as error:  # section isolation is deliberate
            failures[name] = error
    return build_context(config, raw_sources, failures, now)


def validate_context_file(path: Path | str, config_path: Path | str = DEFAULT_CONFIG_PATH) -> None:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("Node.js is required to validate Finviz context before publication")
    validator = REPO_ROOT / "scripts" / "validate-finviz-context.mjs"
    result = subprocess.run(
        [node, str(validator), str(path), str(config_path)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise ValueError(f"semantic context validation failed: {detail[:1000]}")


def atomic_write_json(
    path: Path | str,
    value: Mapping[str, Any],
    validate: Callable[[Path], None] | None = None,
) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if validate is not None:
            validate(Path(temporary_name))
        os.replace(temporary_name, output_path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def run_collection(
    config_path: Path | str = DEFAULT_CONFIG_PATH,
    output_path: Path | str = DEFAULT_OUTPUT_PATH,
    adapters: Mapping[str, Callable[[], Any]] | None = None,
    now: datetime | None = None,
) -> int:
    resolved_config_path = Path(config_path).resolve()
    config = load_config(resolved_config_path)
    context = collect_context(config, adapters=adapters, now=now)
    if not has_meaningful_data(context):
        print("Finviz collection failed: no meaningful data; existing latest.json was preserved.", file=sys.stderr)
        for warning in context["warnings"]:
            print(f"- {warning}", file=sys.stderr)
        return 1
    try:
        atomic_write_json(
            output_path,
            context,
            validate=lambda temporary_path: validate_context_file(temporary_path, resolved_config_path),
        )
    except Exception as error:
        print(
            f"Finviz context was not published; existing latest.json was preserved: "
            f"{type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 1
    print(
        f"Wrote {output_path} ({context['collectionStatus']}; {len(context['warnings'])} warning(s))."
    )
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collect shared Finviz supporting context")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH)
    arguments = parser.parse_args(argv)
    try:
        return run_collection(arguments.config, arguments.output)
    except Exception as error:
        print(f"Finviz collection failed before publication: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
