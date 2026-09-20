---
paths:
  - "settings.json"
  - ".claude/settings.json"
  - "commands/skills-audit.md"
---

# Skills inventory & triage

> **Applies to:** deciding which claude.ai-synced skills stay enabled. Loaded on
> demand. Explanations in Hebrew (rule #3); skill identifiers stay in English.
> Last triaged: 2026-09-20.

## עובדת יסוד

ה־skills המסונכרנים מ־claude.ai **אינם בריפו** — `.gitignore` מחריג `skills/`.
הם חיים רק ב־`~/.claude/skills/` על המכונה ומסתנכרנים מ־claude.ai.

- **מחיקה מקומית חוזרת בסנכרון הבא.** הבקרה: `/skills` (השבתה) או claude.ai (הסרה/כיבוי מוחלט).
- **synced לא ניתן לעריכה במקום.** להתאמה אמיתית — לשכפל ל־skill מקומי דרך `skill-creator`.
- כל skill דלוק מוסיף לפרומפט המערכת בכל תור (~20–350 טוקנים); לכן צמצום = חיסכון context.

## פרופיל השימוש (עוגן להחלטות)

עסק ישראלי + פיתוח: `israeli-hr-system` (Next.js, שכר/טופס 101/סקרי 30-60-90),
אפליקציית ספקים/מינימרקט "Store Management", כספת Obsidian, פיננסים לעסק ישראלי,
שיווק דרך Metricool. עברית + RTL.

## ✅ להשאיר דלוקים

- **פיננסים/רגולציה ישראלי:** `israeli-payroll-calculator`, `israeli-bookkeeping-automation`,
  `israeli-e-invoice`, `israeli-receipt-scanner`, `israeli-client-payment-chaser`,
  `israeli-corporate-tax-strategy`, `israeli-ecommerce-compliance`, `israeli-privacy-shield`,
  `israeli-appsec-scanner`
- **המוצרים:** `sm-campaign-plan`, `sm-social-content`, `supplier-price-comparison`, `excel-catalog`
- **שיווק ישראלי:** `israeli-paid-ads`, `israeli-email-sequences`, `hebrew-seo-geo-toolkit`,
  `hebrew-survey-builder`
- **מסמכים/דאטה/מכונה:** `docx`, `pdf`, `xlsx`, `vault-keeper`, `organize-folders`
- **קונפיג/פיתוח:** `skill-creator`, `address-github-comments`, `accesslint-audit`

## ⛔ לכבות — רעש (לא בתחום)

`00-andruia-consultant`, `10-andruia-skill-smith`, `20-andruia-niche-intelligence`,
`advogado-especialista`, `active-directory-attacks`, `aegisops-ai`, `agent-evaluation`,
`agentflow`, `acceptance-orchestrator`, `3d-web-experience`, `activecampaign-automation`,
`import-memory`, `007`

## ⛔ לכבות — כפילויות

- נגישות: להשאיר `accesslint-audit` בלבד → לכבות `accesslint-scan`, `accesslint-diff`,
  `accessibility-compliance-accessibility-audit`
- תוכן/קריאייטיב: הספציפי גובר על הגנרי → לכבות `israeli-social-content`, `ad-creative`

## ⚠️ החלטת שימוש (השאר רק אם בשימוש בפועל)

`canvas-design`, `docs`, `morning`, `mcp-builder`, `web-artifacts-builder`,
`2slides-ppt-generator`, `pptx`, `session-start-hook`

## מצב ביצוע (2026-09-20, PR #111)

18 ה־⛔ כובו דרך `skillOverrides` ב־`settings.json` (כולם `"off"`), בשמות בסיס
ללא קידומת — ליישור עם מוסכמת `Skill(...)` שכבר בקובץ. שינוי הגדרות בלבד, הפיך.

- **חל רק אחרי `git pull`** של main ל־`~/.claude` במכונה.
- **אימות:** להריץ `/skill-doctor`. אם skill עדיין מופיע → המפתח דורש את הצורה
  עם קידומת `anthropic-skills:<name>` (ר' בלוק הגיבוי למטה).
- להסרה מוחלטת (לא רק השבתה): לכבות/למחוק ב־claude.ai; אחרת נשאר זמין לסנכרון.

### בלוק גיבוי — מפתחות עם קידומת `anthropic-skills:`

אם האימות מראה שהשמות ללא הקידומת לא תפסו, החלף את בלוק `skillOverrides`
ב־`settings.json` בזה:

```json
"skillOverrides": {
  "anthropic-skills:00-andruia-consultant": "off",
  "anthropic-skills:10-andruia-skill-smith": "off",
  "anthropic-skills:20-andruia-niche-intelligence": "off",
  "anthropic-skills:advogado-especialista": "off",
  "anthropic-skills:active-directory-attacks": "off",
  "anthropic-skills:aegisops-ai": "off",
  "anthropic-skills:agent-evaluation": "off",
  "anthropic-skills:agentflow": "off",
  "anthropic-skills:acceptance-orchestrator": "off",
  "anthropic-skills:3d-web-experience": "off",
  "anthropic-skills:activecampaign-automation": "off",
  "anthropic-skills:import-memory": "off",
  "anthropic-skills:007": "off",
  "anthropic-skills:accesslint-scan": "off",
  "anthropic-skills:accesslint-diff": "off",
  "anthropic-skills:accessibility-compliance-accessibility-audit": "off",
  "anthropic-skills:israeli-social-content": "off",
  "anthropic-skills:ad-creative": "off"
}
```

## תחזוקה

- עדכון תאריך "Last triaged" בראש הקובץ בכל מיון מחדש.
