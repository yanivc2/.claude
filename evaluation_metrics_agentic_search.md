# Evaluation Metrics for Agentic Search — A Practitioner's Handbook

> A study-oriented reference. It builds from classical information-retrieval (IR)
> metrics up to the metrics that are specific to *agentic* search — systems where
> an LLM plans, issues multiple queries, calls tools, reads results, and iterates
> toward an answer. Every metric is defined precisely, motivated, illustrated with
> a worked example, and accompanied by its failure modes.

---

## 0. How to read this document

Read it top to bottom the first time — each layer assumes the one before it:

1. **Framing** (§1) — why agentic search is hard to evaluate.
2. **The measurement taxonomy** (§2) — the five axes you actually score.
3. **Retrieval metrics** (§3) — the IR foundation (Precision, Recall, MRR, MAP, nDCG).
4. **Answer-quality metrics** (§4) — EM/F1, semantic, faithfulness, attribution.
5. **Agentic-process metrics** (§5) — trajectory, tool use, efficiency, cost.
6. **LLM-as-judge** (§6) — how to score open-ended output reliably.
7. **Benchmarks & datasets** (§7) — what to test against.
8. **Building a harness** (§8) — golden sets, offline/online, CI, tooling.
9. **Statistics** (§9) — so your numbers mean something.
10. **Anti-patterns** (§10) and a **recommended scorecard** (§11).
12. **Glossary** (§12) and **further reading** (§13).

Notation used throughout: `Q` = set of evaluation queries/tasks; `k` = cutoff rank;
`rel_i` = relevance of the item at rank `i`; `[·]` = Iverson bracket (1 if true, else 0).

---

## 1. Why evaluating agentic search is different

Classical search returns a ranked list of documents for a single query, and IR has
50 years of metrics for that. **Agentic search breaks every simplifying assumption
that those metrics rely on:**

| Assumption in classical IR | What agentic search does instead |
|---|---|
| One query → one ranked list | Many queries, reformulated over several turns |
| Relevance is per-document | "Relevance" is spread across a *trajectory* of retrievals |
| The output is the ranking | The output is a *synthesized answer* with citations |
| Fixed corpus, offline | Live web/tools, non-deterministic, changes hour to hour |
| Cost is ~constant | Cost/latency vary 10–100× with the number of agent steps |
| Deterministic | Same input can produce different paths on re-run |

Two consequences you must internalize:

- **You have to evaluate *both* the destination and the journey.** A correct answer
  reached through 14 redundant searches and a hallucinated intermediate step is not
  the same quality as the same answer in 2 searches with clean grounding — even
  though a naive "answer correctness" metric scores them identically.
- **No single number suffices.** Agentic search quality is inherently
  multi-objective: correctness *and* grounding *and* efficiency *and* cost *and*
  robustness. Collapsing them too early hides regressions.

---

## 2. The measurement taxonomy — the five axes

Every metric in this document scores one of five axes. Keep this table pinned; it is
the mental model.

| Axis | Question it answers | Example metrics |
|---|---|---|
| **A. Outcome quality** | Is the *final answer* correct and useful? | EM, F1, LLM-judge correctness, task success rate |
| **B. Retrieval quality** | Did we *find* the right evidence? | Recall@k, nDCG, context precision/recall |
| **C. Grounding / attribution** | Is the answer *supported* by what we found? | Faithfulness, citation precision/recall, attribution |
| **D. Process quality** | Was the *trajectory* efficient and sound? | Step count, tool-selection accuracy, redundancy, recovery |
| **E. Cost & efficiency** | What did it *cost* to get there? | Latency, tokens, \$/query, number of tool calls |

A mature evaluation reports at least one metric per axis. The classic mistake is
measuring only **A** (answer correctness) and shipping a system that is correct but
ungrounded (**C**), slow (**E**), or brittle (**D**).

---

## 3. Retrieval metrics (the IR foundation)

These score **Axis B**: the quality of the retrieved set/ranking at any single
retrieval step (or, aggregated, across the whole run). They require *relevance
judgments* — a labeled notion of which documents are relevant to the query.

Set up a running example. For a query, the top-10 retrieved items have relevance
(1 = relevant, 0 = not):

```
rank:  1  2  3  4  5  6  7  8  9  10
rel:   1  0  1  1  0  0  1  0  0  0
```

