// Tailwind v4 is handled by the @tailwindcss/vite plugin (see vite.config.ts),
// so PostCSS needs no plugins here. This empty config exists to stop PostCSS
// from walking up the directory tree and picking up an unrelated parent-level
// postcss.config.js (which can pull in an incompatible Tailwind v3).
export default {};
