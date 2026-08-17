# Extraction contract (the hard rules)

Every rule here was learned from a real failure. Keep them on any platform.

## Schema
- **≤16 union-typed parameters.** The structured-output API rejects a schema with more than 16
  `["type","null"]`/`anyOf` params — every call 400s *before the model sees it*. Text fields are
  plain `"string"` with `""` = "absent"; only genuinely numeric fields stay `["number","null"]`
  (0 is a real quantity, so a placeholder there would corrupt a price). Gate: `count-unions.mjs`.
- `additionalProperties: false` everywhere; full `required` arrays; field rules live in the
  `description` strings (the model reads them).

## Values
- **Absolute values only.** The sign is derived from `doc_type` at save time (a credit note negates
  the line total). Never emit a negative number from extraction.
- Strip currency symbols / thousands separators; decimals as a plain number.
- Dates → `YYYY-MM-DD`, honouring a day-first locale on the page.
- **`barcode` ≠ `sku`.** The printed EAN and the internal item code are different columns.
- `unit_cost` is per *single* unit; when only a pack price is printed leave it `null` and let the
  host compute it from `pack_cost / unit_quantity`.
- **Never guess.** Unreadable → `""` (text) or `null` (number) + low confidence. A wrong number is
  far worse than a missing one.

## Prompt & cost
- The **static system prompt is byte-stable** and sent with an ephemeral cache marker, so it caches.
- **Per-supplier hints go in a separate, non-cached block** — never mutate the cached prompt.
- All pages of one invoice = **one** call, merged.
- **Cost ≈ `⌈w/28⌉ × ⌈h/28⌉` tokens per image.** The long edge is the price; colour and JPEG quality
  don't change it. Downscale to a max long edge (≈1800px is a good default). A PDF page adds
  ~1,500–3,000 text tokens — prefer in-app capture over uploading a PDF.

## Capture
- Prefer the OS camera (its autofocus/HDR/denoise beat a raw viewfinder frame grab).
- **Quality gate warns, never blocks** — a sharpness ratio (Laplacian variance ÷ contrast, so one
  threshold survives different phones) flags a blurry page but still lets it upload.
- Bake EXIF orientation into pixels (the API reads no metadata); keep page order by chosen order.

## Safety
- **A human approves before any financial value is written.** No exceptions.
- Catalog/barcode matches are **offers** — adopted on a click, never auto-written.
- **Attach, don't duplicate:** a scan matching an already-recorded invoice completes it; never
  overwrite a recorded amount — surface a difference as a warning.
- A failed extraction is a **draft state** with a friendly message + retry, and the real error
  logged — never a crash.
