"""P1a: product pricing — catalog, calculator, quote, legacy adapter.

Pure and offline: no network, no clock, no database. Every assertion is about a
property the module promises, not about the shape of a dataclass.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from meta_orchestrator.config import seed_registry_models
from meta_orchestrator.planner.contracts.money import Money
from meta_orchestrator.planner.pricing import (
    CATALOG_VERSION,
    PRICING_VERSION,
    CatalogIntegrityError,
    ComponentStatus,
    CostCalculator,
    CurrencyMismatchError,
    MissingRateError,
    PriceCard,
    PriceCardNotFoundError,
    PriceRate,
    PricingCatalog,
    PricingUnit,
    QuoteSet,
    RateStatus,
    RoundingPolicy,
    TokenUsage,
    UnsupportedUsageError,
    UsageCategory,
    price_card_from_model_spec,
)

IN, OUT = UsageCategory.INPUT, UsageCategory.OUTPUT
CR, CW = UsageCategory.CACHE_READ, UsageCategory.CACHE_WRITE


@pytest.fixture
def calc() -> CostCalculator:
    return CostCalculator()


def _card(**over) -> PriceCard:
    base = dict(
        card_id="test/model@v1", pricing_version="test-v1", provider="test",
        model_id="test-model", currency="USD", unit=PricingUnit.USD_PER_MTOK,
        effective_from="2026-01-01",
        rates={IN: PriceRate.known("1.00"), OUT: PriceRate.known("5.00"),
               CR: PriceRate.unknown(), CW: PriceRate.unknown()},
        source="unit test fixture", source_verified_at="2026-01-01")
    base.update(over)
    return PriceCard(**base).sealed()


# --------------------------------------------------------------------------- #
# Rates — an unknown price is never a number
# --------------------------------------------------------------------------- #

def test_rate_amount_must_be_a_string_not_a_float():
    """A float rate would already have lost precision before it arrived."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="valid string"):
        PriceRate(status=RateStatus.KNOWN, amount=1.0)
    with pytest.raises(ValidationError):
        PriceRate(status=RateStatus.KNOWN, amount=0.003)


def test_rate_amount_must_be_a_well_formed_non_negative_decimal():
    with pytest.raises(ValueError, match="not a decimal"):
        PriceRate(status=RateStatus.KNOWN, amount="one dollar")
    with pytest.raises(ValueError, match="cannot be negative"):
        PriceRate(status=RateStatus.KNOWN, amount="-1.00")


def test_known_rate_must_carry_an_amount_and_others_must_not():
    with pytest.raises(ValueError, match="must carry an amount"):
        PriceRate(status=RateStatus.KNOWN)
    with pytest.raises(ValueError, match="must not carry an amount"):
        PriceRate(status=RateStatus.UNKNOWN, amount="1.00")


def test_unknown_rate_refuses_to_produce_a_per_token_price():
    with pytest.raises(ValueError, match="cannot take a per-token rate"):
        PriceRate.unknown().per_token()


def test_an_explicit_zero_rate_is_legitimate():
    """Zero is a price when the source says so — only inference of zero is banned."""
    assert PriceRate.known("0").per_token() == Decimal(0)


def test_rate_conversion_is_exact():
    assert PriceRate.known("3.00").per_token() == Decimal("3") / Decimal(1_000_000)


# --------------------------------------------------------------------------- #
# Cards and catalog
# --------------------------------------------------------------------------- #

def test_a_card_must_state_every_category():
    with pytest.raises(ValueError, match="omits"):
        PriceCard(card_id="c", pricing_version="v", provider="p", model_id="m",
                  effective_from="2026-01-01", rates={IN: PriceRate.known("1")},
                  source="s", source_verified_at="2026-01-01")


def test_hand_editing_a_sealed_card_is_detected():
    card = _card()
    tampered = card.model_copy(update={"rates": {**card.rates, IN: PriceRate.known("999")}})
    with pytest.raises(CatalogIntegrityError, match="hash mismatch"):
        tampered.verify_hash()


