# P1a — Product Pricing

**Scope: `TokenUsage + PriceCard -> CostQuote`.** This module answers *what does this
usage cost*. It does **not** answer *how much usage will there be* — that is the
estimator, and it is not built. Keeping the two apart means a wrong price and a wrong
token count remain distinguishable bugs.

Location: `src/meta_orchestrator/planner/pricing/` (provisional, per open decision 11.1).

```
entities.py    PriceRate, RateStatus, PriceCard, TokenUsage, UsageCategory
catalog.py     PricingCatalog — versioned, static, content-addressed
calculator.py  CostCalculator — deterministic, offline, stateless
quote.py       CostComponent, CostQuote, QuoteSet
compat.py      ModelSpec (float) -> PriceCard (Decimal) — the one float boundary
errors.py      fail-closed pricing errors
```

---

## 1. Source of truth

Decision 11.2 is closed for the MVP: **the product owns its own pricing catalog.**

`experiment/s2/pricing.py` is **not imported, not subclassed, and not refactored into
a shared base.** It is frozen and hash-bound into §2's authorisation chain; depending
on it would couple product code to a research audit trail. Its *patterns* are reused —
`Decimal`-only, prices held as strings, content-addressed cards, drift detection — its
code is not. The small duplication is deliberate and cheaper than the coupling.

Every rate traces to something already in this repository. Nothing was fetched,
searched for, averaged, or inferred from a neighbouring model.

| Model | Provider | Input $/MTok | Output $/MTok | Source |
|---|---|---|---|---|
| `claude-opus-4-8` | anthropic | 5.00 | 25.00 | `config.py` registry seed (Claude API model table, verified 2026-07-15) |
| `claude-haiku-4-5` | anthropic | 1.00 | 5.00 | as above, **plus** `corpus/s2_pricing.frozen.json` (hash `4ab7b2507474bffa`, verified 2026-07-19) — the two agree exactly |
| `mock-strong` | mock | 3.00 | 15.00 | `config.py` offline fixture — fictional |
| `mock-weak` | mock | 0.50 | 1.50 | `config.py` offline fixture — fictional |

`config.py` stores per-1k prices; cards store per-MTok, the unit providers publish in
and the unit §2 froze. The conversion is ×1000 and is asserted against `config.py` for
all four models by `test_catalog_rates_match_configs_registered_prices`.

The §2 artifact is read as a **document**. There is no import.

---

## 2. Unknown is never zero

Three statuses, and the distinction is the reason the module exists:

- **`KNOWN`** — the source states a rate. It may legitimately be zero.
- **`UNKNOWN`** — no rate available. Never treated as zero.
- **`UNSUPPORTED`** — the provider does not offer this category for this model.

**Cache read and cache write are `UNKNOWN` for all four models.** No cache price
appears anywhere in this repository, and `ModelSpec` has no cache fields at all.
Assuming zero, or assuming parity with the input rate, would produce a total that
looks authoritative and is not.

Behaviour:

| Situation | Result |
|---|---|
| tokens > 0, rate `UNKNOWN` | `MissingRateError` — quote fails closed |
| tokens > 0, rate `UNSUPPORTED` | `UnsupportedUsageError` |
| tokens = 0, rate not known | component `NOT_APPLICABLE`, `cost=None`, warning recorded |
| tokens = 0, rate known | component `PRICED` at zero |

The zero-token case is reported as *not applicable*, not as *priced at zero* — the
same card still cannot price non-zero usage there, and the quote says so.

`is_fully_priced` asserts that every category **carrying tokens** was priced.
`has_unpriceable_categories` reports that the card lacks some rate. A quote can be —
and with this catalog always is — both fully priced and missing cache rates.

---

## 3. Multi-model: the G2 rule, fixed in the product

A `CostQuote` is **single-model**. `quote_many` builds one complete quote per model on
that model's own card. Comparison happens over whole quotes:

```python
qs = calc.quote_many(usage, model_ids=["claude-opus-4-8", "claude-haiku-4-5"])
qs.dearest()    # the opus quote, entire
qs.cheapest()   # the haiku quote, entire
```

`dearest()` returns a quote, never a synthetic worst case assembled from the maximum
of each rate independently. On 1M in + 1M out that distinction is $30 (opus, real)
versus $26 (haiku input + opus output, a price nobody charges). That blend was G2 in
the orchestrator; `test_comparison_selects_a_whole_quote_never_a_blend_of_rates` pins
it shut here.

