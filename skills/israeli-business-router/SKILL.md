---
name: israeli-business-router
description: Index of the installed Israeli and Hebrew business skills. Use when the task involves Israeli tax, VAT, bookkeeping, payroll, invoicing, debt collection, Israeli privacy or consumer-protection law, marketing to Israeli audiences, Hebrew SEO or surveys, or the Store Management product.
---

# Israeli and Hebrew business skills: what is installed and when to reach for it

Twenty-one skills covering Israeli regulation, accounting and marketing. They
arrive through claude.ai sync rather than `npx`, so they live under
`skills/synced/` and are not in `skills-manifest.json`. All are `name-only`:
Claude is shown the name but pays nothing for a description until one is called.

Read the row, then either run the skill or tell the user the slash command.

## Tax, accounting and money owed

| Need | Run |
|---|---|
| Double-entry journal entries (pkudat yoman), VAT, depreciation | `/israeli-bookkeeping-automation` |
| Payroll: income tax, Bituach Leumi, pension, bruto to neto | `/israeli-payroll-calculator` |
| Extract profit from a company: salary vs dividend vs shareholder loan | `/israeli-corporate-tax-strategy` |
| Issue or validate an e-invoice (hashbonit) against SHAAM | `/israeli-e-invoice` |
| Read a receipt or invoice and pull out the VAT | `/israeli-receipt-scanner` |
| Chase an unpaid invoice, up to a Michtav Drisha or small claims | `/israeli-client-payment-chaser` |

`israeli-corporate-tax-strategy` compares extraction methods and is the one to
reach for before moving money out of a company; `israeli-bookkeeping-automation`
records what already happened. They are easy to confuse.

## Law and compliance

| Need | Run |
|---|---|
| Privacy Protection Law, Amendment 13, database registration | `/israeli-privacy-shield` |
| Online store: Consumer Protection Law, returns, price display, IS 5568 | `/israeli-ecommerce-compliance` |
| Scan a Hebrew or RTL app for vulnerabilities and PPA compliance | `/israeli-appsec-scanner` |
| Support desk: Hebrew tickets, complaints, Sunday-to-Thursday SLA | `/israeli-customer-support-automator` |

Amendment 13 took effect on 14 August 2025, so anything written before that date
about Israeli privacy obligations is likely out of date.

## Marketing to an Israeli audience

| Need | Run |
|---|---|
| Paid ads: Google, Meta, Taboola, Outbrain, Yad2 | `/israeli-paid-ads` |
| Organic social: Facebook, Instagram, TikTok, LinkedIn in Hebrew | `/israeli-social-content` |
| Email sequences: RTL rendering, chagim timing, Chok HaSpam | `/israeli-email-sequences` |
| Hebrew SEO and GEO, google.co.il and AI search engines | `/hebrew-seo-geo-toolkit` |
| A survey in natural Hebrew, and when to send it | `/hebrew-survey-builder` |

Two things these share that are easy to get wrong without them: Hebrew RTL
rendering breaks in most email clients unless handled deliberately, and send
timing has to dodge chagim and the Friday-Saturday weekend.

## Store Management

| Need | Run |
|---|---|
| Plan a campaign or a 30-day content cycle | `/sm-campaign-plan` |
| Write, schedule and publish a post | `/sm-social-content` |
| Produce a brand visual in Hebrew RTL | `/sm-visuals` |
| Compare supplier cost prices for a restock line | `/supplier-price-comparison` |
| Match an external order file against the product catalogue | `/excel-catalog` |

`sm-visuals` is the one to run before uploading any image, not after.

## Personal

| Need | Run |
|---|---|
| The Maapilei Maroko 6 rental units: contracts, options, deposits | `/maapilei-maroko-6-rentals` |

## One warning

These skills state Israeli law and tax rules as of when they were written. They
are a starting point and a checklist, not advice to file or sign on. Anything
that goes to the Tax Authority, to a court, or into a contract wants a human
professional to confirm it first.
