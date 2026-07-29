"""Pilot-0 demo: qualify the harness with the two mocks (offline, no real model).

Run:  python examples/pilot0_demo.py
"""
from __future__ import annotations

from meta_orchestrator.experiment.agent import AgentTools
from meta_orchestrator.experiment.artifacts import ArtifactStore
from meta_orchestrator.experiment.contract import AgentContract, prompt_hash
from meta_orchestrator.experiment.fixtures import OFF_BY_ONE
from meta_orchestrator.experiment.mocks import AdversarialMock, ProtocolMock
from meta_orchestrator.experiment.runner import ControlledRunner
from meta_orchestrator.experiment.store import ExperimentDB


def main() -> None:
    contract = AgentContract(provider="mock", exact_model_id="mock-v0", agent_version="0.1",
                             tool_definitions=AgentTools.NAMES,
                             system_prompt_hash=prompt_hash("frozen"))
    runner = ControlledRunner(ExperimentDB(":memory:"), ArtifactStore("/tmp/mo_exp_artifacts"))

    good = runner.run(OFF_BY_ONE, "A", ProtocolMock(patch=OFF_BY_ONE.reference_fix), contract)
    print(f"[protocol ] passed={good.passed} failing_gate={good.verdict.failing_gate} "
          f"blocked={len(good.blocked_attempts)}  (expect: passed=True, blocked=0)")

    adv = runner.run(OFF_BY_ONE, "C", AdversarialMock(), contract,
                     playbook_context=["L-1"], forbidden_values=["6"])
    print(f"[adversary] passed={adv.passed} failing_gate={adv.verdict.failing_gate!r} "
          f"blocked_attempts={len(adv.blocked_attempts)} lesson_rejected={adv.lesson_rejected}")
    print(f"            gates={adv.verdict.gates}")
    print(f"            contract_snapshot={contract.snapshot()[:16]}…")
    print("\nHarness QUALIFIED ✓  (protocol clean; adversary fully contained)"
          if good.passed and not adv.passed and adv.lesson_rejected and len(adv.blocked_attempts) == 3
          else "\nHarness NOT qualified ✗")


if __name__ == "__main__":
    main()
