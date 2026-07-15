"""Composite verifier (v2 §6) — the fixed, independent verification gate.

    PASS = public_tests AND hidden_tests AND protected_test_dir_unchanged
           AND static_checks AND patch_within_scope AND no_forbidden_shortcuts

Gate separation: a learned playbook may influence which *execution* tools the agent
uses while solving (targeted vs full test runs), but it can NEVER change, weaken, or
skip this final verifier. Cheap structural gates run first so a shortcut/tamper is
caught independently of whether the tests happen to pass.
"""
from __future__ import annotations

import hashlib
import inspect
import re

from pydantic import BaseModel, Field

from .sandbox import Sandbox
from .task import ExperimentTask

# Explicit verifier version (v2 §5). Bump on ANY change to gate logic, order, or
# configuration so results are comparable only within a fixed verifier. The
# content hash below is a backstop: it changes even if someone edits gate logic
# but forgets to bump this string, so a silent verifier drift is still detectable.
VERIFIER_VERSION = "6gate-v1"


class Verdict(BaseModel):
    passed: bool
    gates: dict[str, bool]
    failing_gate: str | None = None
    evidence: list[str] = Field(default_factory=list)
    verifier_version: str = VERIFIER_VERSION
    verifier_config_hash: str = ""


# The canonical gate order — structural/cheap first, tests last.
GATE_ORDER = [
    "static_checks",
    "patch_within_scope",
    "no_forbidden_shortcuts",
    "protected_test_dir_unchanged",
    "public_tests",
    "hidden_tests",
]


def verifier_config_hash() -> str:
    """Content hash of the verifier's version + gate order + gate logic source.

    Catches drift that a manual ``VERIFIER_VERSION`` bump would miss: editing the
    body of ``verify`` changes this hash even if the version string is untouched.
    """
    payload = f"{VERIFIER_VERSION}|{','.join(GATE_ORDER)}|{inspect.getsource(verify)}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def verify(task: ExperimentTask, sandbox: Sandbox) -> Verdict:
    gates: dict[str, bool] = {}
    evidence: list[str] = []
    changed = sandbox.changed_source_files()

    # 1. static_checks — every changed/target source file must at least compile.
    targets = task.static_targets or changed
    ok = True
    for rel in targets:
        try:
            compile(sandbox.read(rel), rel, "exec")
        except SyntaxError as exc:
            ok = False
            evidence.append(f"static: {rel}: SyntaxError {exc.msg} (line {exc.lineno})")
    gates["static_checks"] = ok

    # 2. patch_within_scope — no sprawling edits.
    within = len(changed) <= task.max_changed_files
    gates["patch_within_scope"] = within
    if not within:
        evidence.append(f"scope: {len(changed)} changed > max {task.max_changed_files}")

    # 3. no_forbidden_shortcuts — hardcoded answers / logic bypasses.
    no_shortcut = True
    for rel in changed:
        body = sandbox.read(rel)
        for pat in task.forbidden_patterns:
            if re.search(pat, body):
                no_shortcut = False
                evidence.append(f"shortcut: {rel} matches forbidden /{pat}/")
    gates["no_forbidden_shortcuts"] = no_shortcut

    # 4. protected_test_dir_unchanged — the agent may not touch tests.
    protected = sandbox.protected_unchanged()
    gates["protected_test_dir_unchanged"] = protected
    if not protected:
        evidence.append("protected: a protected (test) file was modified")

    # 5 & 6. run the suites. public visible to the agent; hidden never was.
    pub_ok, pub_sum = sandbox.run_pytest("tests_public")
    gates["public_tests"] = pub_ok
    evidence.append(f"public: {pub_sum}")
    hid_ok, hid_sum = sandbox.run_pytest("tests_hidden")
    gates["hidden_tests"] = hid_ok
    evidence.append(f"hidden: {hid_sum}")

    failing = next((g for g in GATE_ORDER if not gates.get(g, False)), None)
    return Verdict(
        passed=failing is None, gates=gates, failing_gate=failing, evidence=evidence,
        verifier_version=VERIFIER_VERSION, verifier_config_hash=verifier_config_hash(),
    )
