"""Budget ledger / circuit breaker (SPEC §10).

A hard, in-code ceiling on tokens (and a round counter) so a run cannot burn away.
Milestone C uses it to bound the retry loop; Milestone D layers autonomy modes on top.
"""
from __future__ import annotations


class BudgetExhaustedError(RuntimeError):
    """Charging would exceed the hard token ceiling (circuit breaker tripped)."""


class BudgetLedger:
    def __init__(self, total_tokens: int, max_rounds: int) -> None:
        self.total_tokens = total_tokens
        self.max_rounds = max_rounds
        self.spent_tokens = 0
        self.rounds = 0

    def remaining(self) -> int:
        return max(0, self.total_tokens - self.spent_tokens)

    def can_afford(self, tokens: int) -> bool:
        return self.spent_tokens + tokens <= self.total_tokens

    def charge(self, tokens: int) -> None:
        if not self.can_afford(tokens):
            raise BudgetExhaustedError(
                f"charge {tokens} would exceed ceiling "
                f"({self.spent_tokens}/{self.total_tokens})"
            )
        self.spent_tokens += tokens

    def start_round(self) -> None:
        if self.rounds >= self.max_rounds:
            raise BudgetExhaustedError(f"max_rounds {self.max_rounds} reached")
        self.rounds += 1