def test_catalog_rejects_two_open_ended_cards_for_one_model():
    a = _card(card_id="a@v1")
    b = _card(card_id="b@v2")
    with pytest.raises(CatalogIntegrityError, match="open-ended cards"):
        PricingCatalog(cards=[a, b])


def test_missing_model_fails_closed(calc):
    with pytest.raises(PriceCardNotFoundError):
        calc.quote(TokenUsage(input_tokens=10), model_id="no-such-model")


def test_catalog_holds_exactly_the_models_registered_in_config(calc):
    registered = {s.model_id for s in seed_registry_models("anthropic")}
    registered |= {s.model_id for s in seed_registry_models("mock")}
    assert set(calc.catalog.model_ids()) == registered


def test_effective_dating_selects_the_card_in_force():
    old = _card(card_id="old@v1", effective_from="2026-01-01",
                effective_until="2026-06-01")
    new = _card(card_id="new@v2", effective_from="2026-06-01",
                rates={IN: PriceRate.known("2.00"), OUT: PriceRate.known("9.00"),
                       CR: PriceRate.unknown(), CW: PriceRate.unknown()})
    cat = PricingCatalog(cards=[old, new])
    assert cat.card_for("test-model", at="2026-03-01").card_id == "old@v1"
    assert cat.card_for("test-model", at="2026-07-01").card_id == "new@v2"


# --------------------------------------------------------------------------- #
# Parity with config.py — no invented prices
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("adapter", ["anthropic", "mock"])
def test_catalog_rates_match_configs_registered_prices(calc, adapter):
    """Every rate must equal config.py's per-1k price x 1000, exactly."""
    for spec in seed_registry_models(adapter):
        card = calc.catalog.card_for(spec.model_id)
        assert card.rate_for(IN).per_token() == (
            Decimal(str(spec.price_per_1k_in)) / Decimal(1000))
        assert card.rate_for(OUT).per_token() == (
            Decimal(str(spec.price_per_1k_out)) / Decimal(1000))


def test_haiku_matches_the_frozen_s2_pricing_artifact(calc):
    """corpus/s2_pricing.frozen.json: $1.00 in / $5.00 out per MTok. Read, not imported."""
    card = calc.catalog.card_for("claude-haiku-4-5")
    assert card.rate_for(IN).amount == "1.00"
    assert card.rate_for(OUT).amount == "5.00"
    assert card.provider_model_snapshot == "claude-haiku-4-5-20251001"


def test_every_model_has_cache_rates_unknown_rather_than_zero(calc):
    """No cache price exists anywhere in this repo. None was invented."""
    for model_id in calc.catalog.model_ids():
        card = calc.catalog.card_for(model_id)
        assert card.rate_for(CR).status is RateStatus.UNKNOWN
        assert card.rate_for(CW).status is RateStatus.UNKNOWN
        assert card.rate_for(CR).amount is None


# --------------------------------------------------------------------------- #
# Calculation
# --------------------------------------------------------------------------- #

def test_input_and_output_are_priced_at_their_own_rates(calc):
    q = calc.quote(TokenUsage(input_tokens=1_000_000, output_tokens=1_000_000),
                   model_id="claude-haiku-4-5")
    assert q.cost_of(IN) == Money(amount=Decimal("1"), currency="USD")
    assert q.cost_of(OUT) == Money(amount=Decimal("5"), currency="USD")
    assert q.total == Money(amount=Decimal("6"), currency="USD")


def test_total_is_exactly_the_sum_of_the_components(calc):
    q = calc.quote(TokenUsage(input_tokens=12_345, output_tokens=6_789),
                   model_id="claude-opus-4-8")
    summed = sum((q.cost_of(c).amount for c in UsageCategory), Decimal(0))
    assert q.total.amount == summed


def test_no_rounding_happens_in_the_core(calc):
    """A single token must not be truncated to zero on its way into the total."""
    q = calc.quote(TokenUsage(input_tokens=1), model_id="claude-haiku-4-5")
    assert q.total.amount == Decimal("1") / Decimal(1_000_000)
    assert q.total.amount > 0
    assert q.rounding_policy is RoundingPolicy.NONE


