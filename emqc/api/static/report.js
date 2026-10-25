/* 汇报页：/api/v1/report/data 一次取回，画成一页能直接打印成 PDF 的报告。纯 SVG / HTML，颜色来自 style.css 的变量。 */
(function () {
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = v => v == null ? "–" : (Math.round(v * 1000) / 10).toFixed(1) + "%";
  const num = v => v == null ? "–" : Math.round(v).toLocaleString();
  const bytes = n => { if (!n) return "0 B"; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + " " + u[i]; };
  const GRADE_ZH = { A: "直接可用", B: "剔除少数坏切片后可用", C: "只有短的连续可用段", D: "不可用" };
  let tip;

  function delta(cur, prev, { pp = false, good = 1 } = {}) {
    if (cur == null || prev == null) return `<span class="rp-d flat">上周无数据</span>`;
    const d = pp ? (cur - prev) * 100 : (prev ? (cur - prev) / prev * 100 : null);
    if (d == null) return `<span class="rp-d flat">上周为 0</span>`;
    const r = Math.round(d * 10) / 10, cls = r === 0 ? "flat" : (r > 0) === (good > 0) ? "up" : "down";
    return `<span class="rp-d ${cls}">较上周 ${r > 0 ? "▲ +" : r < 0 ? "▼ " : ""}${r.toFixed(1)}${pp ? " 个百分点" : "%"}</span>`;
  }
  // 横轴标签：大约 6 个，最后一周一定标；离上一个标签太近的不标，免得挤在一起
  const showLabel = (i, n) => { const st = Math.ceil(n / 6); return i === n - 1 || (i % st === 0 && n - 1 - i >= Math.max(2, st / 2)); };
  const tipAttr = lines => `data-tip="${lines.join("<br>").replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;

  function bars(trend, key, fmt, label) {
    const W = 320, H = 150, L = 34, B = 20, T = 8, pw = W - L - 6, ph = H - T - B, n = trend.length;
    const mx = Math.max(1, ...trend.map(t => t[key] || 0)), bw = Math.min(26, pw / n - 6), y = v => T + ph - v / mx * ph;
    const grid = [0, 0.5, 1].map(f => `<line x1="${L}" x2="${W - 4}" y1="${y(mx * f)}" y2="${y(mx * f)}" class="g"/><text x="${L - 5}" y="${y(mx * f) + 3}" text-anchor="end" class="t">${fmt(mx * f)}</text>`).join("");
    const cols = trend.map((t, i) => {
      const cx = L + (i + 0.5) * pw / n - bw / 2, v = t[key] || 0;
      return `<g ${tipAttr([`<b>${t.week} 这一周</b>`, `${label}：${fmt(v)}`])}><rect x="${cx - 3}" y="${T}" width="${bw + 6}" height="${ph}" class="hit"/>${v ? `<rect x="${cx}" y="${y(v)}" width="${bw}" height="${T + ph - y(v)}" rx="3" class="bar"/>` : ""}</g>
        ${showLabel(i, n) ? `<text x="${cx + bw / 2}" y="${H - 5}" text-anchor="middle" class="t">${t.week.slice(5)}</text>` : ""}`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="rp-svg" role="img" aria-label="${label}每周">${grid}${cols}</svg>`;
  }
  function line(trend) {
    const W = 320, H = 150, L = 34, B = 20, T = 8, pw = W - L - 10, ph = H - T - B, n = trend.length;
    const x = i => L + 4 + i * pw / Math.max(1, n - 1), y = v => T + (1 - v) * ph;
    const grid = [0, 0.5, 1].map(v => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end" class="t">${v * 100}%</text>`).join("");
    const pts = trend.map((t, i) => [i, t.retention]).filter(p => p[1] != null);
    const path = pts.map((p, k) => `${k ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    const dots = pts.map(([i, v]) => `<g ${tipAttr([`<b>${trend[i].week} 这一周</b>`, `留存率 ${pct(v)}`, `${num(trend[i].sections)} 张切片`])}><circle cx="${x(i)}" cy="${y(v)}" r="10" class="hit"/><circle cx="${x(i)}" cy="${y(v)}" r="4" class="dot"/></g>`).join("");
    const labels = trend.map((t, i) => showLabel(i, n) ? `<text x="${x(i)}" y="${H - 5}" text-anchor="middle" class="t">${t.week.slice(5)}</text>` : "").join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="rp-svg" role="img" aria-label="每周留存率">${grid}${pts.length > 1 ? `<path d="${path}" class="ln"/>` : ""}${dots}${labels}</svg>${pts.length ? "" : `<div class="muted rp-none">这段时间没有 QC 运行</div>`}`;
  }

  function render(d) {
    const k = d.kpi, w = d.wow, dl = d.delivery;
    const title = d.project ? `项目 ${esc(d.project)}` : (d.limited ? `项目 ${d.projects.map(esc).join("、")}` : "全部项目");
    const nb = k.n_blocks || 0;
    const gradeBar = nb ? `<div class="rp-gbar">${["A", "B", "C", "D"].filter(g => k.grades[g]).map(g => `<i class="g-${g}" style="flex-grow:${k.grades[g]}" ${tipAttr([`<b>${g} 级：${GRADE_ZH[g]}</b>`, `${k.grades[g]} 个数据块（${pct(k.grades[g] / nb)}）`])}></i>`).join("")}</div>
      <div class="rp-glegend">${["A", "B", "C", "D"].map(g => `<span><i class="g-${g}"></i><b>${g}</b> ${GRADE_ZH[g]} · ${k.grades[g] || 0} 块</span>`).join("")}</div>` : `<div class="muted">还没有分级结果</div>`;
    const fmax = Math.max(1, ...d.failures.map(f => f.n));
    const fails = d.failures.length ? d.failures.slice(0, 10).map(f => `<span class="rp-fl">${esc(f.zh)}</span><span class="rp-ft" ${tipAttr([`<b>${esc(f.zh)}</b>`, `${f.n} 处`])}><i style="width:${100 * f.n / fmax}%"></i></span><span class="rp-fn">${f.n}</span>`).join("") : `<div class="muted">没有严重问题</div>`;
    const ex = d.examples.length ? d.examples.map(e => `<div class="rp-ex"><div class="rp-ex-h"><b>${esc(e.zh)}</b><span class="muted">共 ${e.n} 处</span></div><div class="rp-ex-g">${e.shots.map(s => `<figure><img src="${s.thumb}" alt="${esc(e.zh)}" loading="lazy"><figcaption>${esc(s.dataset_id)} · 第 ${s.z} 张 · ${esc(s.severity)}</figcaption></figure>`).join("")}</div></div>`).join("") : `<div class="muted">没有可展示的问题样例</div>`;
    const rows = d.datasets.map(x => `<tr><td>${esc(x.dataset_id)}</td><td>${esc(x.project || "–")}</td><td><span class="grade grade-${x.grade || "none"}">${x.grade || "–"}</span></td><td class="num">${pct(x.retention)}</td><td class="num">${num(x.n_sections)}</td><td class="num">${x.n_blocks}</td><td class="mono muted">${(x.last_run || "–").replace("T", " ")}</td></tr>`).join("");
    document.getElementById("report").innerHTML = `
      <section class="rp-head"><div><div class="rp-eyebrow">EM 数据清洗平台 · 质量汇报</div><h1>${title}</h1>
        <div class="muted">截至 ${d.generated_at.replace("T", " ").replace("Z", " UTC")} · 最近 ${d.weeks} 周 · 数据来自各数据集最近一次质量检查</div></div></section>
      <section class="rp-kpis">
        <div class="rp-kpi"><div class="k">数据集</div><div class="v">${k.n_datasets}</div><div class="s">${k.n_datasets_qc} 个已完成质量检查</div></div>
        <div class="rp-kpi"><div class="k">已检查切片</div><div class="v">${num(k.n_sections)}</div><div class="s">本周检查 ${num(w.this.sections)} 张次（含重跑） ${delta(w.this.sections, w.prev.sections)}</div></div>
        <div class="rp-kpi main"><div class="k">留存率（可用比例）</div><div class="v">${pct(k.retention)}</div><div class="s">${num(k.n_kept)} 张可用 ${delta(w.this.retention, w.prev.retention, { pp: true })}</div></div>
        <div class="rp-kpi"><div class="k">严重问题</div><div class="v">${num(k.n_problems)}</div><div class="s">本周各次检查共报 ${num(w.this.problems)} 处 ${delta(w.this.problems, w.prev.problems, { good: -1 })}</div></div>
        <div class="rp-kpi"><div class="k">已交付训练数据</div><div class="v">${num(dl.shard_sections + dl.pack_samples)}</div><div class="s">本周 ${num(w.this.delivered)} ${delta(w.this.delivered, w.prev.delivered)}</div></div>
      </section>
      <section class="rp-card"><h2>趋势 <span class="muted">每周一根，悬停看数值</span></h2>
        <div class="rp-trend"><div><h3>检查了多少切片</h3>${bars(d.trend, "sections", num, "检查切片")}</div>
          <div><h3>留存率</h3>${line(d.trend)}</div>
          <div><h3>交付了多少（切片 / 样本）</h3>${bars(d.trend, "delivered", num, "交付")}</div></div>
        <details class="rp-tbl"><summary class="muted">每周数字</summary><table class="dense"><tr><th>周（周一）</th><th class="num">运行</th><th class="num">检查切片</th><th class="num">留存率</th><th class="num">严重问题</th><th class="num">交付</th></tr>
          ${d.trend.slice().reverse().map(t => `<tr><td class="mono">${t.week}</td><td class="num">${t.runs}</td><td class="num">${num(t.sections)}</td><td class="num">${pct(t.retention)}</td><td class="num">${t.problems}</td><td class="num">${num(t.delivered)}</td></tr>`).join("")}</table></details></section>
      <div class="rp-two">
        <section class="rp-card"><h2>数据质量构成 <span class="muted">${nb} 个数据块</span></h2>${gradeBar}</section>
        <section class="rp-card"><h2>交付进度</h2><div class="rp-dl">
          <div><div class="k">训练分片</div><div class="v">${num(dl.shard_sections)} 张</div><div class="s">${dl.n_shard_jobs} 次导出 · ${bytes(dl.shard_bytes)}</div></div>
          <div><div class="k">训练数据包</div><div class="v">${num(dl.pack_samples)} 个样本</div><div class="s">${dl.n_packs} 个数据包 · ${bytes(dl.pack_bytes)}</div></div>
          <div><div class="k">推理流</div><div class="v">${num(dl.stream_chunks)} 块</div><div class="s">${dl.n_streams} 个会话 · ${bytes(dl.stream_bytes)}</div></div></div></section>
      </div>
      <section class="rp-card"><h2>问题类型 <span class="muted">严重及以上，按处数排序</span></h2><div class="rp-fails">${fails}</div></section>
      <section class="rp-card rp-break"><h2>问题样例 <span class="muted">平台自动找出的典型坏切片</span></h2><div class="rp-exs">${ex}</div></section>
      <section class="rp-card"><h2>数据集明细</h2><div class="rp-scroll"><table class="dense"><thead><tr><th>数据集</th><th>项目</th><th>等级</th><th class="num">留存率</th><th class="num">切片</th><th class="num">数据块</th><th>最近检查</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="muted">没有数据集</td></tr>`}</tbody></table></div></section>
      <footer class="rp-foot muted">口径：留存率 = 通过质量检查、可用于训练的切片比例；严重问题 = 判为 high / critical 的问题；等级 A–D 按数据块评定。本页可用「导出 PDF」打印保存。</footer>`;
  }

  async function load() {
    const proj = document.getElementById("rp-project"), wk = document.getElementById("rp-weeks");
    const p = new URLSearchParams({ weeks: wk.value });
    if (proj && proj.value) p.set("project", proj.value);
    let r;
    try { r = await fetch(`/api/v1/report/data?${p}`); } catch (e) { return; }
    if (!r.ok) { document.getElementById("report").innerHTML = `<div class="muted rp-loading">${r.status === 403 ? "没有这个项目的查看权限" : "读取失败（" + r.status + "）"}</div>`; return; }
    render(await r.json());
  }

  document.addEventListener("DOMContentLoaded", () => {
    const proj = document.getElementById("rp-project"), wk = document.getElementById("rp-weeks");
    if (proj && proj.tagName === "SELECT") proj.onchange = () => { history.replaceState(null, "", proj.value ? `/report?project=${encodeURIComponent(proj.value)}` : "/report"); load(); };
    wk.onchange = load;
    tip = document.createElement("div"); tip.className = "rp-tip"; tip.hidden = true; document.body.appendChild(tip);
    const root = document.getElementById("report");
    root.addEventListener("mouseover", e => { const t = e.target.closest("[data-tip]"); if (!t) return; tip.innerHTML = t.dataset.tip; tip.hidden = false; });
    root.addEventListener("mousemove", e => { if (!tip.hidden) { tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (e.clientY + 14) + "px"; } });
    root.addEventListener("mouseout", e => { if (e.target.closest("[data-tip]")) tip.hidden = true; });
    load();
  });
})();
