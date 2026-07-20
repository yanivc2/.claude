"""Bounded agentic attempt (Decision B) + the offline solver harness.

Decision B defines an *attempt* as a bounded session for one (task, condition) — NOT a single
model call. The harness (not the solver) drives the loop and enforces the ceiling:

  * <= 2 model calls (rounds);
  * <= 2 patch submissions;
  * <= 2 public-test runs;
  * exactly 1 hidden verification, at the very end;
  * Round 2 opens ONLY after Round 1 fails the PUBLIC suite;
  * Round 1 PUBLIC pass stops the attempt (no gratuitous Round 2);
  * the solver never receives F2P (hidden) feedback — only sanitized, length-capped PUBLIC
    output, and never the final verdict.

The number of rounds actually used may differ across conditions — that is a *result*
(efficiency / cost), not noise. This module is mock-only and never calls a paid API: a solver
is a ``RoundSolver`` test-double whose ``solve_round`` returns a declarative patch. Enforcing the
caps here (rather than trusting the solver) is what makes the contract auditable.
"""
from __future__ import annotations

import tempfile
from typing import Optional, Protocol

from pydantic import BaseModel, ConfigDict, Field

from ..agent import AgentTools, ToolViolation
from ..artifacts import ArtifactStore
from ..contract import AgentContract
from ..lesson import Lesson
from ..sandbox import Sandbox
from ..store import ExperimentDB
from ..task import ExperimentTask
from ..verifier import verifier_config_hash, verify
from .families import family_map_hash
from .folds import Fold, stratified_folds
from .lifecycle import Learner, MockLearner, learn_bank
from .memory import (CONDITIONS, FrozenLessonBank, PlaceboRouter, StaticPlaybook, render_lines,
                     resolve_memory)
from .b1_selector import PROXY_SOURCE, select_b1_derangement
from .ordering import condition_order, train_order
from .preflight import full_request_metrics_fn
from .write_gate import assert_bank_within_train


class AttemptContract(BaseModel):
    """Frozen bound on a single attempt (Decision B). Hashed into every attempt's provenance."""

    model_config = ConfigDict(frozen=True)

    max_model_calls: int = 2
    max_patches: int = 2
    max_public_runs: int = 2
    hidden_verifications: int = 1
    round2_only_after_public_fail: bool = True
    f2p_feedback_to_agent: bool = False          # hidden feedback NEVER reaches the solver
    public_feedback_char_cap: int = 2000         # length cap on sanitized public output


class RoundView(BaseModel):
    """Exactly what the solver sees on one round — never hidden tests, never the verdict."""

    round_index: int                              # 1-based
    task_id: str
    task_family: str
    source: dict[str, str]
    public_tests: dict[str, str]
    memory_lines: list[str] = Field(default_factory=list)
    public_feedback: Optional[str] = None         # sanitized PUBLIC output from the prior round


class RoundOutput(BaseModel):
    """The solver's declarative result for one round."""

    patch: dict[str, str] = Field(default_factory=dict)   # OFFLINE harness: path -> full content
    # REAL (paid) path only: minimal SEARCH/REPLACE edits (path -> [(search, replace), ...]) applied
    # against the buggy pre-image by realtask.apply_patch. None on the offline/mock path.
    sr_edits: Optional[dict[str, list[tuple[str, str]]]] = None
    claimed_done: bool = False
    candidate_lesson: Optional[Lesson] = None             # C-train only; harness gates the write
    notes: str = ""
    # REAL-path observability / fail-closed classification (None on the offline/mock path):
    stop_reason: Optional[str] = None
    classification: Optional[str] = None                  # VALID_COMPLETE_OUTPUT | TRUNCATED_OUTPUT | ...
    parse_reason: str = ""


class RoundSolver(Protocol):
    name: str

    def solve_round(self, view: RoundView) -> RoundOutput: ...


class AttemptContractViolation(RuntimeError):
    """A cap was about to be exceeded — a bug in the loop, surfaced loudly rather than hidden."""


