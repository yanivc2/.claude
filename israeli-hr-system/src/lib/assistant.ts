import type Anthropic from "@anthropic-ai/sdk";
import type { AdminUser, Prisma } from "@prisma/client";
import { anthropic, CHAT_MODEL, FALLBACK_MODEL } from "./anthropic";
import { prisma } from "./prisma";
import { calculateNoticePeriod } from "./termination";
import { employeeScope, canWriteEmployeeData, roleOf } from "./rbac";

// ─────────────────────────────────────────────────────────────────────────
// "עוזר המערכת" — צ'אט קריאה-בלבד למנהלים. עונה על שאלות שימוש בממשק (רמה 1)
// ושולף נתונים אמיתיים דרך Tool Use בהיקף ההרשאה של המנהל המחובר (רמה 2).
// אינו מבצע פעולות כתיבה — לכל בקשת פעולה הוא מפנה למסך המתאים.
// ─────────────────────────────────────────────────────────────────────────

const APP_GUIDE = `אתה "עוזר המערכת" של מערכת ה-HR. תפקידך: (1) לענות על שאלות שימוש בממשק, ו-(2) לשלוף נתונים על עובדים/משימות עבור המנהל המחובר.

מסכי המערכת (הפניה בעברית):
- לוח בקרה (/) — סיכום ומדדים.
- משימות ונהלים (/tasks) — יצירת משימות ונהלי משמרת ושיוכם לעובדים.
- קליטת עובד (/onboarding) — שליחת קישור קליטה עצמית לעובד, או קליטה ידנית (טופס 101, ספח ת.ז, הסכם).
- סיום העסקה (/termination) — הנפקת הזמנה לשימוע ומכתב סיום העסקה, כולל חישוב הודעה מוקדמת.
- עובדים ותיקים (/employees) — רשימת העובדים וכרטיס עובד. מתן גישת עובד לאפליקציה נעשה בכרטיס העובד ("יצירת גישת עובד").
- שימור עובדים (/retention) — סקרי שימור.
- מסמכים ונהלים (/resources) — מאגר מסמכים.
- אנשי קשר (/contacts) — אנשי קשר ומטפלי פנסיה.
- יועץ לזכויות עובדים (/consultation) — צ'אט משפטי נפרד (חוקי עבודה) — הפנה אליו שאלות משפט/זכויות.
- עדכוני חקיקה (/legal-updates).
- הגדרות (/settings) — ניהול משתמשים ובדיקת מייל (לבעלים).

כללים:
- ענה תמיד בעברית, בקצרה ולעניין.
- לשאלות על נתונים (עובד ספציפי, ותק, מתי התחיל, ימי הודעה מוקדמת, כמה עובדים/משימות) — השתמש בכלים. אל תמציא נתונים; אם הכלי לא החזיר תוצאה, אמור זאת.
- אתה קריאה-בלבד ואינך מבצע פעולות. אם מבקשים "הנפק שימוע/מכתב", "שלח משימה", "צור קישור קליטה" — הסבר בקצרה שאתה עדיין לא מבצע פעולות, והפנה למסך המדויק שבו עושים זאת ידנית.
- לשאלות משפטיות (זכויות, חוק) — הפנה ליועץ לזכויות עובדים; אל תפסוק הלכה משפטית בעצמך.
- חישוב ההודעה המוקדמת הוא כלי-עזר (מסלול חודשי); ציין שיש לאמת מול ייעוץ לפני שימוש מחייב.`;