---

## 4. Precision and rounding

`Decimal` on the entire money path. `Money` refuses float construction outright.

Rates are stored as **strings** so the source of truth stays exact and reviewable, and
are converted on use. Nothing is rounded inside the calculator: the per-token rate is
not rounded before scaling, and no component is rounded before it joins the total. One
input token on Haiku costs `1/1e6` USD and stays non-zero.

`total` is always the sum of `components` — validated on construction, not assumed.
Rounding exists only as `display_total(places)`, and its output never re-enters a
calculation.

---

## 5. The legacy `ModelSpec` boundary — risk **reduced, not closed**

`ModelSpec.price_per_1k_in/out` are declared `float` in `models.py`, and P1a is not
authorised to change them. `compat.py` is the single place a float is permitted, and
it converts through `Decimal(str(x))`, never `Decimal(x)`:

```
Decimal(0.005)      -> 0.005000000000000000104083408558...
Decimal(str(0.005)) -> 0.005
```

`Decimal(float)` faithfully reproduces the binary approximation the float already is;
`str()` first renders the shortest decimal that round-trips — the number a human wrote.

**This narrows the blast radius. It does not remove it.** While the source fields are
`float`, a price that cannot be written exactly in binary has already lost precision
before the adapter sees it. All four current prices survive the round trip exactly,
asserted by `test_legacy_adapter_introduces_no_binary_float_artifact` and by parity
with the curated catalog. Closing the risk means changing `ModelSpec` — P1b+ work,
needing its own review.

A static test also forbids `Decimal(<float literal>)` anywhere in the package.

---

## 6. Versioning and reproducibility

Every card is sealed with a content hash; the catalog verifies all hashes on
construction and rejects two open-ended cards for one model. Every quote records
`pricing_version`, `catalog_version`, `card_id` and `card_content_hash`.

A price change means a **new card** with a new `effective_from` and the old one closed
with `effective_until` — never an edit in place. `reprice()` resolves by *card hash*,
not by model id, so a later price change cannot rewrite what an old quote said.
`test_a_price_change_does_not_rewrite_a_historical_quote` walks exactly that.

`canonical_json()` renders all amounts as strings — a canonical form that round-trips
through binary floating point is not canonical — and `audit_hash()` is stable across
runs. No clock, no randomness, no network.

---

## 7. Currency

No conversion in P1a. Quotes keep the provider's currency (USD for all four cards),
and `Money` refuses to combine currencies rather than converting silently. `QuoteSet`
rejects a mixed-currency set.

Displaying ₪ needs an FX source, rate date, rate version, confidence range and audit
trail. That is a separate module and is not part of this phase.

---

## 8. What pricing is not allowed to do

`PricingSource` describes prices. It does **not** check provider credits, decide
whether a run is authorised, open a budget override, or start execution. A test
asserts the public surface contains no such verb and that `CostCalculator` has no
`admit`.

Provider credits remain what §2 called them: operator-reported runtime state, not a
cap and not permission to spend.

---

## 9. Reserve

The G2 inflation is **not** reintroduced as a safety margin. A wrong per-token rate is
not a contingency; it is a wrong rate that happens to err upward.

If a reserve is wanted it must be an explicit, separate component —
`quoted cost + explicit reserve` — attached to `BudgetPolicy`. Not implemented here;
it belongs to P1c.

---

## 10. Worked example

120,000 input + 4,000 output on `claude-haiku-4-5` at $1.00 / $5.00 per MTok:

```
input   120_000 / 1e6 x 1.00  = 0.12 USD   PRICED
output    4_000 / 1e6 x 5.00  = 0.02 USD   PRICED
cache_read      0 tokens      = —          NOT_APPLICABLE (rate UNKNOWN)
cache_write     0 tokens      = —          NOT_APPLICABLE (rate UNKNOWN)
                                total       0.14 USD

pricing_version   product-pricing-v1
catalog_version   catalog-2026-07-29
card_id           anthropic/claude-haiku-4-5@v1
rounding_policy   none
unresolved        [cache_read, cache_write]
```

Asserted end to end by `test_worked_example_quote`.

---

## 11. Open

- **11.1 package location** — still provisional under `planner/pricing/`.
- **`ModelSpec` float fields** — open, narrowed. See §5.
- **Cache rates** — `UNKNOWN` for every model until a citable source exists.
- **Reserve / contingency** — deferred to P1c.
- **Currency presentation** — deferred, needs its own module.
