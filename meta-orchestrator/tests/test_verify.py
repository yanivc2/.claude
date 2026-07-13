"""B1: verify() returns the uniform shape and correctly detects success/failure."""
from __future__ import annotations

from meta_orchestrator.models import FailureCategory
from meta_orchestrator.seed_task.corpus import get_case
from meta_orchestrator.verification import verify_code_fix


def test_reference_fix_passes():
    case = get_case("off_by_one_sum")
    res = verify_code_fix(case, case.reference_fix)
    assert res.passed is True
    assert res.failure_category == FailureCategory.NONE
    assert res.confidence == 1.0
    assert res.blocking is True
    assert res.evidence  # non-empty pytest summary


def test_buggy_source_fails_as_tests_failed():
    case = get_case("wrong_operator_even")
    res = verify_code_fix(case, case.module_source)
    assert res.passed is False
    assert res.failure_category == FailureCategory.TESTS_FAILED
    assert res.blocking is True


def test_syntax_error_is_factual_error():
    case = get_case("off_by_one_sum")
    res = verify_code_fix(case, "def sum_to(n)\n    return 0\n")  # missing colon
    assert res.passed is False
    assert res.failure_category == FailureCategory.FACTUAL_ERROR
    assert any("SyntaxError" in e for e in res.evidence)


def test_result_shape_is_uniform():
    case = get_case("wrong_return_max")
    res = verify_code_fix(case, case.reference_fix)
    # exactly the §5.4 contract
    assert set(res.model_dump().keys()) == {
        "passed", "confidence", "evidence", "blocking", "failure_category"
    }
