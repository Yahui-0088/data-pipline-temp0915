# 总览页的 Tailwind 样式

`/overview` 用 Tailwind CSS 写。编译出来的是一份静态文件 `emqc/api/static/tw/overview.css`（已提交），
服务器和浏览器都不需要 Node 或外网。改了 `overview.html`、`_overview_graph.html`、`overview.js`
里的 class，或者改了这里的配置 / 源文件，要重新编译：

```bash
cd ui/tailwind
npx tailwindcss@3.4.17 -c tailwind.config.js -i overview.src.css -o ../../emqc/api/static/tw/overview.css --minify
```

流程图（左栏）由 `gen_overview_graph.py` 生成：

```bash
python ui/tailwind/gen_overview_graph.py > emqc/api/templates/_overview_graph.html
```
