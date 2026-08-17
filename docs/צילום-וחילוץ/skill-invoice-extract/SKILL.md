---
name: invoice-extract
description: >-
  Capture a photo of a supplier invoice and extract its data with a language model into a
  structured, human-approved record. Use when a project needs invoice/receipt scanning →
  field extraction (supplier, numbers, dates, amounts, line items + barcodes) → review-before-save,
  and especially when each supplier's invoice layout should be LEARNED and improved over time.
  Triggers: "scan invoice", "extract invoice fields", "OCR receipt", "invoice capture",
  "חילוץ חשבונית", "צילום חשבונית", per-supplier extraction profile.
---

# invoice-extract

A portable method for turning an invoice photo into a structured record — **safely** (a human
approves before anything is written) and **improvingly** (each supplier's layout is learned).
This skill is the *method*; the learned per-supplier knowledge lives in **data** (`profiles/`),
not in this prose. The bundled scripts are the self-check ("the skill that checks the skill").

Adapt the specifics to the host platform, but do **not** re-invent the invariants below — each
was learned from a real production failure.

## The pipeline

```
camera/upload → quality gate (warn, not block) → LLM extraction (structured output)
  → normalize + validate (offline, pure) → HUMAN REVIEW & APPROVE → save/attach
                                   └── per-supplier profile learned from the diff ──┘
```

1. **Capture** — prefer the OS camera; downscale to a max long edge; bake EXIF orientation into
   pixels; keep page order by chosen order, not decode order.
2. **Quality gate** — a sharpness score that **warns**, never blocks (`references/extraction-contract.md`).
3. **Extract** — one LLM call per invoice, all pages merged, **structured output** against a JSON
   schema. Load the supplier's learned profile (if known) as a *second, non-cached* system block.
4. **Validate** — a pure function: flag/warn, never reject or auto-write. Match barcodes to a
   catalog as **offers** only.
5. **Review** — a human confirms/edits, then approves. Nothing financial is written before this.
6. **Learn** — diff the raw extraction vs the approved result for that supplier; update its profile.

## The hard invariants (do not violate)

Full text in `references/extraction-contract.md`. The non-negotiables:

1. **≤16 union-typed schema params.** The API rejects a structured-output schema with >16
   nullable/`anyOf`/type-array parameters — *every* call 400s before reaching the model. Keep text
   fields plain `"string"` with `""` meaning "absent"; only genuinely numeric fields stay nullable.
   Run `scripts/count-unions.mjs <schema.json>` as a gate — it fails above 16.
2. **Absolute values only; sign derives from `doc_type`** (a credit note negates the line total, at
   save time — not inside the extraction).
3. **Quality gate warns, never blocks.**
4. **Human approves. No financial value is ever auto-written.** Catalog matches are *offers*.
5. **Attach, don't duplicate:** a scan of an already-recorded invoice completes it; never overwrite
   a recorded amount — surface a discrepancy as a warning.
6. **Cost lever = the image's long edge** (≈`⌈w/28⌉×⌈h/28⌉` tokens). Colour and JPEG quality don't
   change cost. A PDF page costs ~1,500–3,000 extra text tokens — prefer in-app capture over PDF.
7. **A failed extraction is a state, not a crash** — a draft with a friendly message + "try again",
   and the real error logged.
8. **The static system prompt is byte-stable and cached.** Per-supplier hints go in a *separate*,
   non-cached block so caching still pays off.

## Per-supplier learning loop

The whole point: each supplier's invoice looks different, so steer the extractor per supplier.

- **Signal** (usually already available): after approval, diff the raw extraction against the
  human-approved result *for that supplier*.
- **Profile** — store per supplier as JSON: which column is cartons vs singles, where the
  allocation number sits, date format, house barcode shape, recurring name normalizations, and a
  **confidence per rule that grows with repetition** (seen once = hint; confirmed 5× = firm rule).
  See `profiles/_TEMPLATE.json`.
- **Inject** — on the next scan for that supplier, add the hints to the **user message** (not the
  cached system prompt — keep that byte-stable). Requires knowing the supplier *before* extraction:
  a cheap ID pre-pass, the store's dominant supplier, or the user picking the supplier at capture.
- **Readiness** — `new` (no scans) → `learning` (clean streak < 3) → `ready` (3 scans approved
  untouched). One correction resets the streak.
- **Safety** — a new rule enters as a *candidate* and is promoted only after it REPEATS (>= 2) and
  the validator confirms it didn't regress other fields.

> **Reference implementation:** this exact loop is live and test-covered in the AP-Control app —
> `src/services/supplierProfile.js` (pure `learnFromScan`/`hintsFor`/`readiness`, wired into
> `src/services/scan.js` at extract-time and approve-time) with `test/supplier-profile.test.js`.
> `profiles/_TEMPLATE.json` mirrors its profile shape and thresholds. Port from it, don't re-derive.

## Self-check (the validator)

Run these before shipping and after any profile change — this is the "skill that checks the skill":

- `node scripts/count-unions.mjs references/schema.template.json` — schema union gate (≤16).
- `node scripts/check-invariants.mjs <extraction.json> [schema.json]` — the extraction obeys the
  invariants (text fields are strings, numbers are number|null, amounts non-negative, `doc_type`
  in enum).
- `node scripts/regression.mjs <expected.json> <actual.json>` — field-level known-answer diff with a
  pass ratio. Keep a fixture (real invoice → expected JSON) per supplier and overall; watch the
  ratio for **drift** over time.

Scripts are dependency-free Node ESM (Node 18+). `fixtures/` has a passing demo pair.

## Building it on a new platform

Don't guess the platform — interview first, then build. The copy-paste interview prompt lives in
`../הטמעה-סקיל-ופרומפט.md` (part 3). Map each pipeline stage to the host's camera/upload, LLM SDK,
data store, and review UI; keep every invariant above.
