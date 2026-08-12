# get_stock.py

A small, dependency-free CLI that prints the latest quote for one or more
tickers. Uses only the Python standard library — nothing to install.

## Usage

```bash
python get_stock.py PLTR
python get_stock.py AAPL MSFT NVDA
python get_stock.py --json PLTR          # machine-readable output
```

Example:

```
PLTR    price=    127.18  [yahoo USD]
```

Exit code is `0` when every ticker resolved, `1` if any ticker failed.

## Data sources

The fetcher tries these in order and uses the first that answers, so it keeps
working wherever at least one host is reachable:

| Order | Source        | Freshness         | Key required            |
| :---- | :------------ | :---------------- | :---------------------- |
| 1     | Yahoo Finance | near-real-time    | no                      |
| 2     | Stooq         | end-of-day        | no                      |
| 3     | Alpha Vantage | near-real-time    | `ALPHAVANTAGE_API_KEY`  |

## Environment variables

| Variable               | Purpose                                              |
| :--------------------- | :--------------------------------------------------- |
| `STOCK_SOURCES`        | Override source order, e.g. `stooq,yahoo`            |
| `ALPHAVANTAGE_API_KEY` | Enables the Alpha Vantage source                     |
| `HTTPS_PROXY`          | Honored automatically by `urllib` on locked networks |

## Running in a Claude Code on the web (remote) session

Remote sessions run behind an egress proxy. By default (**Trusted** network
access) every finance-data host is blocked and the script returns
`network error ... 403`. To fetch live quotes remotely, the environment's
**Network access** must allow the data hosts:

1. Open the environment for editing at [claude.ai/code](https://claude.ai/code)
   → **Network access**.
2. Choose **Custom** and check *"Also include default list of common package
   managers"*.
3. Add under **Allowed domains**:
   ```
   query1.finance.yahoo.com
   query2.finance.yahoo.com
   stooq.com
   www.alphavantage.co
   ```
   (or choose **Full** for unrestricted egress).

The network policy is fixed when a session starts, so a change only takes
effect in a **newly started** session. Verify egress from a fresh session
with:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d"
```

A `200` means quotes will work. Note that the Yahoo host *root* (`/`) rate-limits
with `429`; that is expected — the script calls the `/v8/finance/chart/` endpoint
with a `User-Agent`, which is not affected.
