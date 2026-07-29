import { ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/LoginForm";

export const metadata = { title: { absolute: "כניסה — מערכת משאבי אנוש" } };

export default function LoginPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-x-clip px-4 py-8">
      {/* תמונת רקע מלאה — אילוסטרציית המותג */}
      <div
        aria-hidden
        className="absolute inset-0 scale-110 bg-[url('/login-art.webp')] bg-cover bg-center"
      />
      {/* שכבת קריאוּת — מטשטשת ומאזנת את הרקע כדי שהכרטיס יבלוט (בהיר/כהה) */}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-b from-white/60 via-white/45 to-white/65 backdrop-blur-[3px] dark:from-slate-950/80 dark:via-slate-950/70 dark:to-slate-950/85"
      />

      <div className="relative z-10 w-full max-w-sm animate-fade-up">
        {/* עטיפת גרדיאנט דקה שיוצרת מסגרת זוהרת סביב הכרטיס */}
        <div className="rounded-[1.65rem] bg-gradient-to-br from-brand-500/40 via-accent-500/20 to-transparent p-px shadow-glow">
          <div className="glass rounded-[1.6rem] p-7 sm:p-8">
            <div className="mb-7 flex flex-col items-center text-center">
              <div className="rounded-2xl bg-gradient-to-br from-brand-500 to-accent-600 p-[3px] shadow-lg shadow-brand-600/25">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/logo-light.png"
                  alt="לוגו"
                  width={72}
                  height={72}
                  className="rounded-[0.85rem] bg-white"
                />
              </div>
              <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-gradient">
                מערכת משאבי אנוש
              </h1>
              <p className="mt-1.5 max-w-[17rem] text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                קליטה, שימור וניהול זכויות עובדים — במקום אחד
              </p>
            </div>
            <LoginForm />
          </div>
        </div>
        {/* חתימת אמון */}
        <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <ShieldCheck size={14} />
          התחברות מאובטחת בהצפנה
        </p>
      </div>
    </div>
  );
}
