"""Authoritative Gate-1 evidence run (real count_tokens, $0 — NO paid Messages call, NO anchor).

Pinned pilot env only. Gathers REAL PytestEvidence from a full-suite JUnit run, builds the real
anthropic client + S2ModelClient request path, resolves the live endpoint attestation, then calls
the thin ``gate1_runner.run_gate1`` which feeds the FROZEN ``gate1_from_evidence``. It prints the
Gate-1 report + writes the run artifact to the scratch dir. It authorises nothing and never mints an
authorization anchor. Requires ``META_ORCH_API_KEY`` (value never logged).

Usage: python examples/s2_gate1_real.py <out_dir>
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.abspath(os.path.join(HERE, ".."))
CORPUS = os.path.join(HERE, "corpus")
CORPUS_JSON = os.path.join(CORPUS, "s2_real_corpus.json")
SCOPE_JSON = os.path.join(CORPUS, "s2_scope_metadata.json")
MODEL = "claude-haiku-4-5-20251001"
REQUIRED = ["tests/test_s2_prepaid.py::test_sdk_serialized_body_omits_effort_and_temperature",
            "tests/test_s2_prepaid.py::test_sdk_max_retries_zero_means_one_http_request"]


def _gather_pytest_evidence(out_dir: str, env_hash: str, git_commit: str):
    from meta_orchestrator.experiment.s2.evidence import PytestEvidence
    xml_path = os.path.join(out_dir, "junit.xml")
    proc = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
                           f"--junitxml={xml_path}"], cwd=HERE, capture_output=True, text=True)
    root = ET.parse(xml_path).getroot()
    suite = root if root.tag == "testsuite" else root.find("testsuite")
    failed = int(suite.get("failures", 0)) + int(suite.get("errors", 0))
    skipped = int(suite.get("skipped", 0))
    passed_ids: list[str] = []
    for tc in suite.iter("testcase"):
        if tc.find("failure") is None and tc.find("error") is None and tc.find("skipped") is None:
            cls, name = tc.get("classname", ""), tc.get("name", "")
            passed_ids.append(cls.replace(".", "/") + ".py::" + name if cls else name)
    import anthropic  # noqa: F401 — proves the SDK is installed in the pinned env
    import httpx
    return PytestEvidence(
        run_id="s2-gate1-real", environment_hash=env_hash, git_commit=git_commit,
        exit_code=proc.returncode, failed=failed, skipped=skipped, passed_node_ids=passed_ids,
        sdk_version=__import__("anthropic").__version__, httpx_version=httpx.__version__,
        command_hash=hashlib.sha256(b"pytest -q --junitxml").hexdigest()[:12]).sealed()


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "_gate1_out")
    os.makedirs(out_dir, exist_ok=True)

    import anthropic

    from meta_orchestrator.experiment.s2 import gate1_runner as G
    from meta_orchestrator.experiment.s2.budget_policy import ReportedCredits
    from meta_orchestrator.experiment.s2.endpoint import resolve_endpoint_attestation
    from meta_orchestrator.experiment.s2.evidence import attest_environment
    from meta_orchestrator.experiment.s2.model_client import S2ModelClient

    key = os.environ.get("META_ORCH_API_KEY")
    if not key:
        raise SystemExit("META_ORCH_API_KEY not set — the pilot env must provide it")
    base_url = os.environ.get("META_ORCH_API_BASE_URL", "https://api.anthropic.com")
    client = anthropic.Anthropic(api_key=key, base_url=base_url, max_retries=0)

    att = attest_environment(repo_root=REPO_ROOT, required_env_vars=["META_ORCH_API_KEY"])
    env_hash = hashlib.sha256(json.dumps(att.model_dump(), sort_keys=True).encode()).hexdigest()[:16]
    git_commit = att.git_commit

    endpoint_att = resolve_endpoint_attestation(provider="anthropic", model=MODEL, client=client)
    request_builder = S2ModelClient(client=client)          # frozen contract kwargs builder
    count_fn = G.real_count_fn(client)

    print("gathering real PytestEvidence (full suite, JUnit)…")
    pytest_ev = _gather_pytest_evidence(out_dir, env_hash, git_commit)
    print(f"  suite: exit={pytest_ev.exit_code} failed={pytest_ev.failed} skipped={pytest_ev.skipped} "
          f"passed_nodes={len(pytest_ev.passed_node_ids)}")

    # Operator-reported credit balance (runtime state, NOT a policy cap). Approved caps live in the
    # frozen s2_budget_policy.frozen.json (fold-1 $10 / global $50).
    credits = ReportedCredits(available_api_credits_usd="4.674016", verified_at="2026-07-20",
                              machine_verified=False)

    print("running real count_tokens Gate-1 preflight over the frozen corpus ($0)…")
    art = G.run_gate1(
        corpus_json_path=CORPUS_JSON, scope_json_path=SCOPE_JSON, corpus_dir=CORPUS,
        cache_dir=os.path.join(out_dir, "src_cache"), request_builder=request_builder,
        count_fn=count_fn, model=MODEL, count_model=MODEL,
        endpoint_attestation=endpoint_att.model_dump(), pytest_ev=pytest_ev, env_hash=env_hash,
        reported_credits=credits, run_id="s2-gate1-real", git_commit=git_commit,
        required_node_ids=REQUIRED, heldout_fold=1)

    art_path = os.path.join(out_dir, "gate1_artifact.json")
    json.dump(art.model_dump(), open(art_path, "w"), indent=2)

    r = art.gate_report
    print("=" * 78)
    print(f"GATE 1 (real, evidence-based, NON-AUTHORITATIVE) — passed={r['passed']} "
          f"production_valid={r['production_valid']} source={r['token_count_source']}")
    print(f"context_cap={art.context_cap}  estimated_max={art.estimated_max_tokens}  "
          f"headroom={art.headroom}  fits_model_context={art.fits_model_context}")
    print(f"max_envelope_overshoot={art.max_overshoot_seen} (floor={art.envelope_floor})")
    bp = art.budget_policy
    print(f"budget policy [{art.budget_policy_hash}]: fold1_cap=${bp.get('fold1_hard_cap_usd')} "
          f"global_cap=${bp.get('global_hard_cap_usd')}  "
          f"credits(reported, not a cap)=${art.reported_credits.get('available_api_credits_usd')}")
    print(f"fold-{art.heldout_fold} train tasks={len(art.train_task_ids)}  "
          f"worst+25%=${art.projection.get('worst_fold_cost_with_reserve_usd')} (<= fold1_cap)")
    print(f"experiment worst+25%=${art.experiment_projection.get('experiment_worst_with_reserve_usd')} "
          f"(<= global_cap)")
    print(f"actual_spend_to_date=${art.actual_spend_to_date_usd}  "
          f"lifetime_worst+reserve=${art.lifetime_worst_with_reserve_usd}  "
          f"global_headroom=${art.global_headroom_usd}  (paid_spend[{art.paid_spend_ledger_hash}])")
    print(f"max_single_call_exposure=${art.projection.get('max_single_call_exposure_usd')}")
    print("gate reasons:", r["reasons"] or "none")
    print("blocking notes:", art.blocking_notes or "none")
    print(f"artifact → {art_path}")
    print("NO anchor minted · NO messages.create · manifest stays UNAUTHORIZED_FOR_MESSAGES")
    print("=" * 78)


if __name__ == "__main__":
    main()
