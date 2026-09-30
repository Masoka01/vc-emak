// Tailwind v4 handles vendor prefixing itself (via Lightning CSS), so there is
// no autoprefixer plugin here — adding one that is not installed breaks the build.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
