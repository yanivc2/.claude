"use client";

import { useEffect, useRef, useState } from "react";

// מרחק המשיכה (בפיקסלים) שמעליו שחרור האצבע מפעיל רענון.
const THRESHOLD = 70;
// מרחק המשיכה המרבי שהאינדיקטור נמתח אליו.
const MAX_PULL = 110;

// משיכה למטה מראש הדף → רענון (pull-to-refresh) עם אינדיקטור ויזואלי.
// עובד במובייל בכל מצב (גם כשהאתר שמור למסך הבית), בלי תלות ברענון הטבעי
// של הדפדפן. במחשב שולחני אין אירועי מגע ולכן הרכיב פשוט אינו פעיל.
export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);

  useEffect(() => {
    const setP = (v: number) => {
      pullRef.current = v;
      setPull(v);
    };

    function onStart(e: TouchEvent) {
      // מתחילים לעקוב רק כשגוללים מהחלק העליון של הדף ובמגע יחיד.
      if (!refreshingRef.current && window.scrollY <= 0 && e.touches.length === 1) {
        startY.current = e.touches[0].clientY;
      } else {
        startY.current = null;
      }
    }

    function onMove(e: TouchEvent) {
      if (startY.current === null || refreshingRef.current) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy > 0 && window.scrollY <= 0) {
        // התנגדות: המשיכה בפועל חצי מהמרחק, עד מקסימום.
        const dist = Math.min(MAX_PULL, dy * 0.5);
        setP(dist);
        // מונע את הרענון הטבעי הכפול של הדפדפן בזמן משיכה.
        if (dist > 4 && e.cancelable) e.preventDefault();
      } else {
        setP(0);
      }
    }

    function onEnd() {
      if (startY.current === null) return;
      startY.current = null;
      if (pullRef.current >= THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        setP(THRESHOLD);
        // רענון קשיח — טוען מחדש גם גרסה חדשה שפורסמה וגם נתונים עדכניים.
        window.location.reload();
      } else {
        setP(0);
      }
    }

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  const visible = pull > 0 || refreshing;
  const height = refreshing ? THRESHOLD : pull;
  const progress = Math.min(1, pull / THRESHOLD);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center overflow-hidden transition-[height] duration-150 ease-out"
      style={{ height: visible ? height : 0 }}
    >
      <div className="mt-2 flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-md ring-1 ring-slate-200">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          className={refreshing ? "animate-spin text-brand-600" : "text-brand-600"}
          style={refreshing ? undefined : { transform: `rotate(${progress * 270}deg)` }}
        >
          <path
            d="M21 12a9 9 0 1 1-2.64-6.36"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <path
            d="M21 4v5h-5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