Assume there are **5** relevant documents in the whole corpus for this query.

### 3.1 Precision@k and Recall@k

- **Precision@k** = fraction of the top-k that is relevant.
  `P@k = (1/k) · Σ_{i=1..k} rel_i`
- **Recall@k** = fraction of *all* relevant docs that appear in the top-k.
  `R@k = (Σ_{i=1..k} rel_i) / (total relevant)`

Worked (k = 5): relevant in top-5 = {1,3,4} → 3 hits.
`P@5 = 3/5 = 0.60`. `R@5 = 3/5 = 0.60` (5 total relevant).

For agentic search, **Recall@k at the point of answer generation is often the single
most important retrieval metric**: if the evidence never entered the context, the
generator cannot possibly ground a correct answer. Precision matters for cost and for
not drowning the generator in noise, but recall bounds the achievable answer quality.

### 3.2 Hit Rate @k (a.k.a. Success@k)

`HitRate@k = [ at least one relevant doc in top-k ]`, averaged over queries.
A coarse but intuitive "did we surface *anything* useful" signal. Useful as a floor.

### 3.3 MRR — Mean Reciprocal Rank

Rewards putting the *first* relevant result high. For each query, take the reciprocal
of the rank of the first relevant item; average over queries.

`MRR = (1/|Q|) · Σ_{q∈Q} 1/rank_of_first_relevant_q`

Example: first relevant is at rank 1 → RR = 1/1 = 1.0. If it were at rank 3 → 0.33.
MRR is the right metric when the agent only needs *one* good hit to proceed
(e.g. "find the doc that answers this sub-question").

### 3.4 MAP — Mean Average Precision

Average Precision (AP) rewards ranking *all* relevant docs highly. Compute precision
at each rank where a relevant doc occurs, then average over the relevant docs.

`AP = ( Σ_{k: rel_k = 1} P@k ) / (total relevant)`

Worked: relevant at ranks 1, 3, 4, 7.
- P@1 = 1/1 = 1.00
- P@3 = 2/3 = 0.667
- P@4 = 3/4 = 0.750
- P@7 = 4/7 = 0.571

`AP = (1.00 + 0.667 + 0.750 + 0.571) / 5 = 2.988 / 5 = 0.598`
(Divide by 5 = total relevant, not by 4 = the number found — this penalizes the
missing 5th relevant doc.) **MAP** = mean of AP over all queries.

### 3.5 nDCG — Normalized Discounted Cumulative Gain

The workhorse for *graded* relevance (relevance is 0/1/2/3, not just 0/1) and the most
widely reported ranking metric. Two ideas: **gain** (more relevant = more valuable)
and **discount** (lower ranks are worth less, logarithmically).

`DCG@k = Σ_{i=1..k} (2^{rel_i} − 1) / log2(i + 1)`

Normalize by the **ideal** DCG (the DCG of the perfect ranking) so the score is 0–1:

`nDCG@k = DCG@k / IDCG@k`

Worked with binary relevance, k = 5, rel = [1,0,1,1,0]:
- gains `2^rel − 1` = [1,0,1,1,0]; discounts `log2(i+1)` = [1, 1.585, 2, 2.322, 2.585]
- DCG@5 = 1/1 + 0 + 1/2 + 1/2.322 + 0 = 1 + 0.5 + 0.431 = **1.931**
- Ideal ranking puts the three relevant first: IDCG@5 = 1/1 + 1/1.585 + 1/2 = 1 + 0.631 + 0.5 = **2.131**
- `nDCG@5 = 1.931 / 2.131 = 0.906`

Use nDCG when you have human graded judgments and care about the *whole* ordering.

### 3.6 Context Precision & Context Recall (RAG-specific)

When retrieval feeds a generator, evaluate the *context* actually passed in:

- **Context Recall** = fraction of the ground-truth answer's claims that are supported
  by the retrieved context. Directly measures "did retrieval bring back enough?"
- **Context Precision** = are the relevant chunks ranked above the irrelevant ones in
  the context window (signal-to-noise of the context).

These are the retrieval metrics popularized by RAGAS and are usually computed with an
LLM judge rather than exact labels, because "supports this claim" is semantic.

### 3.7 Aggregating retrieval metrics over an agentic run

