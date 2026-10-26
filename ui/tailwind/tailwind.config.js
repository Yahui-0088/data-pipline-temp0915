/** 总览页（/overview）的 Tailwind 配置。只扫描用到 Tailwind 的模板和脚本，产物是一份静态 CSS。 */
module.exports = {
  content: [
    "../../emqc/api/templates/overview.html",
    "../../emqc/api/templates/_overview_graph.html",
    "../../emqc/api/static/overview.js",
  ],
  theme: {
    extend: {
      colors: { ink: { 950: "#0A0A0A", 900: "#111111", 850: "#161616" }, line: { DEFAULT: "#262626", soft: "#1C1C1C" }, mint: "#D9F2CF", run: "#2F7D50" },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "sans-serif"],
        mono: ["JetBrains Mono", "SF Mono", "ui-monospace", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
