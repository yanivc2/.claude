"""Time estimation — contract and port, with an explicit refusal as the default.

There is no latency data in this repository. ``ModelSpec.latency_ms`` holds four seeded
numbers that were never measured against a real call, and P1b forbids live latency
lookups. Producing a duration from those figures would be a guess wearing the costume
of a measurement.

So the default implementation returns an **explicitly incomplete** result rather than a
number. The contract, the port and the separation of time kinds are all here, so a
later phase can supply a real profile without reshaping anything; what is absent is a
fabricated answer.

The separation itself is the useful part: compute, provider wait, verification, human
and externally-blocked time behave completely differently under parallelism, and a
single "duration" cannot be scheduled against.
"""
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from ..contracts.estimates import TimeEstimate, TimeEstimateRange
from .entities import UsageEstimate
from .request import EstimationRequest


class TimeEstimateResult(BaseModel):
    """A duration estimate, or a documented refusal to give one."""

    model_config = ConfigDict(frozen=True)

    available: bool
    range: Optional[TimeEstimateRange] = None
    #: Stage ids that must complete before anything downstream — the critical path.
    critical_path: list[str] = Field(default_factory=list)
    #: Groups of stage ids that could run at the same time.
    parallel_groups: list[list[str]] = Field(default_factory=list)
    human_minutes: int = 0
    unavailable_reason: str = ""
    assumptions: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


@runtime_checkable
class TimeEstimatorPort(Protocol):
    """The seam a real time estimator will plug into."""

    def estimate_time(self, request: EstimationRequest,
                      usage: UsageEstimate) -> TimeEstimateResult:
        ...


class UnavailableTimeEstimator:
    """The P1b default: computes structure, refuses to invent a duration.

    It still does the part that can be done honestly — resolve the dependency graph
    into parallel groups and a critical path, and total the human minutes the plan
    itself declared. Those are derived from stated facts. Wall-clock is not.
    """

    REASON = (
        "no latency profile exists: ModelSpec.latency_ms was seeded, never measured, "
        "and live latency lookups are out of scope. A duration derived from those "
        "numbers would be a guess presented as a measurement"
    )

    def estimate_time(self, request: EstimationRequest,
                      usage: UsageEstimate) -> TimeEstimateResult:
        groups = _parallel_groups(request)
        return TimeEstimateResult(
            available=False,
            critical_path=_critical_path(request),
            parallel_groups=groups,
            human_minutes=usage.human_minutes,
            unavailable_reason=self.REASON,
            assumptions=[
                "structure is derived from the declared stage dependencies",
                "human minutes are taken from the plan, not estimated",
            ],
            limitations=[
                "no model execution time",
                "no provider wait time",
                "no verification or retry wall-clock",
                "confidence would be UNKNOWN even if a number were produced",
            ],
        )


def _parallel_groups(request: EstimationRequest) -> list[list[str]]:
    """Dependency levels; every stage within a level may run concurrently."""
    remaining = {s.stage_id: set(s.depends_on) for s in request.stages}
    done: set[str] = set()
    levels: list[list[str]] = []
    while remaining:
        ready = sorted(sid for sid, deps in remaining.items() if deps <= done)
        if not ready:                      # pragma: no cover - request validates acyclicity
            raise ValueError(f"cycle among stages: {sorted(remaining)}")
        levels.append(ready)
        done |= set(ready)
        for sid in ready:
            del remaining[sid]
    return levels


def _critical_path(request: EstimationRequest) -> list[str]:
    """The longest chain of blocking stages, by dependency depth.

    Without durations this is a structural longest path, not a timed one — which is
    exactly what it claims to be.
    """
    depth: dict[str, int] = {}
    chain: dict[str, list[str]] = {}
    for level in _parallel_groups(request):
        for sid in level:
            stage = request.stage(sid)
            if not stage.depends_on:
                depth[sid], chain[sid] = 1, [sid]
                continue
            parent = max(stage.depends_on, key=lambda p: depth.get(p, 0))
            depth[sid] = depth.get(parent, 0) + 1
            chain[sid] = chain.get(parent, []) + [sid]
    if not depth:
        return []
    deepest = max(depth, key=lambda s: depth[s])
    return chain[deepest]


def empty_time_estimate() -> TimeEstimateRange:
    """A zeroed range, for callers that need the shape and know it means nothing."""
    zero = TimeEstimate()
    return TimeEstimateRange(best=zero, expected=zero, worst=zero)