An agent retrieves many times. Options, from coarse to fine:
- **Union recall**: over the *entire* run, did the union of all retrieved evidence
  contain everything needed? (Answers: "was the information ever available?")
- **Per-step nDCG/precision**: ranking quality of each individual search (answers:
  "is each query well-formed?").
- **Coverage**: fraction of the required *evidence set* (for multi-hop, all the hops)
  that was retrieved. Critical for multi-hop QA where partial evidence = wrong answer.

---

## 4. Answer-quality metrics (Axis A + C)

Now score the *synthesized answer*.

### 4.1 Lexical: Exact Match (EM) and token-F1

- **Exact Match**: `[ normalized_prediction == normalized_gold ]`. Normalization =
  lowercase, strip punctuation/articles. Brutal but unambiguous; used by SQuAD,
  HotpotQA, Natural Questions.
- **Token-level F1**: treat prediction and gold as bags of tokens.
  `precision = |pred ∩ gold| / |pred|`, `recall = |pred ∩ gold| / |gold|`,
  `F1 = 2·P·R / (P + R)`.

Worked: gold = "the Eiffel Tower", pred = "Eiffel Tower". After removing the article,
tokens match → F1 = 1.0, EM = 1 (if normalization strips "the").

**Limitation**: lexical metrics punish correct paraphrases ("JFK" vs "John F.
Kennedy") and reward lucky word overlap. For agentic/open-ended answers they are a
weak floor, not a verdict.

### 4.2 Semantic: embedding similarity & BERTScore

- **BERTScore**: token-level cosine similarity between contextual embeddings of
  prediction and reference, then greedy-matched P/R/F1. Handles paraphrase.
- **Embedding cosine**: single-vector similarity of answer vs reference. Cheap, coarse.

Better than lexical for paraphrase, but they reward *topical* similarity even when the
answer is factually wrong ("Paris is the capital of Germany" is embedding-close to the
correct sentence). Do not use alone for factuality.

### 4.3 LLM-as-judge correctness

The dominant method for open-ended answers: prompt a strong model with the question,
the reference (if any), and the candidate, and ask for a correctness judgment against
a rubric. Covered in depth in §6. This is usually your primary **Axis A** metric for
non-extractive tasks.

### 4.4 Faithfulness / Groundedness (Axis C)

Does every claim in the answer follow from the retrieved evidence? Independent of
whether the answer is *correct* — it measures hallucination.

`Faithfulness = (# answer claims supported by context) / (# answer claims)`

Procedure: (1) decompose the answer into atomic claims; (2) for each, ask a judge
whether the context entails it; (3) take the fraction. A faithful answer can still be
wrong (if the *evidence* was wrong), and a correct answer can be *unfaithful* (right by
luck / parametric memory). You want both correctness **and** faithfulness high.

### 4.5 Answer Relevance

Does the answer actually address the question (vs. being correct-but-off-topic or
padded)? Often computed by having a model generate questions the answer would answer,
then measuring similarity to the original question.

### 4.6 Citation / Attribution quality

For agentic *research* systems that cite sources, this is a first-class axis:

- **Citation Precision** = fraction of cited sources that actually support the claim
  they are attached to.
- **Citation Recall** = fraction of claims that *should* be cited and *are* (and are
  supported). Related to the ALCE/attribution literature: "citation recall" and
  "citation precision" as defined for attributed QA.
- **Attribution rate** = fraction of statements traceable to a retrieved source at all.

A deep-research agent with 90% answer correctness but 40% citation precision is
producing confident, well-written, poorly-sourced text — a serious and common failure
that only this axis catches.

---

## 5. Agentic-process metrics (Axis D + E)

This is the section that separates agentic-search evaluation from RAG evaluation.
You are now scoring the *trajectory*: the sequence of thoughts, queries, tool calls,
and observations.

### 5.1 Task Success Rate (goal completion)

The headline outcome metric for agents. `SuccessRate = (# tasks solved) / (# tasks)`,
where "solved" is defined per task by a checker (exact answer, a verifier function, or
a judge). For multi-part tasks, also report **partial / sub-goal completion** — the
fraction of required sub-goals achieved — so you can see *how close* failures were.

### 5.2 Trajectory efficiency

- **Step count**: number of agent turns / tool calls to completion. Report the
  distribution (median + p90), not just the mean — agent cost is heavy-tailed.
- **Search count & query efficiency**: number of search calls issued; ratio of useful
  searches to total. An agent that finds the answer in 2 searches beats one that needs
  9 for the same answer.
- **Redundancy rate**: fraction of steps that were repeated or that added no new
  information (e.g. re-issuing a near-duplicate query, re-reading the same page).
- **Optimal-path ratio**: steps taken / minimum steps needed (when a reference path
  exists). >1 means detours.

### 5.3 Tool-use correctness

- **Tool-selection accuracy**: at each decision, did the agent pick the right tool
  (search vs. calculator vs. code vs. answer)? Score against an oracle or a judge.
- **Tool-call validity**: fraction of tool calls that were well-formed and executed
  without a schema/argument error.
- **Argument quality**: were the query strings / parameters good? (e.g. a search query
  that is specific vs. a vague restatement of the task.)

### 5.4 Reasoning & robustness

- **Recovery rate**: when a search returns junk or a tool errors, does the agent
  detect it and adapt, or does it barrel on? Measured as fraction of injected-failure
  cases the agent recovers from.
- **Groundedness of intermediate steps**: are the agent's *interim* conclusions
  supported by what it has seen so far (not just the final answer)?
- **Loop / non-termination rate**: fraction of runs that hit the step budget without
  finishing.
- **Determinism / consistency**: run the same task N times; report answer-agreement
  and success-rate variance. High variance is itself a quality defect.

### 5.5 Cost & efficiency (Axis E)

Always report these alongside quality — they are the denominator of every quality
claim:

- **Latency**: end-to-end wall-clock (median, p90, p99).
- **Token usage**: prompt + completion tokens per task (drives cost and context
  pressure).
- **Monetary cost**: \$/task (model calls + tool/API calls).
- **Tool-call count**: proxy for external cost and rate-limit exposure.

The right way to read quality vs. cost is a **Pareto frontier**: plot success rate
against \$/task (or latency). A change that improves success by 1pt while tripling cost
is usually a regression, and only the frontier view makes that visible.

---

## 6. LLM-as-judge — doing it without fooling yourself

Most agentic-search outputs are open-ended, so an LLM judge is unavoidable. It is
powerful and *dangerously easy to misuse*. Treat the judge as a measurement instrument
that itself must be calibrated.

### 6.1 Judge designs

- **Pointwise (absolute)**: score one output against a rubric (e.g. 1–5, or a set of
  yes/no criteria). Simple; scores are comparable across systems; but models are poorly
  calibrated on absolute scales.
- **Pairwise (comparative)**: "is A or B better?" More reliable than absolute scores;
  the basis of preference leaderboards. Cost is O(n²) for full ranking — use
  swiss/elo-style sampling for many systems.
- **Reference-based vs. reference-free**: with a gold answer the judge checks
  equivalence (more reliable); without one it judges intrinsic quality (needed for
  open research tasks).
- **Rubric decomposition**: instead of one holistic score, ask several targeted yes/no
  questions (correct? grounded? complete? cites sources?) and aggregate. More reliable
  and more diagnosable than a single 1–10.

### 6.2 Known judge biases (and mitigations)

| Bias | What happens | Mitigation |
|---|---|---|
| **Position bias** | Prefers the first (or second) option in pairwise | Swap order, average both; or randomize and report |
| **Verbosity bias** | Prefers longer answers | Length-control the rubric; penalize unsupported padding |
| **Self-preference** | A model favors text from its own family | Use a different judge family than the system under test |
| **Sycophancy / authority** | Swayed by confident tone or a claimed "expert" | Rubric forces evidence checks, not vibes |
| **Formatting bias** | Prefers markdown/lists | Normalize formatting before judging |

### 6.3 Calibrate the judge against humans

An LLM judge is only trustworthy once you have measured its **agreement with human
labels** on a sample. Report inter-rater agreement:

- **Cohen's κ** (two raters) / **Fleiss' κ** (many): agreement corrected for chance.
  Rough reading: κ > 0.8 strong, 0.6–0.8 substantial, 0.4–0.6 moderate, <0.4 weak.
- **% agreement** and confusion matrix vs. human gold on a held-out set.

If judge↔human κ is low, fix the rubric before trusting *any* number the judge
produces. Re-validate whenever you change the judge model or prompt.

### 6.4 Practical judge hygiene

- Pin the judge model **version**; a silent provider update changes your metric.
- Use temperature 0 (or low) and a fixed prompt; version the prompt.
- Have the judge output **structured** verdicts + a short justification (auditable).
- Keep a small **human-labeled gold set** as the judge's own regression test.

---

## 7. Benchmarks & datasets

Use established benchmarks for comparability, plus a private set that matches *your*
domain (public benchmarks leak into training data and overstate real performance).

### 7.1 Retrieval

- **BEIR** — 18 heterogeneous retrieval tasks; the standard zero-shot retrieval
  benchmark (reports nDCG@10). Good for the retriever component in isolation.
- **MTEB** — broad embedding benchmark (retrieval + clustering + reranking + …).
- **TREC** tracks (Deep Learning, RAG) — human-judged, gold-standard IR evaluation.

### 7.2 Multi-hop / reasoning QA (the core of agentic search)

- **HotpotQA** — 2-hop questions over Wikipedia with supporting-fact annotations
  (enables grounding evaluation, not just answer EM/F1).
- **2WikiMultiHopQA** — multi-hop with explicit reasoning paths.
- **MuSiQue** — 2–4 hop, constructed to *require* genuine multi-step reasoning
  (resistant to shortcuts).
- **Bamboogle** — hand-crafted 2-hop questions that single-hop search fails on.
- **StrategyQA** — implicit multi-hop yes/no reasoning.

### 7.3 Open-domain / factuality

- **Natural Questions, TriviaQA, WebQuestions** — open-domain QA staples.
- **FRAMES** — factuality + retrieval + reasoning over multiple documents in one bench.
- **PopQA** — long-tail entity questions (exposes parametric-memory gaps).

### 7.4 Agentic / research / web-browsing

- **GAIA** — real-world assistant tasks needing tool use, web browsing, multi-step
  reasoning; graded by difficulty level. A key general-agent benchmark.
- **BrowseComp** — hard web-browsing questions whose answers are hard to find but easy
  to verify; targets persistent, multi-step searching.
- **AssistantBench** — realistic, time-consuming web tasks.
- **WebArena / VisualWebArena / Mind2Web** — execute real tasks in live/simulated web
  environments (more "web agent" than "search", but overlapping).
- **Deep-research–style evals** (e.g. long-form research report benchmarks) — score
  report correctness, coverage, and citation quality together.

> Caveat: for anything public, assume some contamination. The trustworthy number is on
> a **fresh, private, domain-matched** set that you label and rotate.

---

## 8. Building an evaluation harness

Metrics are only useful inside a repeatable harness.

### 8.1 The golden dataset

- **Composition**: cover the query *types* you serve (factual, multi-hop,
  comparative, time-sensitive, unanswerable). Include **negative / unanswerable**
  cases — a good agent says "I couldn't find it," and only these cases measure that.
- **Size**: enough for statistical power (see §9). Dozens is a smoke test; low-hundreds
  is a working set; thousands for tight confidence intervals on small deltas.
- **Labels**: gold answer, the required evidence/sources, and (ideally) an acceptable
  reference trajectory or the minimum number of hops.
- **Hygiene**: keep a private hold-out; rotate items; track provenance; freeze
  versions so scores are comparable over time.

### 8.2 Offline vs. online evaluation

- **Offline** (on the golden set): fast, deterministic-ish, gates every change. This
  is your CI signal.
- **Online** (in production): the ground truth of usefulness.
  - *Implicit signals*: click/dwell, answer-copy, follow-up reformulation rate (a
    reformulation often means the last answer failed), task abandonment.
  - *Explicit signals*: thumbs up/down, "was this helpful?", human review queues.
  - *A/B tests*: the gold standard for causal impact on real users.

### 8.3 Regression testing & CI

- Run the offline suite on every meaningful change (prompt, model, retriever, tool).
- Gate merges on **no regression beyond noise** on the primary axes.
- Keep **per-example** history so you can see *which* cases flipped, not just the
  aggregate — aggregates hide compensating changes (5 fixed, 5 broken = "no change").
- Alert on **cost/latency** regressions too, not only quality.

### 8.4 Tooling (landscape, not endorsement)

- **RAGAS** — faithfulness, answer relevance, context precision/recall for RAG.
- **TruLens** — feedback functions / groundedness for LLM apps.
- **DeepEval** — pytest-style LLM eval assertions, good for CI.
- **LangSmith, Braintrust, Arize Phoenix, Langfuse** — tracing + eval platforms that
  capture full agent trajectories (essential for Axis D metrics) and run judge evals.
- **promptfoo** — matrix testing of prompts/models with assertions.

The non-negotiable capability for agentic search: **trace capture** of the full
trajectory (every thought, query, tool call, observation). You cannot compute
process metrics (§5) from input/output alone.

---

## 9. Statistics — making the numbers mean something

Agentic systems are **noisy** (non-deterministic paths, judge variance). Without
statistics you will chase noise.

- **Report variance.** Run each task multiple times (e.g. 3–5); report mean **and**
  spread. `pass@k` (solved in ≥1 of k tries) and `pass^k`/consistency (solved in *all*
  k tries) tell different, both-useful stories.
- **Confidence intervals.** For a success rate `p` over `n` tasks, the normal-approx
  95% CI is `p ± 1.96·√(p(1−p)/n)`. Example: p = 0.70, n = 100 → ±0.09. So "70%" is
  really "61–79%" — a 3-point "improvement" on n=100 is **noise**. Prefer Wilson or
  bootstrap intervals for small n or extreme p.
- **Significance for A/B between systems.** Paired tasks → McNemar's test (for
  binary success) or a paired bootstrap on the metric. Don't eyeball two means.
