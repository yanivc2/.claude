"""Post-mortem / reflection (SPEC §5.7, C6).

After a run: compare **predicted vs actual**, derive a **root cause**, and **update
memory** according to the failure category (§5.6). The per-attempt bandit update
happens at verify time; here we write the positive playbook lesson (gated) and record
the calibration gap + root cause. This is the heart of "a system that learns".
"""
from __future__ import annotations

from typing import Any

from .learning.bandit import BanditBook
from .learning.failure import update_action_for
from .memory.writer import ConfirmFn, MemoryWriter, always_confirm
from .models import TaskClassification, VerifyResult


class PostMortem:
    def __init__(self, writer: MemoryWriter) -> None:
        self._writer = writer

    def analyze(
        self,
        *,
        classification: TaskClassification,
        selected_model: str,
        predicted_p_success: float,
        final_verify: VerifyResult,
        bandit: BanditBook,
        cost: float = 0.0,
        confirm: ConfirmFn = always_confirm,
    ) -> dict[str, Any]:
        actual = final_verify.passed
        action = update_action_for(final_verify.failure_category)
        calibration_gap = round(predicted_p_success - (1.0 if actual else 0.0), 4)

        playbook_updated = False
        if actual:
            # Positive, verified lesson → write to Tier-1 playbook (gated pipeline, B4).
            entry = self._writer.write(
                classification=classification,
                chosen_model=selected_model,
                verify_result=final_verify,
                bandit=bandit,
                confirm=confirm,
                cost=cost,
            )
            playbook_updated = entry is not None
            root_cause = f"verified success via {selected_model}"
        else:
            root_cause = (
                f"{final_verify.failure_category.value}: {selected_model} produced an "
                f"artifact that failed independent verification "
                f"({'; '.join(final_verify.evidence) or 'no evidence'})"
            )

        return {
            "predicted_p_success": round(predicted_p_success, 4),
            "actual_passed": actual,
            "calibration_gap": calibration_gap,
            "failure_category": final_verify.failure_category.value,
            "update_action": action.value,
            "root_cause": root_cause,
            "playbook_updated": playbook_updated,
        }
