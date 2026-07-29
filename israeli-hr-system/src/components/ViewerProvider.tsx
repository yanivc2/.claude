"use client";

import { createContext, useContext } from "react";
import type { AdminRole } from "@/lib/rbac";

// פרטי הצופה המחובר, מוזרקים מהשרת (ללא fetch נוסף בצד הלקוח). משמש רכיבי
// לקוח לגזירת הרשאות: הסתרת פעולות כתיבה ממנהל חנות, וכד'.
export interface Viewer {
  role: AdminRole;
  companyId: string | null;
  companyName: string | null;
}

const ViewerContext = createContext<Viewer>({ role: "OWNER", companyId: null, companyName: null });

export function ViewerProvider({ value, children }: { value: Viewer; children: React.ReactNode }) {
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}

export function useViewer(): Viewer {
  return useContext(ViewerContext);
}

// קיצורים נפוצים.
export function useCanWrite(): boolean {
  const { role } = useViewer();
  return role === "OWNER" || role === "SECRETARY";
}