- **Sample size.** To detect a δ-point difference you need roughly
  `n ≈ 16·p(1−p)/δ²` per arm (for 80% power, α=0.05, rough rule). Detecting a 3-point
  move around p=0.5 needs ~4,400 samples/arm — which is why small eval sets can't
  resolve small deltas. Know your resolution before claiming a win.
- **Multiple comparisons.** If you test many metrics/slices, correct for it
  (Bonferroni/Benjamini-Hochberg) or you'll "find" spurious wins.

---

## 10. Anti-patterns (learn these cold)

1. **Single-number worship.** Reporting only answer-correctness hides grounding, cost,
   and robustness regressions. Always report per-axis.
2. **Ignoring the trajectory.** Judging only input→output means a lucky-but-hallucinated
   path scores the same as a clean one. Capture and score traces.
3. **Uncalibrated LLM judge.** Trusting judge scores without ever measuring
   judge↔human agreement. Calibrate first, re-calibrate on every judge change.
4. **Benchmark contamination.** Reporting stellar public-benchmark numbers that don't
   transfer because the data was in pretraining. Keep a private set.
5. **No unanswerable cases.** A set with only answerable questions can't detect
   overconfident hallucination; the system learns to always answer.
6. **Lexical metrics on open-ended answers.** EM/F1 punish correct paraphrases and
   reward word-overlap; misleading for synthesized answers.
