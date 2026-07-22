# v3 Cost & Power Plan (planning only, $0)

All figures use the frozen Haiku pricing observed in v2.2 (~$0.033/cell mean; up to ~$0.19 worst
per two-round cell). No spending is authorized here.

## Cost

**Gate A micro-pilot** (output-contract validity, A-condition only, ~8 tasks × 2 contract arms,
≤2 calls/cell incl. one repair-retry):
```
~ 8 tasks × 2 arms × ~1.3 calls × ~$0.033   ≈  $0.7   (worst-case ≈ $1.6)
```
Cheap by design — it answers "does the model emit the contract?" before any learning spend.

**Gate B** (full A/C/D/B1 learning run, if Gate A passes), per fold, mirroring v2.2:
```
C-training (18 train, sequential or batch) ≈ $0.7
held-out eval 4 conditions + A/C stability ≈ $1.6–2.1
per fold ≈ $2.3–2.8 ; three folds ≈ $7–8.5
```
A properly-powered confirmatory study (Decision E) plausibly needs ~50–120 unique tasks →
**$9–18** at these rates, excluding reps/retries/replication. **Current provider funding is
blocked**, so Gate B is not fundable today; Gate A alone (~$0.7) is the only near-term paid step,
and even it waits for a funded budget + finalized thresholds.

## Power

The v2.2 pilot was underpowered for two independent reasons:
1. **n = 8 tasks** — a paired McNemar on 8 units, with only 4 discordant pairs, cannot resolve
   anything short of a near-perfect separation.
2. **59% of cells never reached grading** — the output contract destroyed most of the signal, so
   effective information per task was far below one clean paired observation.

Fixing (2) via the robust contract is the higher-leverage move: it converts most cells into
informative paired observations, raising power per task before adding tasks. Rough targets:
```
directional v3 pilot     : ~27 held-out task-evals (the full corpus across 3 folds) — still a pilot
confirmatory (Decision E): ~50–120 unique tasks, discordant-rate-dependent, separate budget
per-family claims        : >= ~10 tasks/family — else family reporting stays descriptive
```
Exact power is computed FROM the Gate-A discordant-pair rate once the contract is fixed, not
assumed here. External-validity ceiling is unchanged by more Black bugs: one project, one
formatting arena, file-given single-file, Haiku-locked — cross-project generalization needs a
second corpus in a future study.

## Sequencing (cheapest informative step first)

```
1. (done, $0) v3 design + offline contract prototype + this plan
2. finalize Gate-A thresholds + fund a small budget            → operator decision
3. Gate-A micro-pilot (~$0.7)                                   → valid-patch rate under new contract
4. only if Gate A passes: build the v3 learning apparatus + Gate-B pre-registration + budget
5. Gate-B learning run                                         → the real C−A retest
```
Stop after step 1 (now). Steps 2+ each require a fresh explicit GO and funding.
