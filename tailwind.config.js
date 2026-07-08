/** @type {import('tailwindcss').Config} */
module.exports = {
  prefix: "tw-",
  content: [
    "./src/templates/**/*.html.jinja",
    "./src/static/js/**/*.js",
    "./src/routes/**/*.py",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Palette mirrors the production ALeRCE LSST explorer
        // (lsst.alerce.online) — a Vuetify dark theme: primary #1976d2,
        // secondary #ff8f00, info #26a69a, success #00e676, warning #ffc107,
        // error #dd2c00, over Material dark surfaces (#121212 / #1e1e1e).
        // The `band` swatches below are scientific (Okabe–Ito, per-filter)
        // and intentionally left unchanged.
        bg: {
          primary: "#121212",
          secondary: "#1e1e1e",
          tertiary: "#2c2c2c",
          card: "#232323",
        },
        border: { DEFAULT: "#333333" },
        text: {
          primary: "#ffffff",
          secondary: "#dcdcdc",
          muted: "#a8a8a8",
        },
        accent: { DEFAULT: "#1976d2", hover: "#42a5f5" },
        // ALeRCE semantic/brand colors, available across the UI.
        secondary: { DEFAULT: "#ff8f00", hover: "#ffa726" },
        info: "#26a69a",
        success: "#00e676",
        warning: "#ffc107",
        error: "#dd2c00",
        band: {
          u: "#56B4E9",
          g: "#009E73",
          r: "#D55E00",
          i: "#E69F00",
          z: "#CC79A7",
          y: "#0072B2",
        },
      },
      fontFamily: {
        sans: ["'IBM Plex Sans'", "ui-sans-serif", "system-ui"],
        mono: ["'IBM Plex Mono'", "ui-monospace"],
      },
    },
  },
  plugins: [],
};