def test_rounding_is_available_for_display_only(calc):
    q = calc.quote(TokenUsage(input_tokens=1), model_id="claude-haiku-4-5")
    assert q.display_total("0.01").amount == Decimal("0.00")
    assert q.total.amount > 0            # the core figure is untouched


def test_billing_tokens_against_an_unknown_rate_fails_closed(calc):
    """The rule the whole module exists for: unknown is not zero."""
    with pytest.raises(MissingRateError, match="refusing to assume zero"):
        calc.quote(TokenUsage(input_tokens=100, cache_read_tokens=50),
                   model_id="claude-haiku-4-5")


def test_unsupported_usage_raises_its_own_error():
    card = _card(rates={IN: PriceRate.known("1.00"), OUT: PriceRate.known("5.00"),
                        CR: PriceRate.unsupported(), CW: PriceRate.unknown()})
    calc = CostCalculator(PricingCatalog(cards=[card]))
    with pytest.raises(UnsupportedUsageError):
        calc.quote(TokenUsage(cache_read_tokens=1), model_id="test-model")


def test_zero_usage_in_an_unpriced_category_is_not_applicable_not_priced_zero(calc):
    q = calc.quote(TokenUsage(input_tokens=100), model_id="claude-haiku-4-5")
    cache = q.component(CR)
    assert cache.status is ComponentStatus.NOT_APPLICABLE
    assert cache.cost is None                     # not Money(0)
    assert q.has_unpriceable_categories is True
    assert q.is_fully_priced is True              # the usage given was fully priced


def test_zero_usage_in_a_priced_category_costs_zero(calc):
    q = calc.quote(TokenUsage(input_tokens=0, output_tokens=10),
                   model_id="claude-haiku-4-5")
    assert q.component(IN).status is ComponentStatus.PRICED
    assert q.cost_of(IN) == Money.zero("USD")


def test_more_usage_at_the_same_rate_never_costs_less(calc):
    prev = Decimal(-1)
    for n in (0, 1, 1_000, 1_000_000, 5_000_000):
        total = calc.quote(TokenUsage(input_tokens=n),
                           model_id="claude-opus-4-8").total.amount
        assert total > prev or (n == 0 and total == 0)
        prev = total


def test_calculation_is_deterministic(calc):
    usage = TokenUsage(input_tokens=4_321, output_tokens=1_234)
    a = calc.quote(usage, model_id="claude-opus-4-8")
    b = calc.quote(usage, model_id="claude-opus-4-8")
    assert a.canonical_json() == b.canonical_json()
    assert a.audit_hash() == b.audit_hash()


def test_canonical_serialization_renders_money_as_strings(calc):
    q = calc.quote(TokenUsage(input_tokens=1), model_id="claude-haiku-4-5")
    payload = q.canonical_payload()
    assert isinstance(payload["total"], str)
    assert all(c["cost"] is None or isinstance(c["cost"], str)
               for c in payload["components"])


# --------------------------------------------------------------------------- #
# Provenance and reproducibility
# --------------------------------------------------------------------------- #

def test_a_quote_records_the_version_and_card_it_was_priced_under(calc):
    q = calc.quote(TokenUsage(input_tokens=10), model_id="claude-haiku-4-5")
    assert q.pricing_version == PRICING_VERSION
    assert q.catalog_version == CATALOG_VERSION
    assert q.card_content_hash == calc.catalog.card_for("claude-haiku-4-5").content_hash


def test_a_price_change_does_not_rewrite_a_historical_quote():
    """Reprice resolves by card hash, so an old quote re-derives to its old figure."""
    old = _card(card_id="m@v1", effective_from="2026-01-01",
                effective_until="2026-06-01")
    new = _card(card_id="m@v2", effective_from="2026-06-01",
                rates={IN: PriceRate.known("99.00"), OUT: PriceRate.known("99.00"),
                       CR: PriceRate.unknown(), CW: PriceRate.unknown()})
    calc = CostCalculator(PricingCatalog(cards=[old, new]))

    historical = calc.quote(TokenUsage(input_tokens=1_000_000),
                            model_id="test-model", at="2026-03-01")
    assert historical.total.amount == Decimal("1")

    current = calc.quote(TokenUsage(input_tokens=1_000_000), model_id="test-model",
                         at="2026-07-01")
    assert current.total.amount == Decimal("99")

    assert calc.reprice(historical).total.amount == Decimal("1")