// כלים (קריאה-בלבד) שהמודל רשאי להפעיל.
const tools: Anthropic.Tool[] = [
  {
    name: "find_employees",
    description:
      "מחפש עובדים לפי שם (חלקי) ומחזיר פרטי העסקה לקריאה: תפקיד, סטטוס, מועד תחילת עבודה, ותק בחודשים, ימי הודעה מוקדמת מחושבים, סטטוס פנסיה, חברה ופרטי קשר. השתמש בכלי זה לכל שאלה על עובד ספציפי (למשל 'מתי X התחיל', 'כמה הודעה מוקדמת ל-X') או לרשימת עובדים.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "חלק מהשם לחיפוש. השאר ריק כדי לקבל את רשימת העובדים.",
        },
        status: {
          type: "string",
          enum: ["ACTIVE", "ONBOARDING", "NOTICE_PERIOD", "TERMINATED", "all"],
          description: "סינון לפי סטטוס העסקה. ברירת מחדל: עובדים פעילים (ACTIVE/ONBOARDING/NOTICE_PERIOD).",
        },
      },
      required: [],
    },
  },
  {
    name: "hr_overview",
    description:
      "מחזיר סיכום כמותי: מספר עובדים לפי סטטוס, מספר משימות פתוחות ושבוצעו, ומספר נהלי משמרת. לשאלות כמו 'כמה עובדים יש לי', 'כמה משימות פתוחות'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

type Me = AdminUser;

// ביצוע כלי — תמיד בהיקף ההרשאה של המנהל (employeeScope), עם חשיפת שכר רק
// לבעלים/מזכירה.
async function runTool(me: Me, name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === "find_employees") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const status = typeof input.status === "string" ? input.status : "";
    const where: Prisma.EmployeeWhereInput = { ...employeeScope(me) };
    if (status && status !== "all") {
      where.status = status as Prisma.EmployeeWhereInput["status"];
    } else if (!status) {
      where.status = { in: ["ACTIVE", "ONBOARDING", "NOTICE_PERIOD"] };
    }
    const emps = await prisma.employee.findMany({
      where,
      select: {
        firstName: true,
        lastName: true,
        jobTitle: true,
        status: true,
        startDate: true,
        hasActivePension: true,
        monthlySalary: true,
        hourlySalary: true,
        email: true,
        phone: true,
        company: { select: { name: true } },
      },
      take: 300,
      orderBy: { firstName: "asc" },
    });

    const showSalary = canWriteEmployeeData(me);
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = emps
      .map((e) => ({ ...e, fullName: `${e.firstName} ${e.lastName}`.trim() }))
      .filter((e) => tokens.length === 0 || tokens.every((t) => e.fullName.toLowerCase().includes(t)))
      .slice(0, 25)
      .map((e) => {
        const notice = calculateNoticePeriod(new Date(e.startDate));
        return {
          name: e.fullName,
          jobTitle: e.jobTitle ?? null,
          status: e.status,
          startDate: e.startDate.toISOString().slice(0, 10),
          seniorityMonths: notice.monthsEmployed,
          noticeDays: notice.noticeDays,
          noticeExplanation: notice.explanation,
          hasActivePension: e.hasActivePension,
          company: e.company?.name ?? null,
          email: e.email,
          phone: e.phone ?? null,
          ...(showSalary
            ? { monthlySalary: e.monthlySalary ?? null, hourlySalary: e.hourlySalary ?? null }
            : {}),
        };
      });

    return { count: rows.length, employees: rows };
  }

  if (name === "hr_overview") {
    const empWhere: Prisma.EmployeeWhereInput = { ...employeeScope(me) };
    const isManager = roleOf(me) === "STORE_MANAGER";
    const scopeCompany = isManager ? { companyId: me.companyId ?? "__none__" } : {};
    const [active, onboarding, notice, terminated, tasksOpen, tasksDone, procedures] =
      await Promise.all([
        prisma.employee.count({ where: { ...empWhere, status: "ACTIVE" } }),
        prisma.employee.count({ where: { ...empWhere, status: "ONBOARDING" } }),
        prisma.employee.count({ where: { ...empWhere, status: "NOTICE_PERIOD" } }),
        prisma.employee.count({ where: { ...empWhere, status: "TERMINATED" } }),
        prisma.task.count({ where: { ...scopeCompany, status: "SENT" } }),
        prisma.task.count({ where: { ...scopeCompany, status: "DONE" } }),
        prisma.shiftProcedure.count({ where: scopeCompany }),
      ]);
    return {
      employees: { active, onboarding, noticePeriod: notice, terminated },
      tasks: { open: tasksOpen, done: tasksDone },
      shiftProcedures: procedures,
    };
  }

  return { error: `כלי לא מוכר: ${name}` };
}

function textFrom(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function createWithFallback(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  try {
    return await anthropic.messages.create({ ...params, model: CHAT_MODEL });
  } catch {
    return await anthropic.messages.create({ ...params, model: FALLBACK_MODEL });
  }
}

export interface AssistantTurn {
  role: "user" | "assistant";
  content: string;
}

// מריץ את לולאת ה-tool-use ומחזיר את תשובת העוזר (טקסט). עד 5 סבבי כלים.
export async function runAssistant(
  me: Me,
  question: string,
  history: AssistantTurn[],
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-10).map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: question },
  ];

  for (let step = 0; step < 5; step++) {
    const resp = await createWithFallback({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: APP_GUIDE,
      tools,
      messages,
    });

    if (resp.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type === "tool_use") {
          let result: unknown;
          try {
            result = await runTool(me, block.name, (block.input ?? {}) as Record<string, unknown>);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : "שגיאה בהרצת הכלי" };
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }
      messages.push({ role: "assistant", content: resp.content });
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    return textFrom(resp) || "לא הצלחתי לנסח תשובה. נסה/י לנסח מחדש.";
  }

  return "הבקשה מורכבת מדי לעיבוד כרגע. נסה/י לפצל אותה.";
}
