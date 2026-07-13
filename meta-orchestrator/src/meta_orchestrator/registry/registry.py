"""Model Registry (SPEC §9).

Wraps the Store to provide model lookup + config-driven candidate resolution.
Model *names* are resolved ONLY here (SPEC §6): callers ask for candidates for a
task type and get back registered :class:`ModelSpec`s — they never hardcode names.
"""
from __future__ import annotations

from ..config import OrchestratorConfig
from ..models import EvalScore, ModelSpec
from ..persistence.store import Store


class UnknownModelError(KeyError):
    """A configured model id is not present in the Registry."""


class ModelRegistry:
    def __init__(self, store: Store, config: OrchestratorConfig) -> None:
        self._store = store
        self._config = config

    # --- writes ---
    def register(self, spec: ModelSpec) -> None:
        self._store.upsert_model(spec)

    def record_eval_score(self, model_id: str, score: EvalScore) -> None:
        if self._store.get_model(model_id) is None:
            raise UnknownModelError(model_id)
        self._store.add_eval_score(model_id, score)

    # --- reads ---
    def get(self, model_id: str) -> ModelSpec:
        spec = self._store.get_model(model_id)
        if spec is None:
            raise UnknownModelError(model_id)
        return spec

    def all(self) -> list[ModelSpec]:
        return self._store.list_models()

    def candidate_models(self, task_type: str) -> list[ModelSpec]:
        """Resolve the config-declared candidate model ids for ``task_type``.

        This is how "model choice is read from config" (A1): the ids come from
        ``config.candidate_models`` and are validated against the Registry. An
        unregistered id is a hard error — we never silently fall back to a
        hardcoded name.
        """
        ids = self._config.candidate_models.get(task_type)
        if not ids:
            raise UnknownModelError(f"no candidate models configured for task_type={task_type!r}")
        resolved: list[ModelSpec] = []
        for mid in ids:
            spec = self._store.get_model(mid)
            if spec is None:
                raise UnknownModelError(
                    f"configured candidate {mid!r} for {task_type!r} is not registered"
                )
            if spec.availability:
                resolved.append(spec)
        if not resolved:
            raise UnknownModelError(f"no available candidate models for task_type={task_type!r}")
        return resolved

    def prior_score(self, model_id: str, task_type: str) -> float | None:
        """Latest seeded/eval score for a (model, task_type), used as a bandit prior."""
        spec = self.get(model_id)
        scores = [s for s in spec.eval_scores if s.task_type == task_type]
        return scores[-1].score if scores else None
