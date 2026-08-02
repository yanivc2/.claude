import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Assistant", "Rubik", "system-ui", "sans-serif"],
      },
      colors: {
        // אינדיגו־פריווינקל מעודן: יפה אך רגוע, לא כחול־בוהק גנרי.
        brand: {
          50: "#f1f2fc",
          100: "#e4e6f9",
          200: "#cacef2",
          300: "#a9aeea",
          400: "#8087dd",
          500: "#5f66cf",
          600: "#4c51b8",
          700: "#3e4196",
          800: "#353679",
          900: "#2f2f5e",
        },
        // גוון־משנה סגול לגרדיאנטים מודרניים (אינדיגו→סגול) ולמבטאים.
        accent: {
          50: "#f5f3ff",
          100: "#ede9fe",
          200: "#ddd6fe",
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#8b5cf6",
          600: "#7c3aed",
          700: "#6d28d9",
          800: "#5b21b6",
          900: "#4c1d95",
        },
      },
      boxShadow: {
        // מערכת עומק מעודנת — צללים רכים ורב־שכבתיים במקום צל בודד חד.
        soft: "0 1px 2px rgb(15 23 42 / 0.04), 0 4px 12px rgb(15 23 42 / 0.05)",
        card: "0 1px 3px rgb(15 23 42 / 0.05), 0 8px 24px -8px rgb(15 23 42 / 0.10)",
        "card-hover": "0 2px 6px rgb(15 23 42 / 0.06), 0 16px 40px -12px rgb(15 23 42 / 0.18)",
        glow: "0 10px 30px -8px rgb(76 81 184 / 0.45)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #5f66cf 0%, #7c3aed 100%)",
      },
    },
  },
  plugins: [],
};

export default config;
