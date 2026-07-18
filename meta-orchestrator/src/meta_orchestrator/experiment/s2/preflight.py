"""count_tokens context-cap preflight tool + the full-request B1 metrics oracle.

Built OFFLINE ($0) and dry-run with the deterministic proxy; the REAL run happens in the pinned
pilot environment where `count_tokens` (free, but SDK + network) is available. A proxy artifact is
tagged ``token_count_source="offline_proxy"`` and can NEVER open a production gate
(see ``b1_selector.assert_production_valid``).

Two pieces:
  * ``full_request_metrics_fn`` — the B1 oracle that counts the COMPLETE C/B1 held-out request
    (system + tools + source + memory + response schema), not just the memory block. Cache-keyed
    by (request hash, model, token-source).
  * ``context_cap_preflight`` — builds worst-case Round-1 and Round-2 legal requests for every
    task × condition, counts them, and applies the frozen cap formula. Never truncates target
    source: a task over the cap forces a documented decision + a new manifest version.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Callable, Optional

from pydantic import BaseModel, Field

from ..task import ExperimentTask
from .b1_selector import PROXY_SOURCE, MetricsFn, local_token_estimate
from .contract_s2 import S2_MAX_TOKENS, S2_SYSTEM_PROMPT, anthropic_request_kwargs, frozen_s2_contract
from .memory import (SLOT_MAX_CHARS, SLOT_MAX_LINES, FrozenLessonBank, MemoryContext,
                     StaticPlaybook)
from .prompt import build_agent_prompt, render_memory_payload

MODEL_TOTAL_CONTEXT = 200_000            # Haiku 4.5 context window
HEADROOM_FLOOR = 2048
HEADROOM_FRACTION = 0.10

# A request-token function counts a full messages.create kwargs dict → tokens.
RequestTokenFn = Callable[[dict], int]


def proxy_request_tokens(kwargs: dict) -> int:
    """Deterministic offline proxy over the FULL serialized request (dry-run only)."""
    blob = json.dumps(kwargs, sort_keys=True)
    return local_token_estimate(blob)


def _request_for(task: ExperimentTask, memory_payload: list[str],
                 public_feedback: Optional[str] = None) -> dict:
    prompt = build_agent_prompt(source=dict(task.source), public_tests=dict(task.public_tests),
                                memory_payload=memory_payload, public_feedback=public_feedback)
    return anthropic_request_kwargs(frozen_s2_contract(), prompt=prompt, system=S2_SYSTEM_PROMPT)


def _payload_for_family(bank: FrozenLessonBank, family: str) -> list[str]:
    mc = MemoryContext(condition="X", component_kind="x", source_family=family,
                       lines=_lesson_lines(bank.lessons_for(family)))
    return render_memory_payload(mc)


def _lesson_lines(lessons) -> list[str]:
    out: list[str] = []
    for l in lessons:
        out.extend(l.recommended_action)
        out.extend(f"avoid: {a}" for a in l.avoid)
    return out


def full_request_metrics_fn(
    bank: FrozenLessonBank,
    corpus: dict[str, ExperimentTask],
    *,
    request_token_fn: RequestTokenFn = proxy_request_tokens,
) -> MetricsFn:
    """B1 oracle that counts the COMPLETE request for (task, injected_family). Entries/lines from
    the bank; tokens from the full request. Cache-keyed by the serialized request hash."""
    cache: dict[str, tuple[int, int, int]] = {}

    def metrics(task_id: str, injected_family: str) -> tuple[int, int, int]:
        task = corpus[task_id]
        lessons = bank.lessons_for(injected_family)
        entries = len(lessons)
        payload = _payload_for_family(bank, injected_family)
        lines = len(payload)
        kwargs = _request_for(task, payload)
        req_hash = hashlib.sha256(json.dumps(kwargs, sort_keys=True).encode()).hexdigest()[:16]
        if req_hash not in cache:
            cache[req_hash] = (entries, lines, request_token_fn(kwargs))
        return cache[req_hash]

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
    request_token_fn: RequestTokenFn = proxy_request_tokens,
    token_count_source: str = PROXY_SOURCE,
    max_public_feedback: Optional[str] = None,
    max_r1_assistant_output: Optional[str] = None,
) -> ContextCapReport:
    """Count worst-case Round-1 and Round-2 legal requests for every task and freeze a cap.

    Worst case uses the MAXIMUM legal memory slot (the real C bank does not exist at preflight),
    the maximum sanitized public feedback, and the maximum prior assistant/tool transcript for R2.
    """
    mem = _max_legal_memory_payload()
    feedback = max_public_feedback or ("F" * 2000)               # max sanitized public summary
    # worst-case R2 carries the largest legal prior assistant output in the visible transcript.
    r1_out = max_r1_assistant_output or ("O" * (S2_MAX_TOKENS * 4))
    per: list[TaskContextCount] = []
    estimated_max = 0
    over: list[str] = []
    for tid, task in corpus.items():
        r1 = request_token_fn(_request_for(task, mem))
        # R2 = R1 context + prior assistant output + sanitized public feedback (as a fed-back turn)
        r2 = request_token_fn(_request_for(task, mem, public_feedback=(r1_out + "\n" + feedback)))
        per.append(TaskContextCount(task_id=tid, condition="worst-case",
                                    round1_tokens=r1, round2_worst_tokens=r2))
        estimated_max = max(estimated_max, r1, r2)
    headroom = max(HEADROOM_FLOOR, math.ceil(HEADROOM_FRACTION * estimated_max))
    context_cap = int(math.ceil((estimated_max + headroom) / 1024) * 1024)
    fits = context_cap + S2_MAX_TOKENS <= MODEL_TOTAL_CONTEXT
    for p in per:
        if max(p.round1_tokens, p.round2_worst_tokens) > context_cap:
            over.append(p.task_id)                                # never truncate → documented block
    return ContextCapReport(token_count_source=token_count_source, estimated_max=estimated_max,
                            headroom=headroom, context_cap=context_cap, fits_model_context=fits,
                            over_cap_tasks=over, per_request=per)
