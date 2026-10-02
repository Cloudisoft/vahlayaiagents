/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      keyframes: {
        "page-in": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "none" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "pop-in": { from: { opacity: "0", transform: "scale(.97)" }, to: { opacity: "1", transform: "none" } },
        "slide-in-right": { from: { transform: "translateX(24px)", opacity: "0" }, to: { transform: "none", opacity: "1" } },
        shimmer: { from: { backgroundPosition: "-200% 0" }, to: { backgroundPosition: "200% 0" } },
        "progress-indeterminate": { from: { transform: "translateX(-100%)" }, to: { transform: "translateX(300%)" } },
      },
      animation: {
        "page-in": "page-in 220ms cubic-bezier(.2,.7,.2,1) both",
        "fade-in": "fade-in 200ms ease-out both",
        "pop-in": "pop-in 180ms cubic-bezier(.2,.7,.2,1) both",
        "slide-in-right": "slide-in-right 220ms cubic-bezier(.2,.7,.2,1) both",
        shimmer: "shimmer 1.4s linear infinite",
        progress: "progress-indeterminate 1s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
