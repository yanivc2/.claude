"use client";

import { useEffect, useRef } from "react";
import SignaturePadLib from "signature_pad";

// רכיב חתימה דיגיטלית מבוסס קנבס. מחזיר את החתימה כ-data URL (PNG).
export function SignaturePad({
  onChange,
  label = "חתימה",
}: {
  onChange: (dataUrl: string | null) => void;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePadLib | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // התאמת רזולוציית הקנבס לצפיפות המסך למניעת טשטוש.
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext("2d")?.scale(ratio, ratio);

    const pad = new SignaturePadLib(canvas, { penColor: "#0f172a" });
    padRef.current = pad;

    pad.addEventListener("endStroke", () => {
      onChange(pad.isEmpty() ? null : pad.toDataURL("image/png"));
    });

    return () => pad.off();
  }, [onChange]);

  const clear = () => {
    padRef.current?.clear();
    onChange(null);
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-sm font-medium text-slate-700">{label}</label>
        <button
          type="button"
          onClick={clear}
          className="text-xs text-brand-600 hover:underline"
        >
          נקה חתימה
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="h-40 w-full rounded-lg border border-dashed border-slate-300 bg-white"
      />
    </div>
  );
}
