"""count_tokens context-cap preflight + the full-request B1 metrics oracle.

Built OFFLINE ($0) and dry-run with the proxy counter; the REAL run happens in the pinned pilot
env where ``count_tokens`` is available. Both the Messages request and the counted request come
from ONE ``CanonicalS2Request`` (canonical.py), and counts flow through a source-isolated
``TokenCounter`` (token_counter.py), so a proxy count can never masquerade as a real one.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Optional

from pydantic import BaseModel, Field

from ..task import ExperimentTask
from .b1_selector import PROXY_SOURCE, MetricsFn
from .canonical import CanonicalS2Request, build_canonical
from .contract_s2 import S2_MAX_TOKENS, S2_SYSTEM_PROMPT
from .memory import SLOT_MAX_CHARS, SLOT_MAX_LINES, FrozenLessonBank, MemoryContext
from .prompt import build_agent_prompt, render_memory_payload
from .token_counter import ProxyTokenCounter, _BaseCounter

MODEL_TOTAL_CONTEXT = 200_000            # Haiku 4.5 context window
HEADROOM_FLOOR = 2048
HEADROOM_FRACTION = 0.10


def _canonical_for(task: ExperimentTask, memory_payload: list[str],
                   public_feedback: Optional[str] = None) -> CanonicalS2Request:
    prompt = build_agent_prompt(source=dict(task.source), public_tests=dict(task.public_tests),
                                memory_payload=memory_payload, public_feedback=public_feedback)
    return build_canonical(prompt=prompt, system=S2_SYSTEM_PROMPT)


def _lesson_lines(lessons) -> list[str]:
    out: list[str] = []
    for l in lessons:
        out.extend(l.recommended_action)
        out.extend(f"avoid: {a}" for a in l.avoid)
    return out


def _payload_for_family(bank: FrozenLessonBank, family: str) -> list[str]:
    mc = MemoryContext(condition="X", component_kind="x", source_family=family,
                       lines=_lesson_lines(bank.lessons_for(family)))
    return render_memory_payload(mc)


def full_request_metrics_fn(
    bank: FrozenLessonBank,
    corpus: dict[str, ExperimentTask],
    *,
    counter: Optional[_BaseCounter] = None,
) -> MetricsFn:
    """B1 oracle counting the COMPLETE R1 request for (task, injected_family). Entries/lines from
    the bank; tokens from the canonical request via the source-isolated ``counter`` (proxy by
    default). The memory-injection point is identical for C and B1, and worst-case R2 appends
    memory-independent transcript, so R1-template parity is the binding parity check."""
    counter = counter or ProxyTokenCounter()

    def metrics(task_id: str, injected_family: str) -> tuple[int, int, int]:
        task = corpus[task_id]
        lessons = bank.lessons_for(injected_family)
        payload = _payload_for_family(bank, injected_family)
        req = _canonical_for(task, payload)
        return len(lessons), len(payload), counter.count(req).tokens

    return metrics


# --- context-cap preflight ---------------------------------------------------------------
class TaskContextCount(BaseModel):
    task_id: str
    condition: str
    round1_tokens: int
    round2_worst_tokens: int


class ContextCapReport(BaseModel):
    token_count_source: str
    estimated_max: int
    headroom: int
    context_cap: int
    max_output_tokens: int = S2_MAX_TOKENS
    model_total_context: int = MODEL_TOTAL_CONTEXT
    fits_model_context: bool
    over_cap_tasks: list[str] = Field(default_factory=list)
    per_request: list[TaskContextCount] = Field(default_factory=list)

    def content_hash(self) -> str:
        return hashlib.sha256(
            json.dumps(self.model_dump(), sort_keys=True).encode()).hexdigest()[:12]


def _max_legal_memory_payload() -> list[str]:
    """The largest memory slot any condition may legally inject (SLOT_MAX_LINES × SLOT_MAX_CHARS)."""
    line = "- " + ("x" * (SLOT_MAX_CHARS - 2))
    return [line for _ in range(SLOT_MAX_LINES)]


def context_cap_preflight(
    corpus: dict[str, ExperimentTask],
    *,
    counter: Optional[_BaseCounter] = None,
    max_public_feedback: Optional[str] = None,
    max_r1_assistant_output: Optional[str] = None,
) -> ContextCapReport:
    """Count worst-case Round-1 and Round-2 legal requests for every task and freeze a cap.

    Worst case uses the MAXIMUM legal memory slot (the real C bank does not exist at preflight),
    the maximum sanitized public feedback, and the maximum prior assistant/tool transcript for R2.
    The report's ``token_count_source`` is the counter's source — a proxy report can NOT open a
    production gate (see gates.assert_context_cap_production_valid).
    """
    counter = counter or ProxyTokenCounter()
    mem = _max_legal_memory_payload()
    feedback = max_public_feedback or ("F" * 2000)
    r1_out = max_r1_assistant_output or ("O" * (S2_MAX_TOKENS * 4))
    per: list[TaskContextCount] = []
    estimated_max = 0
    over: list[str] = []
    for tid, task in corpus.items():
        r1 = counter.count(_canonical_for(task, mem)).tokens
        r2 = counter.count(_canonical_for(task, mem, public_feedback=(r1_out + "\n" + feedback))).tokens
        per.append(TaskContextCount(task_id=tid, condition="worst-case",
                                    round1_tokens=r1, round2_worst_tokens=r2))
        estimated_max = max(estimated_max, r1, r2)
    headroom = max(HEADROOM_FLOOR, math.ceil(HEADROOM_FRACTION * estimated_max))
    context_cap = int(math.ceil((estimated_max + headroom) / 1024) * 1024)
    fits = context_cap + S2_MAX_TOKENS <= MODEL_TOTAL_CONTEXT
    for p in per:
        if max(p.round1_tokens, p.round2_worst_tokens) > context_cap:
            over.append(p.task_id)                                # never truncate → documented block
    return ContextCapReport(token_count_source=counter.source, estimated_max=estimated_max,
                            headroom=headroom, context_cap=context_cap, fits_model_context=fits,
                            over_cap_tasks=over, per_request=per)