7. **Mean-only reporting.** Agent cost and step counts are heavy-tailed; the mean hides
   the p90 disasters. Report distributions.
8. **Cost-blind quality claims.** "+2% success" while doubling latency/\$ is often a
   loss. Always show the quality–cost frontier.
9. **No significance testing.** Declaring a winner from a 2-point move on 100 examples.
   That's inside the confidence interval.
10. **Static eval set forever.** Real query distributions drift; a frozen set slowly
    stops representing production. Rotate and refresh.
11. **Aggregate-only history.** Without per-example tracking you miss compensating
    changes (equal numbers fixed and broken).

---

## 11. A recommended default scorecard

A pragmatic starting stack for an agentic-search system. Adapt thresholds to your
domain; report all of it, every eval run.

| Axis | Metric | Why it's in the core set |
|---|---|---|
| A Outcome | **Task success rate** (judge or verifier), + sub-goal completion | The headline: did it solve the task? |
| A Outcome | **Answer F1 / EM** on extractive slice | Cheap, objective floor where gold exists |
| B Retrieval | **Union recall** of required evidence over the run | Upper-bounds achievable correctness |
| B Retrieval | **nDCG@10** per search (or context precision) | Query/ranking quality |
| C Grounding | **Faithfulness** | Catches hallucination independent of correctness |
| C Grounding | **Citation precision / recall** | For any system that cites sources |
| D Process | **Median & p90 step count**; **redundancy rate** | Trajectory efficiency & bloat |
| D Process | **Tool-selection accuracy**; **recovery rate** | Agentic soundness & robustness |
| D Process | **Consistency** across N reruns | Non-determinism is a defect |
| E Cost | **Latency p50/p90**, **tokens/task**, **\$/task** | The denominator of every quality claim |

