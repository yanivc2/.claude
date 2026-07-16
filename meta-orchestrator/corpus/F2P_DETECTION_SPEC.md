# F2P Test-Selection Spec (FROZEN before the post-fix run)

Frozen: 2026-07-16, before observing any post-fix result. General and methodological —
**no exceptions by bug id, project, revision, or desired outcome.** This spec fixes *which
tests are run* to detect the fail-on-buggy → pass-on-fixed (F2P) transition. It does NOT
touch admission thresholds, degenerate rejection, stability checks, learning-value metrics,
the fingerprint taxonomy, or the Gate-1 threshold — those are unchanged.

## Problem it fixes

The pre-fix detector ran only the test *files the fix commit touched*. In real projects the
fix often adds a **data fixture** (e.g. `tests/data/fmtskip6.py`) while the actual F2P test is
a pre-existing **parametrized test** elsewhere (e.g. `tests/test_format.py`) that consumes it.
Running only the touched files misses that test → the bug is mislabeled `likely_harness_gap`.

## Definitions

- **Fix test artifacts** = the files listed under the fix commit's `stat.tests` (PyBugHive).
- **Test module** = a `.py` file whose text contains `def test` or `class Test` (pytest-
  collectable). Detected by `is_test_module(text)`.
- **Fixture artifact** = any fix test artifact that is NOT a test module: data files
  (`.py`/`.yaml`/`.txt`/binary) under the tests tree, or `conftest.py`.
- **tests index** = every `.py` file under the repo's top-level `tests/` directory, read AFTER
  the fixed test artifacts are overlaid (so newly-added fixtures/tests are present).

## Selection algorithm (`plan_f2p_selection`)

Produces a run plan `[(test_file, keyword|None), ...]` plus a `selection_log`:

1. **Direct test modules.** Each fix test artifact that is itself a test module → run the whole
   file (`keyword = None`).
2. **Fixture → consumer tests (indirect).** For each fixture artifact:
   - `token` = the file's basename without extension (e.g. `fmtskip6`); for `conftest.py`,
     `token`s = the names defined by `def <name>` inside it (the fixtures it declares).
   - A **consumer** = any test-module in the tests index whose text contains `token` as a
     whole word (`\btoken\b`). This captures direct use (the test names the case) and indirect
     use (a helper/`@pytest.mark.parametrize` that takes the case name).
   - Each consumer file → run with `keyword = token` (pytest `-k token`), so only the
     parametrized cases tied to that fixture run — fast and targeted. This is how
     `conftest.py`, imported fixtures, and package-level fixtures are handled: we do not
     resolve fixture imports by hand; we run the consuming test file and let pytest's own
     conftest/fixture discovery (which walks up the package tree) resolve them.
3. **De-duplicate** by `(file, keyword)`. **Cap at 8 run entries**; if more, keep the entries
   whose token has the most consumers (deterministic, tie-broken by path) and **log the cap**
   (no silent truncation).
4. **Ambiguity / no relevant test.** If the plan is empty — a fixture artifact has zero
   consumers, or the fix touched only non-test files with no discoverable consumer — the
   candidate is classified `likely_harness_gap` (our detector cannot exercise it; this is a
   harness limit, never a claim about the bug).

## Execution & stability (unchanged)

- Each revision (buggy, then fixed) is exercised by running the full plan; every plan entry is
  a separate `pytest` invocation (`-o addopts=` to drop project cov flags; `-k token` when the
  entry carries one). Node results are merged across a revision's invocations.
- Each revision is run **twice** (stability). A node whose verdict differs across the two runs
  of the same revision makes the candidate `flaky` (rejected).
- Per-invocation timeout: **300 s**. Install timeout: **600 s**. A timeout is recorded; the
  candidate is not admitted. No retries beyond the fixed 2 stability runs.

## Classification (exact conditions)

Let `nodes` = the merged node set that ran on ALL four invocations (2 buggy + 2 fixed).

- **reproducible** ⇔ ∃ node that is `FAILED` on both buggy runs AND `PASSED` on both fixed runs,
  AND the sample is stable.
- **likely_harness_gap** ⇔ NOT reproducible AND ( the plan was empty, OR `nodes` is empty, OR
  ERROR nodes are ≥ half of the buggy nodes ) — i.e. we could not cleanly exercise the
  relevant test.
- **confirmed_non_reproducible** ⇔ NOT reproducible AND the plan was NON-empty AND `nodes` is
  non-empty AND there were **zero** ERROR nodes on both revisions AND the sample is stable AND
  no node showed the FAIL→PASS transition. (We ran the right tests cleanly and the expected
  transition simply did not occur.)
- **not_reproduced_under_current_harness** ⇔ NOT reproducible and none of the above (ambiguous;
  never asserted as a property of the bug).

## Post-fix run protocol

Re-run **all** pre-fix candidates (small-slice 4 projects + black), not only the 29 gaps, to
check for regressions, fingerprint consistency, unchanged admission, and a comparable sample.
The prior artifacts are preserved as `*_pre_f2p_detector_fix.json` and never overwritten.
