"""Fetch and print the latest stock quote for one or more tickers.

Usage:
    python get_stock.py PLTR
    python get_stock.py AAPL MSFT NVDA
    python get_stock.py --json PLTR

The fetcher tries several data sources in order and uses the first one that
answers, so it keeps working wherever at least one source is reachable:

    1. Yahoo Finance chart API  — near-real-time, no key
    2. Stooq CSV                — end-of-day, no key
    3. Alpha Vantage            — needs ALPHAVANTAGE_API_KEY in the environment

Only the Python standard library is used, so there is nothing to install.

Environment variables:
    STOCK_SOURCES         comma-separated source order override, e.g. "stooq,yahoo"
    ALPHAVANTAGE_API_KEY  API key that enables the Alpha Vantage source
    HTTPS_PROXY           honored automatically by urllib for locked-down networks
"""

import argparse
import csv
import io
import json
import os
import sys
import urllib.error
import urllib.request

TIMEOUT = 20
USER_AGENT = "get_stock.py (+https://github.com/yanivc2/.claude)"


class QuoteError(Exception):
    """Raised when a quote cannot be retrieved for a ticker."""


def _get(url):
    """HTTP GET returning the decoded body, honoring proxy env vars."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read().decode("utf-8")


def _num(value):
    """Parse a float, returning None for blanks/placeholders."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fetch_yahoo(ticker):
    """Near-real-time quote from the Yahoo Finance chart API."""
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{ticker}?interval=1d&range=1d"
    )
    payload = json.loads(_get(url))
    results = (payload.get("chart") or {}).get("result") or []
    if not results:
        raise QuoteError("yahoo returned no result")
    meta = results[0].get("meta") or {}
    price = meta.get("regularMarketPrice")
    if price is None:
        raise QuoteError("yahoo returned no price")
    return {
        "symbol": meta.get("symbol", ticker.upper()),
        "price": _num(price),
        "previous_close": _num(meta.get("chartPreviousClose")),
        "currency": meta.get("currency"),
        "source": "yahoo",
    }


def fetch_stooq(ticker):
    """End-of-day quote from the Stooq CSV endpoint."""
    url = f"https://stooq.com/q/l/?s={ticker.lower()}.us&f=sd2t2ohlcv&h&e=csv"
    rows = list(csv.DictReader(io.StringIO(_get(url))))
    if not rows or rows[0].get("Close") in (None, "", "N/D"):
        raise QuoteError("stooq has no quote for this ticker")
    row = rows[0]
    return {
        "symbol": ticker.upper(),
        "price": _num(row["Close"]),
        "open": _num(row["Open"]),
        "high": _num(row["High"]),
        "low": _num(row["Low"]),
        "volume": _num(row["Volume"]),
        "asof": f"{row['Date']} {row['Time']}".strip(),
        "source": "stooq",
    }


def fetch_alphavantage(ticker):
    """Quote from Alpha Vantage (requires ALPHAVANTAGE_API_KEY)."""
    key = os.environ.get("ALPHAVANTAGE_API_KEY")
    if not key:
        raise QuoteError("ALPHAVANTAGE_API_KEY is not set")
    url = (
        "https://www.alphavantage.co/query?function=GLOBAL_QUOTE"
        f"&symbol={ticker}&apikey={key}"
    )
    quote = json.loads(_get(url)).get("Global Quote") or {}
    if not quote.get("05. price"):
        raise QuoteError("alphavantage returned no quote (bad symbol or rate limit)")
    return {
        "symbol": quote.get("01. symbol", ticker.upper()),
        "price": _num(quote.get("05. price")),
        "open": _num(quote.get("02. open")),
        "high": _num(quote.get("03. high")),
        "low": _num(quote.get("04. low")),
        "volume": _num(quote.get("06. volume")),
        "asof": quote.get("07. latest trading day"),
        "source": "alphavantage",
    }


SOURCES = {
    "yahoo": fetch_yahoo,
    "stooq": fetch_stooq,
    "alphavantage": fetch_alphavantage,
}
DEFAULT_ORDER = ["yahoo", "stooq", "alphavantage"]


def source_order():
    """Resolve the source order from STOCK_SOURCES, falling back to default."""
    configured = os.environ.get("STOCK_SOURCES")
    if not configured:
        return DEFAULT_ORDER
    names = [name.strip().lower() for name in configured.split(",") if name.strip()]
    invalid = [name for name in names if name not in SOURCES]
    if invalid:
        raise SystemExit(f"unknown source(s) in STOCK_SOURCES: {', '.join(invalid)}")
    return names


def get_quote(ticker):
    """Return the first successful quote for ``ticker``, else raise QuoteError."""
    attempts = []
    for name in source_order():
        try:
            return SOURCES[name](ticker)
        except QuoteError as exc:
            attempts.append(f"{name}: {exc}")
        except urllib.error.URLError as exc:
            attempts.append(f"{name}: network error ({exc})")
        except (ValueError, KeyError) as exc:
            attempts.append(f"{name}: unexpected response ({exc})")
    raise QuoteError(f"all sources failed for {ticker!r} -> " + "; ".join(attempts))


def format_quote(quote):
    """Build a human-readable one-line summary for a quote."""
    parts = [f"{quote['symbol']:<6}", f"price={quote['price']:>10}"]
    for field in ("open", "high", "low", "volume"):
        if quote.get(field) is not None:
            parts.append(f"{field}={quote[field]:>10}")
    tail = " ".join(x for x in (quote.get("currency"), quote.get("asof")) if x)
    suffix = f"  [{quote['source']}{(' ' + tail) if tail else ''}]"
    return "  ".join(parts) + suffix


def main(argv):
    parser = argparse.ArgumentParser(description="Print the latest stock quote(s).")
    parser.add_argument("tickers", nargs="+", metavar="TICKER")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    args = parser.parse_args(argv[1:])

    results, exit_code = [], 0
    for ticker in args.tickers:
        try:
            quote = get_quote(ticker)
        except QuoteError as exc:
            exit_code = 1
            if args.json:
                results.append({"symbol": ticker.upper(), "error": str(exc)})
            else:
                print(f"error: {exc}", file=sys.stderr)
            continue
        if args.json:
            results.append(quote)
        else:
            print(format_quote(quote))

    if args.json:
        print(json.dumps(results, indent=2))
    return exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