Read it as a **vector**, plotted over time, with confidence intervals — never collapse
it to one scalar for decision-making.

### 11.1 A worked mini-example (end to end)

Task: *"Which university did the person who invented the World Wide Web attend, and in
what year did they graduate?"* (a 2-hop question).

- **Trajectory captured**: search("who invented the World Wide Web") → reads "Tim
  Berners-Lee" → search("Tim Berners-Lee university") → reads "The Queen's College,
  Oxford; graduated 1976" → answers with two citations.
- **Scoring**:
  - Outcome (A): answer = "Queen's College, Oxford; 1976" → matches gold → success = 1;
    F1 = 1.0.
  - Retrieval (B): both required hops (inventor, alma-mater+year) retrieved →
    union-recall = 2/2 = 1.0; per-search nDCG high.
  - Grounding (C): both claims entailed by cited pages → faithfulness = 1.0; citation
    precision = 2/2 = 1.0.
  - Process (D): 2 searches, 0 redundant, correct tool each time, no loop; optimal-path
    ratio = 1.0.
  - Cost (E): 2 tool calls, ~4k tokens, 6s latency, \$0.01.
- A **contrast** case that a naive metric would score identically: the agent recalls
  "Oxford, 1976" from parametric memory *without* the second search. Outcome F1 still
  1.0 — but union-recall for hop 2 = 0, faithfulness drops (claim not grounded in
  retrieved context), citation recall < 1. **This is exactly the failure the multi-axis
  scorecard exists to expose.**

