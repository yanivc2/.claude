import { createHash } from "crypto";
import { prisma } from "./prisma";
import type { LegalCategory } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────
// משיכת עדכוני חקיקה ופסיקה מפידי RSS ומקורות ציבוריים (למשל "כל זכות").
// המקורות מוגדרים כרשימה ניתנת להרחבה. הפונקציה מנרמלת כל פריט למבנה אחיד,
// מונעת כפילויות באמצעות externalId (hash של הקישור/guid), ושומרת למסד.
// ─────────────────────────────────────────────────────────────────────────

export interface LegalSource {
  name: string;
  url: string; // כתובת פיד RSS/Atom
  category: LegalCategory;
}

// בונה כתובת פיד RSS של Google News עבור שאילתת חיפוש בעברית (ישראל).
// Google News מספק פיד RSS יציב ומעודכן ומחזיר פריטי חדשות אמיתיים —
// דרך מעשית ואמינה למשוך עדכונים שוטפים בנושאי דיני עבודה.
function googleNewsRss(query: string): string {
  const params = new URLSearchParams({ q: query, hl: "he", gl: "IL", ceid: "IL:he" });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

// רשימת המקורות למשיכה שבועית. ניתן להוסיף/להחליף מקורות ושאילתות.
export const LEGAL_SOURCES: LegalSource[] = [
  {
    name: "חדשות דיני עבודה",
    url: googleNewsRss('"דיני עבודה" OR "זכויות עובדים"'),
    category: "LEGISLATION",
  },
  {
    name: "פסיקת בית הדין לעבודה",
    url: googleNewsRss('"בית הדין לעבודה"'),
    category: "RULING",
  },
  {
    name: "תקנות וצווי הרחבה בעבודה",
    url: googleNewsRss('"משרד העבודה" ("צו הרחבה" OR תקנות OR חקיקה)'),
    category: "REGULATION",
  },
];

interface ParsedItem {
  title: string;
  summary: string;
  content: string;
  link: string;
  guid: string;
  publishedAt: Date;
}

// מפענח RSS/Atom בסיסי ללא תלות בספריות חיצוניות. עבור פידים מורכבים
// מומלץ להשתמש בספרייה ייעודית (למשל rss-parser). מיוצא לצורך בדיקות.
export function parseFeed(xml: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi) ?? [];

  for (const block of blocks) {
    const pick = (tag: string): string => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      if (!m) return "";
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        // פענוח ישויות HTML (Google News מקודד — ולעיתים מקודד-כפול — את התוכן).
        // מפענחים &amp; ראשון כדי לטפל בקידוד כפול (למשל &amp;nbsp;), ואז השאר.
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    };

    const title = pick("title");
    const link = pick("link") || block.match(/<link[^>]*href="([^"]+)"/i)?.[1] || "";
    const description = pick("description") || pick("summary") || pick("content");
    const guid = pick("guid") || pick("id") || link;
    const dateStr = pick("pubDate") || pick("published") || pick("updated");
    const publishedAt = dateStr ? new Date(dateStr) : new Date();

    if (!title) continue;

    items.push({
      title,
      summary: description.slice(0, 500),
      content: description,
      link,
      guid,
      publishedAt: isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
    });
  }

  return items;
}

function externalIdFor(source: string, guid: string): string {
  return createHash("sha256").update(`${source}::${guid}`).digest("hex");
}

export interface FetchResult {
  source: string;
  fetched: number;
  inserted: number;
  error?: string;
}

// משיכת מקור בודד ושמירת פריטים חדשים בלבד.
async function fetchSource(source: LegalSource): Promise<FetchResult> {
  try {
    const res = await fetch(source.url, {
      headers: { "User-Agent": "HR-IL-LegalFetcher/1.0" },
      // מונע שמירה במטמון של Next עבור נתונים דינמיים.
      cache: "no-store",
    });
    if (!res.ok) {
      return { source: source.name, fetched: 0, inserted: 0, error: `HTTP ${res.status}` };
    }

    const xml = await res.text();
    const items = parseFeed(xml);
    let inserted = 0;

    for (const item of items) {
      const externalId = externalIdFor(source.name, item.guid);
      const result = await prisma.legalUpdate.upsert({
        where: { externalId },
        create: {
          title: item.title,
          summary: item.summary,
          content: item.content,
          category: source.category,
          source: source.name,
          sourceUrl: item.link || null,
          publishedAt: item.publishedAt,
          externalId,
        },
        update: {}, // פריט קיים — אין עדכון (מניעת כפילויות)
      });
      // upsert לא מבחין בין create/update; נבדוק לפי fetchedAt קרוב.
      if (Date.now() - result.fetchedAt.getTime() < 5000) inserted += 1;
    }

    return { source: source.name, fetched: items.length, inserted };
  } catch (err) {
    return {
      source: source.name,
      fetched: 0,
      inserted: 0,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

// משיכת כלל המקורות — נקרא מה-cron השבועי.
export async function fetchAllLegalUpdates(): Promise<FetchResult[]> {
  const results: FetchResult[] = [];
  for (const source of LEGAL_SOURCES) {
    results.push(await fetchSource(source));
  }
  return results;
}
