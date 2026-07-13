"""Physical two-zone isolation (v2-corpus §6).

The agent zone materialises ONLY buggy source + PUBLIC tests + the sanitized statement —
no hidden tests, no reference, no .git. Hidden tests exist only evaluator-side: after the
agent produces a patch, the evaluator materialises a SEPARATE zone (patched source +
public + hidden) and runs the fixed composite verifier there. So grep/git/metadata in the
agent zone can never reach the held-out signal.
"""
from __future__ import annotations

from ..experiment.sandbox import Sandbox
from ..experiment.task import PUBLIC_DIR, ExperimentTask
from ..experiment.verifier import Verdict, verify
from .models import CorpusTask


def to_agent_task(task: CorpusTask) -> ExperimentTask:
    """The runtime task the AGENT sees — hidden tests are absent (empty), not just hidden."""
    return ExperimentTask(
        task_id=task.task_id,
        task_family=task.task_family,
        source=dict(task.buggy_source),
        public_tests=dict(task.public_tests),
        hidden_tests={},                                  # ← physically none in the agent zone
        protected_prefixes=[PUBLIC_DIR],
        max_changed_files=max(1, len(task.buggy_source)),
        static_targets=list(task.buggy_source),
    )


def _eval_task(task: CorpusTask) -> ExperimentTask:
    return ExperimentTask(
        task_id=task.task_id,
        task_family=task.task_family,
        source=dict(task.buggy_source),                   # baseline to diff the patch against
        public_tests=dict(task.public_tests),
        hidden_tests=dict(task.hidden_tests),             # ← only here, evaluator-side
        max_changed_files=max(1, len(task.buggy_source)),
        static_targets=list(task.buggy_source),
    )


def evaluate_patch(task: CorpusTask, patched_source: dict[str, str]) -> Verdict:
    """Run the fixed composite verifier over the agent's patch in the evaluator zone."""
    et = _eval_task(task)
    with Sandbox(et) as sb:
        for path, content in patched_source.items():
            if path in task.buggy_source:                 # ignore any out-of-scope writes here
                sb.write(path, content)
        return verify(et, sb)
