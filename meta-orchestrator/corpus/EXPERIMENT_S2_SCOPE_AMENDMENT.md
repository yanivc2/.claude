# §2 Scope Amendment — target-file-set-given repair (FROZEN 2026-07-16)

**This does not edit Decision C in place.** It is a dated, hashed erratum that references the
original wording and corrects the operational scope after a pre-run, outcome-blind corpus audit.

- Amends: `corpus/EXPERIMENT_S2_DESIGN.md` → **Decision C** (original wording:
  *"§2 tests file-given single-file repair … the corpus is already filtered to
  single-file/near-single-hunk fixes"*).
- Bound to: corpus manifest `cee0c602…`, family map `4171f399373b`, D `5bd2d42c2da9`
  (all **UNCHANGED** by this amendment).
- Scope artifact: `corpus/s2_scope_metadata.json`, `scope_content_hash=79fae38b4074`.

## Erratum (binding)

> The original scope described all admitted tasks as file-given single-file repairs. A pre-run,
> outcome-blind corpus audit found that 4 of 27 admitted tasks require changes in multiple source
> files. The operational scope is therefore corrected to target-file-set-given repair. For each
> task, the agent receives exactly the source file or files modified by the reference repair and
> may modify only that fixed set. Localization and repository search remain out of scope.

## Operational definition (frozen)

- `allowed_source_files`: a frozen per-task list (in `s2_scope_metadata.json`), derived
  deterministically from the reference patch — **no manual edit, no outcome data**.
  - 23 tasks → **single_file** (one file).
  - 4 tasks → **multi_file**: `black-112` (2), `black-1632` (2), `black-593` (5),
    `cookiecutter-18` (2).
- The **same** file set is given to **all** conditions A/C/D/B1 for a task.
- Any write **outside** `allowed_source_files` is a **verifier failure**. The agent may not
  search for, add, or edit files beyond the frozen set. No content of the reference patch is used
  to hint *where inside* the files to change.
- Hidden (F2P) and public (P2P) tests are **unchanged**. Manifest, family map, folds, and D are
  **unchanged**.

## Validity note (honest)

This is a real scope *widening*, not merely a wording fix: multi_file tasks require cross-file
coordination and may be harder. Because the file set is *given* identically to every condition and
fixed before the run, it adds no differential capability between conditions and no localization
confound — the experiment still isolates the contribution of procedural memory. But the 27 must
**not** be presented, in retrospect, as a single-file corpus.

## Distribution audit (outcome-blind; `s2_scope_metadata.json`)

The 4 multi_file tasks are reasonably spread — no fold holds all four, no family (n≥4) is majority
multi_file:

- per fold: `{0: 2, 1: 2, 2: 0}`
- per family: `{whitespace: 2, iterator: 1, boundary: 1}`
- family multi-share: `whitespace 2/9, iterator 1/7, boundary 1/2` (boundary n=2, negligible)
- `concentration_ok = True`

**Because the spread is reasonable, the frozen folds are kept unchanged.** We do NOT re-sort the
folds to distribute multi_file tasks "nicely" (that would break the frozen 9/9/9 split). Had
concentration been abnormal, we would have declared it up front and added the sensitivity analysis
below rather than re-sorting retroactively.

## Reporting plan (binding on §2)

1. **Primary:** all 27 tasks under the frozen folds.
2. **Sensitivity:** the 23 single_file tasks only (does the conclusion survive without multi_file).
3. **Descriptive stratum:** the 4 multi_file tasks reported separately — **no strong conclusions**
   (n=4).

## D is NOT reopened

D was written under a "single-file" description, but its content is general advice and does not
exploit a single-file constraint. Reopening a frozen, independently-authored D would damage author
independence more than leaving it as-is. **D stays frozen (`author_frozen=true`, `5bd2d42c2da9`).**

## Order

`real family map ✅ → blind D packet ✅ → independent D authored + frozen ✅ → scope amendment + metadata (this) ✅ → wire the 27 real bugs (repo-backed reproduction) → micro-pilot`