class AttemptResult(BaseModel):
    task_id: str
    condition: str
    passed: bool
    failing_gate: Optional[str] = None
    rounds_used: int = 0
    model_calls: int = 0
    patches_submitted: int = 0
    patches_applied: int = 0
    public_runs: int = 0
    hidden_verifications: int = 0
    public_pass_round1: Optional[bool] = None
    round1_public_status: Optional[str] = None      # PASS | FAIL | NO_PUBLIC_TESTS | INFRA_ERROR
    infra_incomplete: bool = False                   # infra error → withheld from paired analysis
    round2_opened: bool = False
    blocked_attempts: int = 0
    candidate_lessons: list[Lesson] = Field(default_factory=list)
    f2p_feedback_leaked: bool = False             # invariant: MUST stay False
    provenance: dict = Field(default_factory=dict)


def _sanitize_public(summary: str, cap: int) -> str:
    """The only feedback allowed into Round 2: the PUBLIC suite's short summary, length-capped."""
    return (summary or "").strip()[:cap]


def run_attempt(
    task: ExperimentTask,
    condition: str,
    memory_lines: list[str],
    solver: RoundSolver,
    agent_contract: AgentContract,
    attempt_contract: AttemptContract,
    *,
    is_train: bool = False,
    provenance_extra: Optional[dict] = None,
) -> AttemptResult:
    """Drive one bounded attempt end-to-end and verify exactly once at the end."""
    model_calls = patches_submitted = patches_applied = public_runs = 0
    blocked = 0
    round2_opened = False
    public_pass_round1: Optional[bool] = None
    round1_status: Optional[str] = None
    candidates: list[Lesson] = []
    feedback: Optional[str] = None

    with Sandbox(task) as sb:
        tools = AgentTools(sb, task)
        for round_index in range(1, attempt_contract.max_model_calls + 1):
            # Round 2 opens ONLY after a genuine Round-1 behavioural PUBLIC FAIL (Decision B +
            # P0.4). A pass, an empty suite, or an infra error must NOT buy an extra model call.
            if round_index == 2:
                if attempt_contract.round2_only_after_public_fail and round1_status != "FAIL":
                    break
                round2_opened = True

            view = RoundView(
                round_index=round_index, task_id=task.task_id, task_family=task.task_family,
                source={p: sb.read(p) for p in task.source}, public_tests=dict(task.public_tests),
                memory_lines=list(memory_lines), public_feedback=feedback,
            )
            if model_calls >= attempt_contract.max_model_calls:
                raise AttemptContractViolation("model-call cap exceeded")
            out = solver.solve_round(view)
            model_calls += 1

            # Apply the patch through the SCOPE-ENFORCED tool; an out-of-scope write is blocked.
            if out.patch:
                patches_submitted += 1
                if patches_submitted > attempt_contract.max_patches:
                    raise AttemptContractViolation("patch cap exceeded")
                applied_here = False
                for path, content in out.patch.items():
                    try:
                        tools.write_source(path, content)
                        applied_here = True
                    except ToolViolation:
                        pass                       # blocked + audited; invalid patch handled
                if applied_here:
                    patches_applied += 1

            if condition == "C" and is_train and out.candidate_lesson is not None:
                candidates.append(out.candidate_lesson)

            # The agent's own PUBLIC run (NOT the final verifier), four-state (P0.4).
            if public_runs >= attempt_contract.max_public_runs:
                raise AttemptContractViolation("public-run cap exceeded")
            pub_status, pub_summary = tools.run_public_tests_status()
            public_runs += 1
            if round_index == 1:
                round1_status = pub_status
                public_pass_round1 = (pub_status == "PASS")
            if pub_status != "FAIL":
                break                              # only a genuine FAIL keeps the attempt going
            feedback = _sanitize_public(pub_summary, attempt_contract.public_feedback_char_cap)

        # Exactly one hidden verification, at the very end; its result is never fed back.
        verdict = verify(task, sb)
        blocked = len(tools.blocked_attempts())

    provenance = {
        "agent_contract_snapshot": agent_contract.snapshot()[:16],
        "attempt_contract_hash": _contract_hash(attempt_contract),
        "verifier_config_hash": verifier_config_hash(),
        "exact_model_id": agent_contract.exact_model_id,
        "provider": agent_contract.provider,
        "memory_kind": _mem_kind(memory_lines),
        **(provenance_extra or {}),
    }
    return AttemptResult(
        task_id=task.task_id, condition=condition, passed=verdict.passed,
        failing_gate=verdict.failing_gate, rounds_used=model_calls, model_calls=model_calls,
        patches_submitted=patches_submitted, patches_applied=patches_applied,
        public_runs=public_runs, hidden_verifications=1, public_pass_round1=public_pass_round1,
        round1_public_status=round1_status,
        infra_incomplete=(round1_status == "INFRA_ERROR"),
        round2_opened=round2_opened, blocked_attempts=blocked, candidate_lessons=candidates,
        f2p_feedback_leaked=False, provenance=provenance,
    )


