"""Fetch and print the latest stock quote for a given ticker.

Usage:
    python get_stock.py PLTR
    python get_stock.py AAPL MSFT NVDA

Data source: Stooq (https://stooq.com) CSV endpoint — free, no API key.
Only the Python standard library is used, so there is nothing to install.
"""

import csv
import io
import sys
import urllib.error
import urllib.request

STOOQ_URL = "https://stooq.com/q/l/?s={symbol}.us&f=sd2t2ohlcv&h&e=csv"


class QuoteError(Exception):
    """Raised when a quote cannot be retrieved for a ticker."""


def fetch_quote(ticker):
    """Return a dict with the latest quote for ``ticker`` from Stooq."""
    symbol = ticker.strip().lower()
    url = STOOQ_URL.format(symbol=symbol)
    request = urllib.request.Request(url, headers={"User-Agent": "get_stock.py"})

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8")
    except urllib.error.URLError as exc:
        raise QuoteError(f"network error while fetching {ticker!r}: {exc}") from exc

    rows = list(csv.DictReader(io.StringIO(body)))
    if not rows:
        raise QuoteError(f"no data returned for {ticker!r}")

    row = rows[0]
    if row.get("Close") in (None, "", "N/D"):
        raise QuoteError(f"unknown ticker or no quote available: {ticker!r}")
    return row


def format_quote(ticker, row):
    """Build a human-readable one-line summary for a quote row."""
    return (
        f"{ticker.upper():<6} "
        f"close={row['Close']:>10}  "
        f"open={row['Open']:>10}  "
        f"high={row['High']:>10}  "
        f"low={row['Low']:>10}  "
        f"vol={row['Volume']:>12}  "
        f"({row['Date']} {row['Time']})"
    )


def main(argv):
    tickers = argv[1:]
    if not tickers:
        print("usage: python get_stock.py TICKER [TICKER ...]", file=sys.stderr)
        return 2

    exit_code = 0
    for ticker in tickers:
        try:
            row = fetch_quote(ticker)
        except QuoteError as exc:
            print(f"error: {exc}", file=sys.stderr)
            exit_code = 1
            continue
        print(format_quote(ticker, row))
    return exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
