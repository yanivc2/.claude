"""Corpus ingestion demo (fixture source): §3 candidate report + §6 isolation proof.

Run:  python examples/corpus_demo.py
"""
from __future__ import annotations

from meta_orchestrator.corpus.build import build_corpus_task
from meta_orchestrator.corpus.evaluator import evaluate_patch, to_agent_task
from meta_orchestrator.corpus.fixture_source import FixtureCorpusSource
from meta_orchestrator.corpus.report import build_report
from meta_orchestrator.experiment.sandbox import Sandbox

src = FixtureCorpusSource()


def main() -> None:
    print("=== §3 candidate qualification report (source=fixture) ===")
    report = build_report(src)
    print(f"total={report.total_candidates} admitted={report.admitted}")
    for r in report.rows:
        print(f"  {r.candidate_id:20s} admitted={r.admitted!s:5s} "
              f"F2P={r.valid_f2p} P2P={r.clean_p2p} usable_desc={r.description_usable!s:5s} "
              f"patch={r.patch_files}f/{r.patch_lines}l  reason={r.reason}")
    print(f"  note: {report.note}")

    print("\n=== §6 physical isolation (fx-sum-offbyone) ===")
    task = build_corpus_task(src.get("fx-sum-offbyone"))
    agent_task = to_agent_task(task)
    with Sandbox(agent_task) as sb:
        blob = "".join(p.read_text() for p in sb.root.rglob("*") if p.is_file())
    print(f"  agent zone hidden_tests={agent_task.hidden_tests}  "
          f"(hidden probe present in agent zone? {'sum_to(5) == 15' in blob})")
    print(f"  sanitized statement given to agent: {task.problem_statement_sanitized!r}")
    print(f"  sanitization_log: {task.sanitization_log}")

    print("\n=== evaluator runs hidden tests on the patch ===")
    for label, patched in [("buggy(unchanged)", task.buggy_source),
                           ("correct fix", {"solution.py": "def sum_to(n):\n    return sum(range(1, n + 1))\n"}),
                           ("hardcode 15", {"solution.py": "def sum_to(n):\n    return 15\n"})]:
        v = evaluate_patch(task, patched)
        print(f"  {label:18s} → passed={v.passed!s:5s} failing_gate={v.failing_gate}")


if __name__ == "__main__":
    main()
