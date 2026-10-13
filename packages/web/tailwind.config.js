/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        line: "#e6e6e6",
        "line-soft": "#ebebeb",
        ink: "#1a1a1a",
        muted: "#888888",
        panel: "#fcfcfc",
      },
      boxShadow: {
        card: "0 4px 14px rgba(0, 0, 0, 0.07)",
        float: "3px 3px 0 rgba(0, 0, 0, 0.08)",
      },
    },
  },
  plugins: [],
};