---

## 12. Glossary

- **Agentic search** — search where an LLM plans, issues multiple queries, uses tools,
  reads results, and iterates toward a synthesized, often cited, answer.
- **Trajectory** — the full ordered sequence of an agent's thoughts, tool calls, and
  observations for one task.
- **Grounding / Faithfulness** — degree to which the answer's claims are entailed by the
  retrieved evidence (a hallucination measure), independent of correctness.
- **Attribution** — the ability to trace each statement to a specific supporting source.
- **Relevance judgment (qrel)** — a human/oracle label of whether a document is relevant
  to a query; the input to IR metrics.
- **Graded relevance** — relevance on a scale (e.g. 0–3) rather than binary; required by
  nDCG.
- **LLM-as-judge** — using a language model to score outputs against a rubric.
- **pass@k / pass^k** — solved in at least one of k runs / in all k runs; captures
  best-case vs. consistency.
- **Pareto frontier** — the set of configurations where you can't improve one objective
  (e.g. quality) without worsening another (e.g. cost).
- **Contamination** — benchmark data having leaked into a model's training set,
  inflating scores.
- **DCG / IDCG** — Discounted Cumulative Gain and its ideal (max) value; ratio = nDCG.

## 13. Further reading (starting points)

- Manning, Raghavan & Schütze, *Introduction to Information Retrieval* — the canonical
  source for Precision/Recall/MAP/nDCG.
- **BEIR** (Thakur et al.) and **MTEB** (Muennighoff et al.) — retrieval/embedding
  benchmarks.
- **HotpotQA** (Yang et al.), **MuSiQue** (Trivedi et al.), **2WikiMultiHopQA** — multi-hop
  QA with supporting-fact supervision.
- **RAGAS** (Es et al.) — reference-free RAG metrics (faithfulness, answer/context
  relevance).
- **"Judging LLM-as-a-Judge"** (Zheng et al., MT-Bench/Chatbot Arena) — judge reliability
  and biases.
- **ALCE** (Gao et al.) — automatic evaluation of citation/attribution in generation.
- **GAIA** (Mialon et al.) and **BrowseComp** (OpenAI) — general-agent and
  web-browsing benchmarks.
- TREC Deep Learning / RAG tracks — human-judged IR/RAG evaluation methodology.

> Verify exact definitions against the primary sources before you cite numbers — this
> handbook teaches the *method*; papers own the precise variants.
