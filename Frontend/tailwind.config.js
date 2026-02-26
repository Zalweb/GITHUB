/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#111827",
        bg0: "#0b1020",
        bg1: "#111a32",
        accent: "#06b6d4",
      },
      boxShadow: {
        soft: "0 12px 30px rgba(0,0,0,0.28)",
      },
    },
  },
  plugins: [],
};