def _contract_hash(attempt_contract: AttemptContract) -> str:
    import hashlib
    import json
    blob = json.dumps(attempt_contract.model_dump(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


def _mem_kind(memory_lines: list[str]) -> str:
    from .memory import parse_mem_tag
    kind, _ = parse_mem_tag(memory_lines)
    return kind


# --------------------------------------------------------------------------------------------
# Solver harness: folds × conditions with the bounded attempt, resume-safe recording.
# --------------------------------------------------------------------------------------------
class SolverAttempt(BaseModel):
    """The recorded per-(fold, condition, task, rep) attempt (sealed like SealedOutcomes)."""

    fold: int
    condition: str
    task_id: str
    rep: int
    result: AttemptResult


class SolverOutcomesSealedError(RuntimeError):
    """The effect table was read before finalize() (Decision E)."""


class SolverOutcomes:
    """Sealed store of AttemptResults. Cross-condition EFFECT sealed until finalize()."""

    def __init__(self) -> None:
        self._data: dict[tuple[int, str, str, int], AttemptResult] = {}
        self._finalized = False

    def has(self, fold: int, condition: str, task_id: str, rep: int) -> bool:
        return (fold, condition, task_id, rep) in self._data

    def record(self, fold: int, condition: str, task_id: str, rep: int,
               result: AttemptResult) -> bool:
        key = (fold, condition, task_id, rep)
        if key in self._data:                     # resume-safe: never double-count
            return False
        self._data[key] = result
        return True

    def cost_signals(self) -> dict:
        return {"attempts": len(self._data),
                "model_calls": sum(r.model_calls for r in self._data.values()),
                "public_runs": sum(r.public_runs for r in self._data.values()),
                "round2_opened": sum(int(r.round2_opened) for r in self._data.values())}

    def harness_signals(self) -> dict:
        return {"verifier_config_hash": verifier_config_hash(),
                "blocked_tool_attempts": sum(r.blocked_attempts for r in self._data.values()),
                "f2p_feedback_leaked": any(r.f2p_feedback_leaked for r in self._data.values())}

    def finalize(self) -> None:
        self._finalized = True

    def effect_table(self) -> dict:
        if not self._finalized:
            raise SolverOutcomesSealedError("effect table sealed until finalize() (Decision E)")
        table: dict = {}
        for (fold, cond, tid, rep), r in self._data.items():
            table.setdefault(fold, {}).setdefault(cond, {})[f"{tid}#{rep}"] = r.passed
        return table


RoundSolverFactory = "typing.Callable[[ExperimentTask, str], RoundSolver]"


class SolverHarness:
    """Runs the bounded attempt for every held-out task × condition, per fold, sealed."""

    def __init__(
        self,
        family_map: dict[str, str],
        corpus: dict[str, ExperimentTask],
        agent_contract: AgentContract,
        playbook: StaticPlaybook,
        round_solver_factory,
        *,
        attempt_contract: Optional[AttemptContract] = None,
        k: int = 3,
        learner: Learner = None,
        synthetic_map: bool = True,
    ) -> None:
        self.family_map = family_map
        self.corpus = corpus
        self.agent_contract = agent_contract
        self.playbook = playbook
        self.round_solver_factory = round_solver_factory
        self.attempt_contract = attempt_contract or AttemptContract()
        self.k = k
        self.learner = learner or MockLearner()
        self.synthetic_map = synthetic_map
        self.placebo = PlaceboRouter.build(sorted(set(family_map.values())))
        self.folds: list[Fold] = stratified_folds(family_map, k)
        self.outcomes = SolverOutcomes()
        self.b1_selections: dict = {}                  # per-fold frozen B1 parity artifact

    def _learn_fold_bank(self, fold: Fold) -> FrozenLessonBank:
        # frozen curriculum order (C learns sequentially → bank depends on train order).
        return learn_bank([self.corpus[t] for t in train_order(fold.train_ids)], self.learner)

    def occupancy_parity(self, fold: Fold) -> list:
        """P0.5: per-family C-vs-B1 slot occupancy for this fold's bank (a length-confound probe)."""
        from .memory import occupancy_parity
        bank = self._learn_fold_bank(fold)
        return occupancy_parity(bank, self.placebo, sorted(set(self.family_map.values())))

    def run_fold(self, fold: Fold, *, reps: Optional[dict[str, int]] = None) -> dict:
        reps = reps or {c: 1 for c in CONDITIONS}
        bank = self._learn_fold_bank(fold)             # fresh per fold; frozen before held-out
        assert_bank_within_train(bank, fold.train_ids)  # P0.2 tripwire: no cross-fold leakage
        # B1: parity-optimized wrong-family mapping from the FROZEN bank (may hard-block the fold).
        # Offline the harness uses the memory-only proxy oracle (a plumbing double that never opens
        # a production gate); the pilot injects a full-request count_tokens oracle at Gate 2.
        present = sorted(set(self.family_map.values()))
        held_out_tasks = [(t, self.family_map[t]) for t in fold.test_ids]
        # Offline dry-run uses the FULL-request oracle with the proxy counter (exercises the real
        # code path); the pilot injects an AnthropicTokenCounter at Gate 2 for real counts.
        metrics = full_request_metrics_fn(bank, self.corpus)
        selection = select_b1_derangement(bank, present, held_out_tasks, fold=fold.index,
                                          metrics_fn=metrics, token_count_source=PROXY_SOURCE)
        self.b1_selections[fold.index] = selection
        b1_router = selection.router()
        for tid in fold.test_ids:
            task = self.corpus[tid]
            for condition in condition_order(tid, CONDITIONS):   # counterbalanced per task
                for rep in range(reps.get(condition, 1)):
                    if self.outcomes.has(fold.index, condition, tid, rep):
                        continue                       # resume-safe
                    mc = resolve_memory(condition, task.task_family, bank=bank,
                                        playbook=self.playbook, placebo=b1_router)
                    lines = render_lines(mc)
                    solver = self.round_solver_factory(task, condition)
                    result = run_attempt(
                        task, condition, lines, solver, self.agent_contract,
                        self.attempt_contract, is_train=False,
                        provenance_extra={"fold": fold.index, "rep": rep,
                                          "bank_hash": bank.content_hash(),
                                          "family_map_hash": family_map_hash(self.family_map)})
                    # P0.3 held-out schema parity: NO condition writes/collects a lesson here.
                    if result.candidate_lessons:
                        raise AttemptContractViolation(
                            f"held-out attempt {condition}/{tid} produced a candidate lesson "
                            "— response-schema parity broken (only train may propose)")
                    self.outcomes.record(fold.index, condition, tid, rep, result)
        return {"fold": fold.index, "bank_hash": bank.content_hash(),
                "bank_families": bank.families_present(), "n_test": len(fold.test_ids)}

    def run_all(self, *, reps: Optional[dict[str, int]] = None) -> list[dict]:
        return [self.run_fold(f, reps=reps) for f in self.folds]


# --------------------------------------------------------------------------------------------
# Scripted mock round-solvers (test-doubles only; a real Haiku session replaces them).
# --------------------------------------------------------------------------------------------
class FixOnRoundSolver:
    """Applies the task's reference fix on a chosen round; no-op (or wrong) before that.

    ``fix_round=1`` → Round 1 public passes → attempt stops (no Round 2).
    ``fix_round=2`` → Round 1 fails public → Round 2 opens once → then fixes.
    ``fix_round=None`` → never fixes → both rounds run → hidden verify fails.
    """

    def __init__(self, task: ExperimentTask, condition: str = "A", *, fix_round: Optional[int] = 1,
                 name: str = "fix-on-round"):
        self.name = name
        self._task = task
        self._condition = condition
        self._fix_round = fix_round
        self.rounds_seen: list[int] = []
        self.feedback_seen: list[Optional[str]] = []

    def solve_round(self, view: RoundView) -> RoundOutput:
        self.rounds_seen.append(view.round_index)
        self.feedback_seen.append(view.public_feedback)
        if self._fix_round is not None and view.round_index >= self._fix_round:
            return RoundOutput(patch=dict(self._task.reference_fix), claimed_done=True,
                               notes=f"applied reference fix on round {view.round_index}")
        # A harmless no-op edit that keeps the bug (public still fails).
        return RoundOutput(patch={}, claimed_done=False, notes="no fix this round")


class MemorySensitiveRoundSolver:
    """Round-based analogue of ``LessonSensitiveMock`` — applies the fix ONLY when a relevant-
    family lesson was delivered (condition C). Any other memory (A / B1 / D) → no fix → fails.

    This preserves the routing invariant through the bounded-attempt path: it probes the memory
    DELIVERY channel, not a real solver's competence. It emits a schema-safe candidate lesson on
    train tasks so the write-gate has something to gate. It makes no claim a real model behaves
    this way — the micro-pilot replaces it.
    """

    def __init__(self, task: ExperimentTask, condition: str = "A", name: str = "mem-sensitive"):
        self.name = name
        self._task = task
        self._condition = condition

    def solve_round(self, view: RoundView) -> RoundOutput:
        from .memory import KIND_FAMILY_RELEVANT, parse_mem_tag
        kind, family = parse_mem_tag(view.memory_lines)
        helped = kind == KIND_FAMILY_RELEVANT and family == view.task_family
        candidate = MockLearner()(self._task)     # schema-safe generic candidate for the write-gate
        if helped:
            return RoundOutput(patch=dict(self._task.reference_fix), claimed_done=True,
                               candidate_lesson=candidate, notes="applied fix (relevant lesson)")
        return RoundOutput(patch={}, claimed_done=False, candidate_lesson=candidate,
                           notes=f"no relevant memory (kind={kind})")


class InvalidPatchSolver:
    """Round 1 writes an OUT-OF-SCOPE path (blocked+audited); then optionally fixes on Round 2."""

    def __init__(self, task: ExperimentTask, condition: str = "A", *, fix_round: Optional[int] = 2,
                 name: str = "invalid-patch"):
        self.name = name
        self._task = task
        self._fix_round = fix_round

    def solve_round(self, view: RoundView) -> RoundOutput:
        if view.round_index == 1:
            # Attempt to edit a protected test file — the tool contract must block it.
            bad_path = next(iter(self._task.public_tests), "tests_public/test_public.py")
            return RoundOutput(patch={bad_path: "# tampered"}, notes="out-of-scope write")
        if self._fix_round is not None and view.round_index >= self._fix_round:
            return RoundOutput(patch=dict(self._task.reference_fix), claimed_done=True)
        return RoundOutput(patch={}, notes="no fix")


# --- negative-control doubles: prove the harness can represent NO effect and REJECTION --------
class MemoryIgnoringRoundSolver:
    """Applies the fix on Round 1 regardless of the memory slot → A=C=D=B1 all PASS.

    Negative control: if the harness ever showed separation with THIS double, the separation
    would be an artefact. Its all-pass result proves the harness does not manufacture an effect.
    """

    def __init__(self, task: ExperimentTask, condition: str = "A", name: str = "mem-ignoring"):
        self.name = name
        self._task = task

    def solve_round(self, view: RoundView) -> RoundOutput:
        return RoundOutput(patch=dict(self._task.reference_fix), claimed_done=True,
                           notes="fix regardless of memory (negative control)")


class LeakingLessonSolver:
    """On a TRAIN task, proposes a candidate lesson that LEAKS a path/value → write-gate rejects.

    Negative control for the learning path: proves the deterministic gate blocks a memorised /
    replayed 'lesson' rather than admitting anything the model emits.
    """

    def __init__(self, task: ExperimentTask, condition: str = "C", name: str = "leaking-lesson"):
        self.name = name
        self._task = task

    def solve_round(self, view: RoundView) -> RoundOutput:
        from ..lesson import Lesson, LessonTrigger
        leaking = Lesson(
            lesson_id=f"L-leak-{view.task_id}", task_family=view.task_family,
            trigger=LessonTrigger(symptoms=["x"]),
            recommended_action=["edit solution.py at line 42 and return 15"],  # path+line+value
            avoid=[], status="candidate")
        return RoundOutput(patch=dict(self._task.reference_fix), claimed_done=True,
                           candidate_lesson=leaking, notes="emits a leaking lesson (negative ctrl)")
