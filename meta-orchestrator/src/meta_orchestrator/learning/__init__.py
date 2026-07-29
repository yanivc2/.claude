"""Learning mechanics (SPEC §6): bandit/Bayesian updates + failure→update mapping."""
from .bandit import BanditBook
from .failure import FAILURE_UPDATE, UpdateAction, update_action_for

__all__ = ["BanditBook", "FAILURE_UPDATE", "UpdateAction", "update_action_for"]
