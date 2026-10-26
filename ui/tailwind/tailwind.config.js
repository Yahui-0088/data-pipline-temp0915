/** 总览页（/overview）的 Tailwind 配置。只扫描用到 Tailwind 的模板和脚本，产物是一份静态 CSS。 */
module.exports = {
  content: [
    "../../emqc/api/templates/overview.html",
    "../../emqc/api/templates/_overview_graph.html",
    "../../emqc/api/static/overview.js",
  ],
  theme: {
    extend: {
      colors: { ink: { 950: "#070B14", 900: "#0A0F1B", 850: "#0B1120" } },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "sans-serif"],
        mono: ["JetBrains Mono", "SF Mono", "ui-monospace", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
