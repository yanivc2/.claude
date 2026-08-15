MICR font for check printing (הדפסת צ׳קים)
==========================================

The check-print layout (/payments/:id/print) renders its bottom code line in a MICR
font. Until a bank-approved font is installed here, that line is a *placeholder* only —
it is NOT a scanner-valid magnetic line and the printed check stays a watermarked draft.

To activate real printing (no code change needed):

  1. Get your bank's written approval to self-print checks, plus their MICR spec.
     In Israel the standard is CMC-7; in the US/UK it is E-13B. Use whichever the bank
     approves — the layout just loads whatever font file you drop in below.

  2. Obtain the licensed MICR font and commit it here as:
        src/public/fonts/micr.woff2      (preferred)
        src/public/fonts/micr.woff       (optional fallback)
     The @font-face in views/payments/print.ejs already points at these paths and
     declares the family name "MICR".

  3. On Vercel (Project → Settings → Environment Variables) set:
        CHECK_PRINTING_APPROVED = true      → removes the DRAFT watermark
        CHECK_PRINTING_MICR_FONT = 1        → renders the code line in the MICR font
     Redeploy. The print page then shows "מוכן להדפסה".

  4. Before printing in quantity, verify the code-line symbol layout and the Standard-501
     field alignment against a real check with the bank. The code line is built in
     services/payments.js (getCheckPrintData → micrLine); adjust the symbol order there
     to match the bank's exact spec if needed.

Do not commit a font you are not licensed to redistribute.
