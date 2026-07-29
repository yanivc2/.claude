"""The frozen token-pilot corpus (P2m).

A small, deterministic, content-addressed set of samples for measuring how the
estimator's rules compare to real token counts. It lives in the product tree, never in
``experiment/s2`` — this is not §2 data and must not be confused with it.

Every sample is a literal here, so the corpus reproduces byte-for-byte with no file or
network dependency; its identity is the full SHA-256 of its text. Seven content
families at three sizes each (21 samples), plus fixed system-prompt and tool-schema
overhead fragments used to measure per-call overhead separately from content.

Constraints held to (P2m §5):

* deterministic and versioned — the manifest hash pins the whole set;
* no secrets, no personal data, no API keys, no sensitive content;
* varied real content — not one character repeated, which tokenizes nothing like text.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict

from ..estimation.metrics import ContentFamily, ContentMetrics, ScriptHint
from ..pricing.entities import full_sha256

CORPUS_VERSION = "token-pilot-corpus-v1"


class Sample(BaseModel):
    """One frozen input, measured but never estimated by this type."""

    model_config = ConfigDict(frozen=True)

    sample_id: str
    family: ContentFamily
    size: str                      # short | medium | long
    script: ScriptHint
    text: str

    @property
    def content_hash(self) -> str:
        return full_sha256(self.text)

    def metrics(self) -> ContentMetrics:
        """Measured facts about this sample. The estimator reads these, never the file."""
        return ContentMetrics(
            family=self.family,
            utf8_bytes=len(self.text.encode("utf-8")),
            code_points=len(self.text),
            words=len(self.text.split()),
            lines=self.text.count("\n") + (1 if self.text else 0),
            files=1,
            script=self.script,
        )

    def manifest_row(self) -> dict[str, Any]:
        m = self.metrics()
        return {
            "sample_id": self.sample_id,
            "family": self.family.value,
            "size": self.size,
            "script": self.script.value,
            "content_hash": self.content_hash,
            "utf8_bytes": m.utf8_bytes,
            "code_points": m.code_points,
            "words": m.words,
            "lines": m.lines,
        }


_L = ContentFamily.PROSE_LATIN
_H = ContentFamily.PROSE_HEBREW
_M = ContentFamily.PROSE_MIXED
_C = ContentFamily.SOURCE_CODE
_S = ContentFamily.STRUCTURED_DATA
_D = ContentFamily.DIFF_PATCH
_T = ContentFamily.TOOL_SCHEMA

_LAT = ScriptHint.LATIN
_HEB = ScriptHint.HEBREW
_MIX = ScriptHint.MIXED


# --------------------------------------------------------------------------- #
# PROSE_LATIN                                                                 #
# --------------------------------------------------------------------------- #
_LATIN_SHORT = "The login button does nothing on the first click but works on the second."

_LATIN_MEDIUM = (
    "When a user submits the onboarding form, the server must validate every field "
    "before writing anything to the database. A missing email should return a 422 with "
    "a clear message, not a 500. The current handler swallows the validation error and "
    "reports success, so the client shows a confirmation screen for a record that was "
    "never created. Fix the handler so it surfaces the validation failure to the caller."
)

_LATIN_LONG = (
    "The consultation assistant answers employee questions about Israeli labour law. It "
    "must ground every answer in the knowledge base rather than improvising, and when "
    "the knowledge base does not cover a question it must say so plainly instead of "
    "guessing. The product requirement is that a wrong-but-confident answer is worse "
    "than an honest 'I don't know', because an employee may act on it. The assistant "
    "streams its response so the first sentence appears quickly, and it cites the "
    "specific topic it drew from. Latency matters: the median first-token time should "
    "stay under a second, and the full answer should complete well before the user "
    "loses patience. Accessibility is not optional — the chat must be usable with a "
    "keyboard alone, announce new messages to screen readers, and never rely on colour "
    "as the only signal. Finally, the assistant must refuse to give individual legal "
    "advice that only a licensed professional may give, and it must route those cases "
    "to a human contact rather than answering them itself."
)

# --------------------------------------------------------------------------- #
# PROSE_HEBREW                                                                #
# --------------------------------------------------------------------------- #
_HEBREW_SHORT = "כפתור ההתחברות אינו מגיב בלחיצה הראשונה אך עובד בלחיצה השנייה."

_HEBREW_MEDIUM = (
    "כאשר עובד ממלא את טופס הקליטה, השרת חייב לאמת כל שדה לפני שמירה כלשהי במסד "
    "הנתונים. שדה דוא\"ל חסר צריך להחזיר שגיאה ברורה למשתמש, לא כשל כללי. המטפל "
    "הנוכחי בולע את שגיאת האימות ומדווח על הצלחה, ולכן המשתמש רואה מסך אישור עבור "
    "רשומה שמעולם לא נוצרה. יש לתקן את המטפל כך שיחזיר את כשל האימות לקורא."
)

_HEBREW_LONG = (
    "עוזר הייעוץ עונה על שאלות של עובדים בנושא דיני העבודה בישראל. עליו לבסס כל תשובה "
    "על מאגר הידע ולא לאלתר, וכאשר המאגר אינו מכסה שאלה עליו לומר זאת במפורש במקום "
    "לנחש. דרישת המוצר היא שתשובה שגויה אך בטוחה גרועה מתשובה כנה של 'איני יודע', "
    "משום שעובד עלול לפעול לפיה. העוזר משדר את תשובתו כך שהמשפט הראשון מופיע במהירות, "
    "והוא מציין את הנושא הספציפי שעליו התבסס. זמן התגובה חשוב: זמן הטוקן הראשון החציוני "
    "צריך להישאר מתחת לשנייה אחת, והתשובה המלאה צריכה להסתיים הרבה לפני שהמשתמש מאבד "
    "סבלנות. נגישות אינה מותרות — הצ'אט חייב להיות שמיש במקלדת בלבד, להכריז על הודעות "
    "חדשות בפני קוראי מסך, ולעולם לא להסתמך על צבע כאות היחיד. לבסוף, על העוזר לסרב "
    "לתת ייעוץ משפטי פרטני שרק בעל רישיון רשאי לתת, ולהפנות מקרים כאלה לאיש קשר אנושי."
)

# --------------------------------------------------------------------------- #
# PROSE_MIXED (Hebrew prose carrying Latin identifiers, paths, JSON)          #
# --------------------------------------------------------------------------- #
_MIXED_SHORT = 'הפונקציה validateEmail מחזירה false עבור כתובת תקינה כמו a@b.co.'

_MIXED_MEDIUM = (
    "ה-handler שנמצא ב-src/api/onboarding/route.ts קורא ל-createEmployee לפני שהוא "
    "מריץ את הסכימה של zod, ולכן רשומה נכתבת ל-Prisma גם כשה-payload אינו תקין. יש "
    "להעביר את הבדיקה schema.parse(body) לפני הקריאה ל-db, ולהחזיר status 422 עם "
    "הודעה בעברית כאשר האימות נכשל."
)

_MIXED_LONG = (
    "המסך /employees/[id] טוען את העובד דרך getEmployee(id) ומציג רצועת key-facts. "
    "כרגע כאשר ה-API מחזיר null (למשל עובד שנמחק) הקומפוננטה זורקת TypeError במקום "
    "להציג מצב empty. הבקשה: להוסיף בדיקת guard ב-EmployeeFile.tsx, להציג הודעת "
    "'העובד לא נמצא' עם קישור חזרה ל-/employees, ולכתוב לוג מובנה עם correlationId "
    "כדי שנוכל לאתר את המקרה. שים לב שה-model שנבחר להרצה הוא claude-haiku-4-5, "
    "וש-response הצפוי הוא JSON בצורת {\"status\":\"not_found\",\"employeeId\":\"...\"}. "
    "אין לשנות את ה-routing הקיים ואין להוסיף תלות חדשה ב-package.json ללא אישור."
)

# --------------------------------------------------------------------------- #
# SOURCE_CODE                                                                 #
# --------------------------------------------------------------------------- #
_CODE_SHORT = "def add(a, b):\n    return a - b   # bug: should be a + b\n"

_CODE_MEDIUM = (
    "from __future__ import annotations\n\n"
    "def running_max(values: list[int]) -> list[int]:\n"
    "    \"\"\"Return the running maximum. Off-by-one: it drops the first element.\"\"\"\n"
    "    out: list[int] = []\n"
    "    current = values[0]\n"
    "    for v in values[1:]:\n"
    "        if v > current:\n"
    "            current = v\n"
    "        out.append(current)\n"
    "    return out\n"
)

_CODE_LONG = (
    "import { NextRequest, NextResponse } from 'next/server';\n"
    "import { z } from 'zod';\n"
    "import { prisma } from '@/lib/prisma';\n\n"
    "const OnboardSchema = z.object({\n"
    "  fullName: z.string().min(1),\n"
    "  email: z.string().email(),\n"
    "  companyId: z.string().uuid(),\n"
    "  startDate: z.string().date(),\n"
    "});\n\n"
    "export async function POST(req: NextRequest) {\n"
    "  const body = await req.json();\n"
    "  // BUG: the record is created before the payload is validated.\n"
    "  const employee = await prisma.employee.create({ data: body });\n"
    "  const parsed = OnboardSchema.safeParse(body);\n"
    "  if (!parsed.success) {\n"
    "    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });\n"
    "  }\n"
    "  return NextResponse.json({ id: employee.id }, { status: 201 });\n"
    "}\n"
)

# --------------------------------------------------------------------------- #
# STRUCTURED_DATA (JSON / config)                                             #
# --------------------------------------------------------------------------- #
_JSON_SHORT = '{"status": "not_found", "employeeId": "e-123"}'

_JSON_MEDIUM = (
    '{\n'
    '  "employee": {\n'
    '    "id": "e-123",\n'
    '    "fullName": "Dana Cohen",\n'
    '    "email": "dana@example.com",\n'
    '    "companyId": "c-1",\n'
    '    "startDate": "2026-01-15",\n'
    '    "roles": ["employee", "manager"],\n'
    '    "pension": {"provider": "example-fund", "transferPending": false}\n'
    '  }\n'
    '}'
)

_JSON_LONG = (
    '{\n'
    '  "page": 1,\n'
    '  "pageSize": 3,\n'
    '  "total": 42,\n'
    '  "items": [\n'
    '    {"id": "e-1", "name": "A. Levi", "status": "active", "startDate": "2025-03-01"},\n'
    '    {"id": "e-2", "name": "B. Mizrahi", "status": "onboarding", "startDate": "2026-02-10"},\n'
    '    {"id": "e-3", "name": "C. Peretz", "status": "terminated", "endDate": "2026-06-30"}\n'
    '  ],\n'
    '  "facets": {\n'
    '    "status": {"active": 30, "onboarding": 7, "terminated": 5},\n'
    '    "company": {"c-1": 20, "c-2": 22}\n'
    '  },\n'
    '  "links": {"self": "/api/employees?page=1", "next": "/api/employees?page=2"}\n'
    '}'
)

# --------------------------------------------------------------------------- #
# DIFF_PATCH                                                                   #
# --------------------------------------------------------------------------- #
_DIFF_SHORT = (
    "--- a/solution.py\n"
    "+++ b/solution.py\n"
    "@@ -1,2 +1,2 @@\n"
    " def add(a, b):\n"
    "-    return a - b\n"
    "+    return a + b\n"
)

_DIFF_MEDIUM = (
    "--- a/src/api/onboarding/route.ts\n"
    "+++ b/src/api/onboarding/route.ts\n"
    "@@ -12,8 +12,10 @@ export async function POST(req: NextRequest) {\n"
    "   const body = await req.json();\n"
    "-  const employee = await prisma.employee.create({ data: body });\n"
    "   const parsed = OnboardSchema.safeParse(body);\n"
    "   if (!parsed.success) {\n"
    "     return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });\n"
    "   }\n"
    "+  const employee = await prisma.employee.create({ data: parsed.data });\n"
    "   return NextResponse.json({ id: employee.id }, { status: 201 });\n"
    " }\n"
)

_DIFF_LONG = (
    "--- a/src/components/EmployeeFile.tsx\n"
    "+++ b/src/components/EmployeeFile.tsx\n"
    "@@ -1,10 +1,18 @@\n"
    " import { getEmployee } from '@/lib/employees';\n"
    "+import { EmptyState } from '@/components/EmptyState';\n"
    "+import { logger } from '@/lib/logger';\n\n"
    " export async function EmployeeFile({ id }: { id: string }) {\n"
    "   const employee = await getEmployee(id);\n"
    "-  return <KeyFacts employee={employee} />;\n"
    "+  if (!employee) {\n"
    "+    logger.info('employee_not_found', { employeeId: id });\n"
    "+    return (\n"
    "+      <EmptyState title=\"העובד לא נמצא\" href=\"/employees\" />\n"
    "+    );\n"
    "+  }\n"
    "+  return <KeyFacts employee={employee} />;\n"
    " }\n"
    "--- a/src/lib/employees.ts\n"
    "+++ b/src/lib/employees.ts\n"
    "@@ -3,3 +3,3 @@\n"
    "-export async function getEmployee(id: string) { return db.employee.find(id); }\n"
    "+export async function getEmployee(id: string) { return (await db.employee.find(id)) ?? null; }\n"
)

# --------------------------------------------------------------------------- #
# TOOL_SCHEMA                                                                  #
# --------------------------------------------------------------------------- #
_TOOL_SHORT = (
    '{"name": "get_employee", "description": "Fetch one employee by id",'
    ' "input_schema": {"type": "object", "properties": {"id": {"type": "string"}},'
    ' "required": ["id"]}}'
)

_TOOL_MEDIUM = (
    '{\n'
    '  "name": "create_termination",\n'
    '  "description": "Start a termination process for an employee, with notice period.",\n'
    '  "input_schema": {\n'
    '    "type": "object",\n'
    '    "properties": {\n'
    '      "employeeId": {"type": "string"},\n'
    '      "lastDay": {"type": "string", "format": "date"},\n'
    '      "reason": {"type": "string", "enum": ["resignation", "dismissal", "mutual"]},\n'
    '      "notifyManager": {"type": "boolean"}\n'
    '    },\n'
    '    "required": ["employeeId", "lastDay", "reason"]\n'
    '  }\n'
    '}'
)

_TOOL_LONG = (
    '{\n'
    '  "tools": [\n'
    '    {\n'
    '      "name": "search_knowledge_base",\n'
    '      "description": "Search Israeli labour-law topics and return grounded passages.",\n'
    '      "input_schema": {\n'
    '        "type": "object",\n'
    '        "properties": {\n'
    '          "query": {"type": "string", "description": "the employee question"},\n'
    '          "topics": {"type": "array", "items": {"type": "string"}},\n'
    '          "maxResults": {"type": "integer", "minimum": 1, "maximum": 20}\n'
    '        },\n'
    '        "required": ["query"]\n'
    '      }\n'
    '    },\n'
    '    {\n'
    '      "name": "route_to_human",\n'
    '      "description": "Escalate a question that needs a licensed professional.",\n'
    '      "input_schema": {\n'
    '        "type": "object",\n'
    '        "properties": {\n'
    '          "reason": {"type": "string"},\n'
    '          "contactId": {"type": "string"},\n'
    '          "priority": {"type": "string", "enum": ["low", "normal", "high"]}\n'
    '        },\n'
    '        "required": ["reason", "contactId"]\n'
    '      }\n'
    '    }\n'
    '  ]\n'
    '}'
)


def _s(sid: str, family: ContentFamily, size: str, script: ScriptHint, text: str) -> Sample:
    return Sample(sample_id=sid, family=family, size=size, script=script, text=text)


CORPUS: list[Sample] = [
    _s("prose_latin_short", _L, "short", _LAT, _LATIN_SHORT),
    _s("prose_latin_medium", _L, "medium", _LAT, _LATIN_MEDIUM),
    _s("prose_latin_long", _L, "long", _LAT, _LATIN_LONG),

    _s("prose_hebrew_short", _H, "short", _HEB, _HEBREW_SHORT),
    _s("prose_hebrew_medium", _H, "medium", _HEB, _HEBREW_MEDIUM),
    _s("prose_hebrew_long", _H, "long", _HEB, _HEBREW_LONG),

    _s("prose_mixed_short", _M, "short", _MIX, _MIXED_SHORT),
    _s("prose_mixed_medium", _M, "medium", _MIX, _MIXED_MEDIUM),
    _s("prose_mixed_long", _M, "long", _MIX, _MIXED_LONG),

    _s("source_code_short", _C, "short", _LAT, _CODE_SHORT),
    _s("source_code_medium", _C, "medium", _LAT, _CODE_MEDIUM),
    _s("source_code_long", _C, "long", _LAT, _CODE_LONG),

    _s("structured_data_short", _S, "short", _LAT, _JSON_SHORT),
    _s("structured_data_medium", _S, "medium", _LAT, _JSON_MEDIUM),
    _s("structured_data_long", _S, "long", _LAT, _JSON_LONG),

    _s("diff_patch_short", _D, "short", _LAT, _DIFF_SHORT),
    _s("diff_patch_medium", _D, "medium", _LAT, _DIFF_MEDIUM),
    _s("diff_patch_long", _D, "long", _LAT, _DIFF_LONG),

    _s("tool_schema_short", _T, "short", _LAT, _TOOL_SHORT),
    _s("tool_schema_medium", _T, "medium", _LAT, _TOOL_MEDIUM),
    _s("tool_schema_long", _T, "long", _LAT, _TOOL_LONG),
]

#: Fixed per-call overhead fragments, measured separately from content (P2m §16).
SYSTEM_PROMPT_OVERHEAD = (
    "You are a careful assistant for an Israeli HR product. Answer only from the "
    "provided knowledge base. If a question is outside it, say so. Never give "
    "individual legal advice that requires a licensed professional; route those to a "
    "human contact instead. Cite the topic you used."
)

TOOL_SCHEMA_OVERHEAD = _TOOL_LONG


def corpus_manifest() -> dict[str, Any]:
    """The canonical, content-addressed record of the whole corpus."""
    rows = [s.manifest_row() for s in CORPUS]
    return {
        "corpus_version": CORPUS_VERSION,
        "sample_count": len(CORPUS),
        "manifest_hash": full_sha256(
            "".join(f"{r['sample_id']}:{r['content_hash']}" for r in rows)),
        "samples": rows,
    }


def by_family(family: ContentFamily) -> list[Sample]:
    return [s for s in CORPUS if s.family is family]