# --------------------------------------------------------------------------- #
# Multi-model — the G2 rule, fixed in the product module
# --------------------------------------------------------------------------- #

def test_each_model_gets_its_own_complete_quote(calc):
    usage = TokenUsage(input_tokens=1_000_000, output_tokens=1_000_000)
    qs = calc.quote_many(usage, model_ids=["claude-opus-4-8", "claude-haiku-4-5"])
    assert [q.model_id for q in qs.quotes] == ["claude-opus-4-8", "claude-haiku-4-5"]
    assert qs.for_model("claude-opus-4-8").total.amount == Decimal("30")   # 5 + 25
    assert qs.for_model("claude-haiku-4-5").total.amount == Decimal("6")   # 1 + 5


def test_comparison_selects_a_whole_quote_never_a_blend_of_rates(calc):
    """A hybrid of opus output and haiku input would be 26 — G2 in a new place."""
    usage = TokenUsage(input_tokens=1_000_000, output_tokens=1_000_000)
    qs = calc.quote_many(usage, model_ids=["claude-opus-4-8", "claude-haiku-4-5"])

    dearest = qs.dearest()
    assert dearest.model_id == "claude-opus-4-8"
    assert dearest.total.amount == Decimal("30")
    assert dearest.cost_of(IN).amount == Decimal("5")     # opus input, not haiku's
    assert qs.cheapest().model_id == "claude-haiku-4-5"

    blended = min(q.cost_of(IN).amount for q in qs.quotes) + \
        max(q.cost_of(OUT).amount for q in qs.quotes)
    assert dearest.total.amount != blended


def test_a_quote_set_refuses_duplicate_models(calc):
    q = calc.quote(TokenUsage(input_tokens=1), model_id="claude-haiku-4-5")
    with pytest.raises(ValueError, match="at most one quote per model"):
        QuoteSet(quotes=[q, q])


def test_a_quote_set_refuses_mixed_currencies(calc):
    usd = calc.quote(TokenUsage(input_tokens=1), model_id="claude-haiku-4-5")
    ils_card = _card(card_id="ils@v1", model_id="ils-model", currency="ILS")
    ils = CostCalculator(PricingCatalog(cards=[ils_card])).quote(
        TokenUsage(input_tokens=1), model_id="ils-model")
    with pytest.raises(CurrencyMismatchError):
        QuoteSet(quotes=[usd, ils])


def test_no_currency_conversion_exists(calc):
    """P1a keeps the provider's currency and offers no way to leave it."""
    q = calc.quote(TokenUsage(input_tokens=1), model_id="claude-haiku-4-5")
    assert q.currency == "USD"
    with pytest.raises(ValueError, match="no conversion is defined"):
        q.total + Money(amount=Decimal("1"), currency="ILS")


# --------------------------------------------------------------------------- #
# Legacy ModelSpec boundary
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("spec", seed_registry_models("anthropic")
                         + seed_registry_models("mock"),
                         ids=lambda s: s.model_id)
def test_legacy_adapter_introduces_no_binary_float_artifact(spec):
    """Decimal(str(x)) keeps the number a human wrote; Decimal(x) would not."""
    card = price_card_from_model_spec(spec, pricing_version="legacy-v1")
    for category, legacy in ((IN, spec.price_per_1k_in), (OUT, spec.price_per_1k_out)):
        amount = Decimal(card.rate_for(category).amount)
        assert amount == Decimal(str(legacy)) * Decimal(1000)
        # The artifact test: the naive conversion would carry a long binary tail.
        assert len(amount.as_tuple().digits) < 12


def test_legacy_adapter_agrees_with_the_curated_catalog(calc):
    for spec in seed_registry_models("anthropic") + seed_registry_models("mock"):
        legacy = price_card_from_model_spec(spec, pricing_version="legacy-v1")
        curated = calc.catalog.card_for(spec.model_id)
        assert legacy.rate_for(IN).per_token() == curated.rate_for(IN).per_token()
        assert legacy.rate_for(OUT).per_token() == curated.rate_for(OUT).per_token()


