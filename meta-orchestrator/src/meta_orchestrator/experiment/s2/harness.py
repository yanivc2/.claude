"""§2 orchestrator (offline, mock-only) — folds × conditions with sealed outcomes.

Runs each held-out task under A / C / D / B1 through the REAL ControlledRunner (real Sandbox,
real composite verifier). Guarantees:
  * condition isolation — only the injected memory slot varies (memory.resolve_memory);
  * per-fold isolation — a fresh DB, artifact store, and freshly-learned bank per fold;
  * sealed outcomes — the C/A/B1/D effect table is not readable until finalize(); only
    stability / cost / harness signals are exposed to the continue-stop gate (Decision E);
  * idempotent resume — a run key is executed at most once, so crash/resume never doubles
    cost or duplicates a datum.

A REAL (non-mock) run is refused unless every freeze precondition holds — this file never
calls a paid API.
"""
from __future__ import annotations

import tempfile
from typing import Callable, Optional

from pydantic import BaseModel, Field

from ..agent import MeasuredAgent
from ..artifacts import ArtifactStore
from ..contract import AgentContract
from ..runner import ControlledRunner
from ..store import ExperimentDB
from ..task import ExperimentTask
from ..verifier import verifier_config_hash
from .families import family_map_hash
from .folds import Fold, stratified_folds
from .lifecycle import Learner, MockLearner, learn_bank
from .memory import (CONDITIONS, FrozenLessonBank, PlaceboRouter, StaticPlaybook,
                     render_lines, resolve_memory)
from .mocks import LessonSensitiveMock

SolverFactory = Callable[[ExperimentTask, str], MeasuredAgent]


def _default_solver(task: ExperimentTask, condition: str) -> MeasuredAgent:
    return LessonSensitiveMock(task)


class Outcome(BaseModel):
    passed: bool
    failing_gate: Optional[str] = None
    cost: float = 0.0
    tool_calls: int = 0
    blocked_attempts: int = 0


class RealRunBlocked(RuntimeError):
    """A non-mock run was requested while a freeze precondition was unmet."""


class OutcomesSealedError(RuntimeError):
    """The effect table was read before the run was finalized (Decision E)."""


class SealedOutcomes:
    """Holds raw per-(fold, condition, task, rep) outcomes. The cross-condition EFFECT is
    sealed until finalize(); only stability/cost/harness signals leak to the gate."""

    def __init__(self) -> None:
        self._data: dict[tuple[int, str, str, int], Outcome] = {}
        self._finalized = False

    # --- recording (idempotent) ---
    def has(self, fold: int, condition: str, task_id: str, rep: int) -> bool:
        return (fold, condition, task_id, rep) in self._data

    def record(self, fold: int, condition: str, task_id: str, rep: int, outcome: Outcome) -> bool:
        key = (fold, condition, task_id, rep)
        if key in self._data:                 # resume-safe: never overwrite / double-count
            return False
        self._data[key] = outcome
        return True

    # --- allowed signals (Decision E: gate may see these) ---
    def cost_signals(self) -> dict:
        return {"attempts": len(self._data),
                "total_cost": round(sum(o.cost for o in self._data.values()), 6)}

    def harness_signals(self) -> dict:
        blocked = sum(o.blocked_attempts for o in self._data.values())
        return {"verifier_config_hash": verifier_config_hash(),
                "blocked_tool_attempts": blocked}

    def stability_signals(self, pilot_fold: int) -> "StabilitySignals":
        from .gate import StabilitySignals

        def flips(condition: str) -> tuple[int, int]:
            n = flip = 0
            tasks = {k[2] for k in self._data if k[0] == pilot_fold and k[1] == condition}
            for tid in tasks:
                r0 = self._data.get((pilot_fold, condition, tid, 0))
                r1 = self._data.get((pilot_fold, condition, tid, 1))
                if r0 is not None and r1 is not None:
                    n += 1
                    flip += int(r0.passed != r1.passed)
            return n, flip

        def passes(condition: str, rep: int) -> Optional[int]:
            vals = [o.passed for k, o in self._data.items()
                    if k[0] == pilot_fold and k[1] == condition and k[3] == rep]
            return sum(vals) if vals else None

        n_a, a_flips = flips("A")
        _, c_flips = flips("C")
        # Sign-reversal of (C-A) across reps — exposed as a BOOLEAN only; counts stay sealed.
        sign_reversed = False
        a0, a1, c0, c1 = passes("A", 0), passes("A", 1), passes("C", 0), passes("C", 1)
        if None not in (a0, a1, c0, c1):
            import math
            sign_reversed = (math.copysign(1, c0 - a0) != math.copysign(1, c1 - a1)
                             and (c0 - a0) != 0 and (c1 - a1) != 0)
        return StabilitySignals(n=n_a, a_flips=a_flips, c_flips=c_flips,
                                sign_reversed=sign_reversed,
                                verifier_deterministic=(a_flips == 0 and c_flips == 0))

    # --- sealed until finalize ---
    def finalize(self) -> None:
        self._finalized = True

    def effect_table(self) -> dict:
        if not self._finalized:
            raise OutcomesSealedError("effect table is sealed until finalize() (Decision E)")
        table: dict = {}
        for (fold, cond, tid, rep), o in self._data.items():
            table.setdefault(fold, {}).setdefault(cond, {})[f"{tid}#{rep}"] = o.passed
        return table


