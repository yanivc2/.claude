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
      },
    },
  },
  plugins: [],
};

export default config;