def test_legacy_adapter_leaves_cache_unknown():
    spec = seed_registry_models("anthropic")[0]
    card = price_card_from_model_spec(spec, pricing_version="legacy-v1")
    assert card.rate_for(CR).status is RateStatus.UNKNOWN
    assert card.rate_for(CW).status is RateStatus.UNKNOWN


def test_legacy_adapter_marks_itself_as_a_compatibility_boundary():
    spec = seed_registry_models("anthropic")[0]
    card = price_card_from_model_spec(spec, pricing_version="legacy-v1")
    assert any("legacy compatibility boundary" in n for n in card.notes)
    assert any("float" in limitation for limitation in card.limitations)


# --------------------------------------------------------------------------- #
# Isolation and purity
# --------------------------------------------------------------------------- #

def _pricing_modules():
    import pathlib

    pkg = (pathlib.Path(__file__).resolve().parents[1]
           / "src" / "meta_orchestrator" / "planner" / "pricing")
    return sorted(pkg.glob("*.py"))


def test_pricing_does_not_import_the_frozen_experiment_tree():
    import ast

    offenders: list[str] = []
    for path in _pricing_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            if any("experiment" in n for n in names):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == [], f"pricing must not import the frozen tree: {offenders}"


def test_pricing_performs_no_network_or_io():
    import ast

    banned = {"socket", "http", "httpx", "requests", "urllib", "anthropic",
              "subprocess", "sqlite3", "ssl", "asyncio"}
    offenders: list[str] = []
    for path in _pricing_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [(node.module or "").split(".")[0]]
            else:
                continue
            hits = banned.intersection(names)
            if hits:
                offenders.append(f"{path.name}:{node.lineno} {sorted(hits)}")
    assert offenders == [], f"pricing must stay offline: {offenders}"


def test_no_float_literal_reaches_a_decimal_constructor():
    """Decimal(0.003) would embed the binary approximation. Only compat may convert,
    and only through Decimal(str(x))."""
    import ast

    offenders: list[str] = []
    for path in _pricing_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and getattr(node.func, "id", "") == "Decimal"):
                continue
            if node.args and isinstance(node.args[0], ast.Constant) \
                    and isinstance(node.args[0].value, float):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == [], f"Decimal() built from a float literal: {offenders}"


def test_pricing_never_decides_whether_a_run_is_allowed():
    """PricingSource describes prices. It does not check credits or authorise spend."""
    from meta_orchestrator.planner import pricing

    forbidden = {"admit", "approve", "authorize", "authorise", "check_credits",
                 "execute", "override", "budget_cap"}
    surface = {name.lower() for name in pricing.__all__}
    assert not (surface & forbidden)
    assert not hasattr(CostCalculator, "admit")


def test_calculator_satisfies_the_pricing_source_port_shape(calc):
    """The P0 port asked for a pricing_ref; the catalog supplies one."""
    ref = calc.pricing_ref()
    assert ref == f"{CATALOG_VERSION}/{PRICING_VERSION}"
    assert ref.strip()


# --------------------------------------------------------------------------- #
# A worked example, kept as documentation
# --------------------------------------------------------------------------- #

def test_worked_example_quote(calc):
    """One realistic quote, asserted end to end.

    120k input + 4k output on Haiku, at $1.00 / $5.00 per MTok:
        input  = 120_000 / 1e6 * 1.00 = 0.12
        output =   4_000 / 1e6 * 5.00 = 0.02
        total                          = 0.14
    """
    q = calc.quote(TokenUsage(input_tokens=120_000, output_tokens=4_000),
                   model_id="claude-haiku-4-5")
    assert q.cost_of(IN).amount == Decimal("0.12")
    assert q.cost_of(OUT).amount == Decimal("0.02")
    assert q.total.amount == Decimal("0.14")
    assert q.model_id == "claude-haiku-4-5"
    assert q.currency == "USD"
    assert q.unresolved == [CR, CW]
    assert q.audit_hash() == calc.quote(
        TokenUsage(input_tokens=120_000, output_tokens=4_000),
        model_id="claude-haiku-4-5").audit_hash()