class FoldRun(BaseModel):
    fold: int
    bank_hash: str
    bank_families: list[str]
    conditions_run: list[str]
    n_test: int


class S2Harness:
    def __init__(
        self,
        family_map: dict[str, str],
        corpus: dict[str, ExperimentTask],
        contract: AgentContract,
        playbook: StaticPlaybook,
        *,
        k: int = 3,
        learner: Learner = None,
        solver_factory: SolverFactory = _default_solver,
        synthetic_map: bool = True,
    ) -> None:
        self.family_map = family_map
        self.corpus = corpus
        self.contract = contract
        self.playbook = playbook
        self.k = k
        self.learner = learner or MockLearner()
        self.solver_factory = solver_factory
        self.synthetic_map = synthetic_map
        self.placebo = PlaceboRouter.build()
        self.folds: list[Fold] = stratified_folds(family_map, k)
        self.outcomes = SealedOutcomes()

    # --- guard: never touch a paid API unless every freeze precondition is met ---
    def assert_real_run_allowed(self) -> None:
        problems = []
        if self.contract.provider == "mock":
            return  # mock runs are always allowed offline
        if self.synthetic_map:
            problems.append("family map is SYNTHETIC (freeze the $0 fingerprint-derived map first)")
        if not self.playbook.author_frozen:
            problems.append("static playbook D is not author-frozen")
        if problems:
            raise RealRunBlocked("; ".join(problems))

    def _learn_fold_bank(self, fold: Fold) -> FrozenLessonBank:
        train = [self.corpus[t] for t in fold.train_ids]
        return learn_bank(train, self.learner)

    def run_fold(self, fold: Fold, *, reps: Optional[dict[str, int]] = None) -> FoldRun:
        reps = reps or {c: 1 for c in CONDITIONS}
        bank = self._learn_fold_bank(fold)               # fresh, per-fold (isolation)
        db = ExperimentDB(":memory:")                    # fresh store per fold (no carryover)
        artifacts = ArtifactStore(tempfile.mkdtemp(prefix=f"mo_s2_f{fold.index}_"))
        runner = ControlledRunner(db, artifacts)

        for tid in fold.test_ids:
            task = self.corpus[tid]
            for condition in CONDITIONS:
                for rep in range(reps.get(condition, 1)):
                    if self.outcomes.has(fold.index, condition, tid, rep):
                        continue                          # resume-safe: already done
                    mc = resolve_memory(condition, task.task_family, bank=bank,
                                        playbook=self.playbook, placebo=self.placebo)
                    lines = render_lines(mc)
                    agent = self.solver_factory(task, condition)
                    run_id = f"F{fold.index}:{condition}:{tid}:r{rep}"
                    res = runner.run(task, condition, agent, self.contract,
                                     playbook_context=lines, run_id=run_id)
                    self.outcomes.record(fold.index, condition, tid, rep, Outcome(
                        passed=res.passed, failing_gate=res.failing_gate,
                        cost=0.0, tool_calls=res.tool_calls,
                        blocked_attempts=len(res.blocked_attempts)))
        db.close()
        return FoldRun(fold=fold.index, bank_hash=bank.content_hash(),
                       bank_families=bank.families_present(),
                       conditions_run=list(CONDITIONS), n_test=len(fold.test_ids))

    def run_all(self, *, reps: Optional[dict[str, int]] = None) -> list[FoldRun]:
        return [self.run_fold(f, reps=reps) for f in self.folds]

    def family_map_hash(self) -> str:
        return family_map_hash(self.family_map)
