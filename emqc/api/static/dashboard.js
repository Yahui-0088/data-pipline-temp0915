/* 总览 dashboard（Power BI 风格）：/api/v1/pipeline/dashboard 一次取回各维度的数据，这里画成图。
   不用图表库，纯 SVG / HTML。颜色全部来自 style.css 里 .bi 的变量（深色模式自动换）。
   每个图形元素悬停都有数值；底部的运行明细表可搜索、可排序，就是所有图背后的数字。 */
(function () {
  const STAGES = ["ingest", "slice_qc", "serial_qc", "aggregate", "persist"];
  const STAGE_ZH = { ingest: "读取 · 统计", slice_qc: "切片检查", serial_qc: "序列检查", aggregate: "汇总 · 分级", persist: "落库" };
  const SEV = ["critical", "high", "medium", "low"];
  const SEV_ZH = { critical: "critical 致命", high: "high 严重", medium: "medium 中等", low: "low 轻微" };
  const CHECK_ZH = { blank_slice: "空白切片", missing_slice: "缺失切片", corrupt_slice: "损坏切片", severe_blur: "严重模糊", saturation: "过曝 / 饱和", crack: "裂缝 / 褶皱",
    brightness_jump: "亮度突变", contrast_drift: "对比度漂移", charging_artifact: "荷电伪影", contamination: "表面污染", slice_jump: "切片跳变",
    local_misalignment: "局部错位", global_misalignment: "整体错位", z_order_error: "顺序错误", local_deformation: "局部形变", section_deformation: "切片形变" };
  const TARGET = 0.85;   // 留存率目标线：和全站「好」的门槛一致（meter 绿色 ≥ 85%）
  const pctf = v => v == null ? "–" : Math.round(v * 100) + "%";
  const pct1 = v => v == null ? "–" : (Math.round(v * 1000) / 10).toFixed(1) + "%";
  const num = v => v == null ? "–" : (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toString());
  const short = (id, n = 24) => id.length > n ? id.slice(0, n - 2) + "…" : id;
  const zh = c => CHECK_ZH[c] || c;
  let state = { days: 0, dataset: "", sort: "run_id", desc: true, q: "" }, timer = null, last = null;

  // ---------------------------------------------------------------- tooltip (one for the page)
  let tip;
  function tipInit(root) {
    if (!tip) { tip = document.createElement("div"); tip.className = "bi-tip"; tip.hidden = true; document.body.appendChild(tip); }
    root.addEventListener("mouseover", e => { const t = e.target.closest("[data-tip]"); if (!t) return; tip.innerHTML = t.dataset.tip; tip.hidden = false; });
    root.addEventListener("mousemove", e => { if (tip.hidden) return; const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8); tip.style.left = x + "px"; tip.style.top = (e.clientY + 14) + "px"; });
    root.addEventListener("mouseout", e => { if (e.target.closest("[data-tip]")) tip.hidden = true; });
  }
  // lines are already HTML (values passed through esc); only escape for the attribute itself
  const tipAttr = lines => `data-tip="${lines.join("<br>").replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;

  const panel = (kicker, title, body, extra = "", cls = "") => `<section class="bi-panel ${cls}"><header><span class="bi-k">${kicker}</span><b>${title}</b>${extra ? `<span class="bi-x">${extra}</span>` : ""}</header>${body}</section>`;
  const empty = msg => `<div class="bi-empty">${msg}</div>`;

  // delta pill: +3.2 pp / −5% ; good = which direction is good
  function delta(cur, prev, { pp = false, good = 1, label = "vs 上次" } = {}) {
    if (cur == null || prev == null) return "";
    const d = pp ? (cur - prev) * 100 : prev ? (cur - prev) / prev * 100 : null;
    if (d == null || !isFinite(d)) return "";
    const r = Math.round(d * 10) / 10, cls = r === 0 ? "flat" : (r > 0) === (good > 0) ? "up" : "down";
    const arrow = r > 0 ? "↗" : r < 0 ? "↘" : "→";
    return `<span class="bi-d ${cls}"><span class="bi-dl">${label}</span> ${arrow} ${r > 0 ? "+" : ""}${r.toFixed(1)}${pp ? " pp" : "%"}</span>`;
  }

  // sparkline with a dashed mean line, last point ringed
  function spark(vals, fmt) {
    const v = vals.map((x, i) => [i, x]).filter(p => p[1] != null);
    if (v.length < 2) return `<div class="bi-spark-empty">至少两次运行才有走势</div>`;
    const W = 260, H = 46, P = 4, n = vals.length;
    const lo = Math.min(...v.map(p => p[1])), hi = Math.max(...v.map(p => p[1])), span = hi - lo || Math.abs(hi) || 1;
    const x = i => P + i * (W - 2 * P) / Math.max(n - 1, 1), y = val => H - P - (val - lo) / span * (H - 2 * P);
    const mean = v.reduce((a, p) => a + p[1], 0) / v.length;
    const d = v.map((p, k) => `${k ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    const [li, lv] = v[v.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" class="bi-spark" preserveAspectRatio="none" role="img" aria-label="各次运行走势">
      <line x1="${P}" x2="${W - P}" y1="${y(mean)}" y2="${y(mean)}" class="mean" ${tipAttr([`平均 ${fmt(mean)}`])}/>
      <path d="${d}" class="ln"/><circle cx="${x(li)}" cy="${y(lv)}" r="3.5" class="end"/></svg>`;
  }

  // ---------------------------------------------------------------- KPI cards
  function kpiCards(d) {
    const rs = d.runs, k = d.kpi, dl = d.delivery;
    // 「vs 上次」= 最近一次运行 vs 同一个数据集的上一次运行（不同数据集之间比没有意义）
    const lastRun = rs[rs.length - 1], same = lastRun ? rs.filter(r => r.dataset_id === lastRun.dataset_id) : [];
    const lastTwo = key => [same.length ? same[same.length - 1][key] : null, same.length > 1 ? same[same.length - 2][key] : null];
    const [rC, rP] = lastTwo("retention"), [sC, sP] = lastTwo("sections_per_s"), [fC, fP] = lastTwo("n_high");
    const card = (icon, kicker, value, sub, deltas, sp, accent) => `<div class="bi-kpi ${accent ? "on" : ""}">
      <div class="bi-kpi-h"><i class="bi-ic">${icon}</i><span class="bi-k">${kicker}</span></div>
      <div class="bi-kpi-row"><div class="bi-big">${value}</div><div class="bi-kpi-d">${deltas}</div></div>
      <div class="bi-kpi-sub">${sub}</div>${sp}</div>`;
    return `<div class="bi-kpis">
      ${card("◎", "RETENTION · 留存率", pct1(k.retention), `${num(k.n_sections - k.n_bad)} / ${num(k.n_sections)} 张可用 · 目标 ${pctf(TARGET)}`,
        delta(rC, rP, { pp: true }) + delta(k.retention, TARGET, { pp: true, label: "vs 目标" }), spark(rs.map(r => r.retention), pctf), true)}
      ${card("▦", "SECTIONS · 已检查切片", num(k.n_sections), `${k.n_datasets} 个数据集 · ${k.n_runs} 次运行${k.n_runs_error ? ` · <span class="bi-neg">${k.n_runs_error} 次出错</span>` : ""}`,
        lastRun ? `<span class="bi-d flat"><span class="bi-dl">最近</span> #${lastRun.run_id}</span>` : "", spark(rs.map(r => r.n_sections), num))}
      ${card("⚠", "ISSUES · 严重问题", num(k.n_problems), `剔除 ${num(k.n_bad)} 张切片 · high 及以上`,
        delta(fC, fP, { good: -1 }), spark(rs.map(r => r.n_high), num))}
      ${card("⏱", "THROUGHPUT · 切片/秒", k.sections_per_s == null ? "–" : num(k.sections_per_s), "各次运行中位数",
        delta(sC, sP), spark(rs.map(r => r.sections_per_s), num))}
      ${card("⇪", "DELIVERED · 已交付", num(dl.export_sections), `张进训练分片 · ${num(dl.stream_chunks)} 块推理流`,
        `<span class="bi-d flat"><span class="bi-dl">导出</span> ${dl.n_exports} 次</span>`,
        `<div class="bi-split" ${tipAttr([`<b>交付构成</b>`, `训练分片 ${fmtBytes(dl.export_bytes)}`, `推理流 ${fmtBytes(dl.stream_bytes)}`])}>
          <i style="flex-grow:${dl.export_bytes || 0}" class="a"></i><i style="flex-grow:${dl.stream_bytes || 0}" class="b"></i></div>
          <div class="bi-split-l"><span><i class="a"></i>训练 ${fmtBytes(dl.export_bytes)}</span><span><i class="b"></i>推理 ${fmtBytes(dl.stream_bytes)}</span></div>`)}
    </div>`;
  }

  // ---------------------------------------------------------------- breakdown panels (bars against a 0–100% scale)
  const scaleRow = cols => `<span></span><span class="bi-ticks">${[0, 25, 50, 75, 100].map(t => `<i style="left:${t}%">${t}%</i>`).join("")}</span>${"<span></span>".repeat(cols - 2)}`;
  function byDataset(d) {
    if (!d.datasets.length) return panel("BY DATASET", "各数据集留存率", empty("这个范围内还没有跑过 QC 的数据集"));
    const prevOf = {};
    for (const r of d.runs) { (prevOf[r.dataset_id] = prevOf[r.dataset_id] || []).push(r); }
    const rows = d.datasets.slice().sort((a, b) => (a.retention || 0) - (b.retention || 0)).map(x => {
      const h = (prevOf[x.dataset_id] || []).filter(r => r.run_id !== x.run_id), prev = h.length ? h[h.length - 1].retention : null;
      const dd = prev == null ? `<span class="bi-dd muted">首次</span>` : (() => { const v = Math.round((x.retention - prev) * 1000) / 10; return `<span class="bi-dd ${v > 0 ? "up" : v < 0 ? "down" : ""}">${v > 0 ? "+" : ""}${v.toFixed(1)} pp</span>`; })();
      return `<a class="bi-rl" href="/datasets/${encodeURIComponent(x.dataset_id)}" title="${esc(x.dataset_id)}">${esc(short(x.dataset_id))}</a>
        <span class="bi-track" ${tipAttr([`<b>${esc(x.dataset_id)}</b>`, `留存率 ${pct1(x.retention)}（目标 ${pctf(TARGET)}）`, `${num(x.n_sections)} 张中剔除 ${num(x.n_bad)} 张`, `等级 ${x.grade || "–"} · 运行 #${x.run_id}`, prev == null ? "第一次运行" : `上一次 ${pct1(prev)}`])}>
          <i class="fill" style="width:${100 * (x.retention || 0)}%"></i><i class="tgt" style="left:${100 * TARGET}%"></i></span>
        <span class="grade grade-${x.grade || "none"}">${x.grade || "–"}</span>${dd}`;
    }).join("");
    return panel("BY DATASET", "各数据集留存率", `<div class="bi-rows ds">${scaleRow(4)}${rows}</div><div class="bi-note"><i class="tgt-k"></i>竖线 = 目标 ${pctf(TARGET)} · 右侧 = 较该数据集上一次运行</div>`, "从低到高");
  }
  function byGrade(d) {
    const tot = {}, n = d.datasets.reduce((a, x) => { for (const [g, c] of Object.entries(x.block_grades)) { tot[g] = (tot[g] || 0) + c; a += c; } return a; }, 0);
    if (!n) return panel("BY GRADE", "block 等级构成", empty("还没有分级结果"));
    const desc = { A: "直接可用", B: "剔除少数坏切片后可用", C: "只有短的连续可用段", D: "不可用" };
    const rows = ["A", "B", "C", "D"].map(g => `<span class="bi-rl"><span class="grade grade-${g}">${g}</span> ${desc[g]}</span>
      <span class="bi-track" ${tipAttr([`<b>${g} 级 · ${desc[g]}</b>`, `${tot[g] || 0} 个 block（${pct1((tot[g] || 0) / n)}）`])}><i class="fill g-${g}" style="width:${100 * (tot[g] || 0) / n}%"></i></span>
      <span class="bi-dd mono">${tot[g] || 0}</span>`).join("");
    return panel("BY GRADE", "block 等级构成", `<div class="bi-rows gr">${scaleRow(3)}${rows}</div><div class="bi-note">共 ${n} 个 block · 各数据集最近一次运行</div>`);
  }
  function byFailure(d) {
    if (!d.failures.length) return panel("BY ISSUE", "问题类型", empty("没有 high 以上的问题"));
    const top = d.failures.slice(0, 8), mx = top[0].n, total = d.failures.reduce((a, f) => a + f.n, 0);
    const rows = top.map(f => `<span class="bi-rl">${esc(f.zh)}</span>
      <span class="bi-track" ${tipAttr([`<b>${esc(f.zh)}</b>`, `${f.n} 条（占 ${Math.round(100 * f.n / total)}%）`, esc(f.type)])}><i class="fill" style="width:${100 * f.n / mx}%"></i></span>
      <span class="bi-dd mono">${f.n}</span>`).join("");
    return panel("BY ISSUE", "问题类型", `<div class="bi-rows is">${rows}</div><div class="bi-note">high 及以上共 ${total} 条${d.failures.length > 8 ? ` · 显示前 8 类，共 ${d.failures.length} 类` : ""}</div>`);
  }

  // ---------------------------------------------------------------- heatmap: checks × runs
  function heatmap(d) {
    const rs = d.runs.slice(-30);
    const checks = [...new Set(rs.flatMap(r => Object.keys(r.checks || {})))];
    if (!rs.length || !checks.length) return panel("HEATMAP", "检查项 × 运行", empty("这个范围内的运行没有 high 以上的问题"), "", "wide");
    const tot = c => rs.reduce((a, r) => a + ((r.checks || {})[c] || 0), 0);
    checks.sort((a, b) => tot(b) - tot(a));
    const mx = Math.max(...rs.flatMap(r => Object.values(r.checks || {})), 1);
    const lvl = v => !v ? 0 : Math.min(5, 1 + Math.floor(4 * Math.log1p(v) / Math.log1p(mx) + 1e-9));
    const head = `<span></span>${rs.map(r => `<span class="hm-c" title="${esc(r.dataset_id)}">#${r.run_id}</span>`).join("")}<span class="hm-c">合计</span>`;
    const body = checks.map(c => `<span class="hm-r">${esc(zh(c))}</span>${rs.map(r => {
      const v = (r.checks || {})[c] || 0;
      return `<i class="hm l${lvl(v)}" ${tipAttr([`<b>${esc(zh(c))}</b>`, `运行 #${r.run_id} · ${esc(r.dataset_id)}`, `${v} 条 high 以上`, (r.finished_at || "").replace("T", " ")])}></i>`;
    }).join("")}<span class="hm-t mono">${tot(c)}</span>`).join("");
    const legend = `<div class="hm-legend">少 ${[0, 1, 2, 3, 4, 5].map(l => `<i class="hm l${l}"></i>`).join("")} 多 <span class="muted">（每格 = 一次运行里这一项 high 以上的问题条数，颜色按对数分档，最多 ${mx} 条）</span></div>`;
    return panel("HEATMAP", "检查项 × 运行", `<div class="hm-wrap"><div class="hm-grid" style="grid-template-columns:minmax(84px,max-content) repeat(${rs.length},minmax(18px,1fr)) 3em">${head}${body}</div></div>${legend}`,
      `${rs.length} 次运行${d.runs.length > 30 ? "（最近 30 次）" : ""} · 按问题总数排序`, "wide");
  }

  // ---------------------------------------------------------------- checks × severity (stacked)
  function bySeverity(d) {
    if (!d.checks.length) return panel("BY SEVERITY", "各检查项触发", empty("没有发现问题"));
    const top = d.checks.slice(0, 8), mx = top[0].n;
    const rows = top.map(c => `<span class="bi-rl">${esc(zh(c.check))}</span><span class="bi-stack">${SEV.filter(s => c.by_severity[s]).map(s =>
      `<i class="sv-${s}" style="width:${100 * c.by_severity[s] / mx}%" ${tipAttr([`<b>${esc(zh(c.check))}</b>`, `${SEV_ZH[s]}：${c.by_severity[s]} 条`, `合计 ${c.n} 条`])}></i>`).join("")}</span><span class="bi-dd mono">${c.n}</span>`).join("");
    const legend = `<div class="bi-legend">${SEV.map(s => `<span><i class="sv-${s}"></i>${SEV_ZH[s]}</span>`).join("")}</div>`;
    return panel("BY SEVERITY", "各检查项触发", `${legend}<div class="bi-rows is">${rows}</div><div class="bi-note">high 及以上判为不通过</div>`);
  }

  // ---------------------------------------------------------------- stage time per run (stacked columns)
  function stages(d) {
    const rs = d.runs.filter(r => Object.keys(r.stages || {}).length).slice(-16);
    if (!rs.length) return panel("PIPELINE", "各阶段耗时", empty("还没有耗时数据"));
    const W = 560, H = 190, L = 40, R = 8, T = 8, B = 22, pw = W - L - R, ph = H - T - B;
    const tot = r => STAGES.reduce((a, s) => a + (r.stages[s] || 0), 0);
    const mx = Math.max(...rs.map(tot)) || 1, bw = Math.min(30, pw / rs.length - 8), y = v => T + ph - v / mx * ph;
    const grid = [0, 0.5, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${y(mx * f)}" y2="${y(mx * f)}" class="g"/><text x="${L - 6}" y="${y(mx * f) + 4}" text-anchor="end" class="t">${num(mx * f)}s</text>`).join("");
    const cols = rs.map((r, i) => {
      const cx = L + (i + 0.5) * pw / rs.length - bw / 2, t = tot(r);
      let acc = 0;
      const segs = STAGES.map((s, k) => {
        const v = r.stages[s] || 0; if (!v) return "";
        const y0 = y(acc), y1 = y(acc + v); acc += v;
        return `<rect x="${cx}" y="${y1}" width="${bw}" height="${Math.max(0, y0 - y1 - (acc < t ? 2 : 0))}" class="st-c${k + 1}"/>`;
      }).join("");
      const lines = [`<b>#${r.run_id} · ${esc(r.dataset_id)}</b>`, ...STAGES.filter(s => r.stages[s]).map(s => `${STAGE_ZH[s]}：${num(r.stages[s])} s（${Math.round(100 * r.stages[s] / t)}%）`), `合计 ${num(t)} s`];
      return `<g ${tipAttr(lines)}><rect x="${cx - 4}" y="${T}" width="${bw + 8}" height="${ph}" class="hit"/>${segs}</g><text x="${cx + bw / 2}" y="${H - 6}" text-anchor="middle" class="t">#${r.run_id}</text>`;
    }).join("");
    const legend = `<div class="bi-legend">${STAGES.map((s, k) => `<span><i class="st-c${k + 1}"></i>${STAGE_ZH[s]}</span>`).join("")}</div>`;
    return panel("PIPELINE", "各阶段耗时", `${legend}<svg viewBox="0 0 ${W} ${H}" class="bi-svg" role="img" aria-label="各阶段耗时">${grid}${cols}</svg>`, "累计 CPU 时间");
  }

  // ---------------------------------------------------------------- run detail table (search + sort)
  function detailRows(d) {
    const prev = {}, out = [];
    for (const r of d.runs) {
      const p = prev[r.dataset_id];
      out.push({ ...r, d_ret: p && r.retention != null && p.retention != null ? r.retention - p.retention : null, n_bad_grades: (r.grades.D || 0) });
      prev[r.dataset_id] = r;
    }
    return out;
  }
  const COLS = [
    ["run_id", "运行", r => `<a class="mono" href="/runs/${r.run_id}">#${r.run_id}</a>`],
    ["dataset_id", "数据集", r => `<a href="/datasets/${encodeURIComponent(r.dataset_id)}">${esc(r.dataset_id)}</a>`],
    ["finished_at", "完成时间", r => `<span class="mono muted">${(r.finished_at || "").replace("T", " ")}</span>`],
    ["n_sections", "切片", r => num(r.n_sections), 1],
    ["retention", "留存率", r => `<span class="bi-cellbar"><i style="width:${100 * (r.retention || 0)}%"></i></span>${pct1(r.retention)}`, 1],
    ["d_ret", "Δ 上次", r => r.d_ret == null ? `<span class="muted">–</span>` : `<span class="bi-dd ${r.d_ret > 0 ? "up" : r.d_ret < 0 ? "down" : ""}">${r.d_ret > 0 ? "+" : ""}${(r.d_ret * 100).toFixed(1)} pp</span>`, 1],
    ["quality", "quality", r => r.quality == null ? "–" : r.quality.toFixed(3), 1],
    ["grades", "等级", r => ["A", "B", "C", "D"].filter(g => r.grades[g]).map(g => `<span class="grade grade-${g} sm">${g}</span><span class="muted">×${r.grades[g]}</span>`).join(" ") || "–"],
    ["n_high", "严重问题", r => num(r.n_high), 1],
    ["sections_per_s", "切片/秒", r => num(r.sections_per_s), 1],
    ["wall_s", "耗时 s", r => num(r.wall_s), 1],
  ];
  function detail(d) {
    const all = detailRows(d), q = state.q.trim().toLowerCase();
    let rows = q ? all.filter(r => (`#${r.run_id} ${r.dataset_id} ${r.finished_at || ""}`).toLowerCase().includes(q)) : all;
    const key = state.sort, sgn = state.desc ? -1 : 1, val = r => key === "grades" ? (r.grades.A || 0) - (r.grades.D || 0) : r[key];
    rows = rows.slice().sort((a, b) => { const x = val(a), y = val(b); if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * sgn; });
    const th = COLS.map(([k, t, , n]) => `<th class="${n ? "num" : ""}"><button class="bi-sort ${state.sort === k ? "on" : ""}" data-k="${k}">${t}${state.sort === k ? (state.desc ? " ↓" : " ↑") : ""}</button></th>`).join("");
    const tb = rows.map(r => `<tr>${COLS.map(([, , f, n]) => `<td class="${n ? "num mono" : ""}">${f(r)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${COLS.length}" class="muted">没有匹配的运行</td></tr>`;
    return panel("RUN DETAIL", `运行明细 <span class="bi-cnt">${rows.length} / ${all.length}</span>`,
      `<div class="bi-tbl"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`,
      `<input id="bi-q" class="bi-search" placeholder="搜索运行号、数据集、日期…" value="${esc(state.q)}">`, "wide");
  }

  // ---------------------------------------------------------------- page
  function seg(id, opts, cur) {
    return `<div class="bi-seg" id="${id}">${opts.map(([v, t]) => `<button data-v="${esc(v)}" class="${String(cur) === String(v) ? "on" : ""}">${t}</button>`).join("")}</div>`;
  }
  function render(d) {
    const box = document.getElementById("dash-body"); if (!box) return;
    const ds = d.filters.datasets;
    const dsCtl = ds.length <= 4 ? seg("bi-ds", [["", "全部"], ...ds.map(x => [x, esc(short(x, 18))])], state.dataset)
      : `<select id="bi-ds-sel" class="bi-select"><option value="">全部数据集</option>${ds.map(x => `<option value="${esc(x)}" ${x === state.dataset ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>`;
    const now = new Date();
    const hadFocus = document.activeElement && document.activeElement.id === "bi-q", caret = hadFocus ? document.activeElement.selectionStart : 0;
    box.innerHTML = `<div class="bi-bar"><span class="bi-brand"><i>∿</i>EM IMAGE QC <span>· OPERATIONAL TELEMETRY</span></span><span class="bi-sp"></span>
        ${dsCtl}${seg("bi-days", [[0, "全部"], [1, "24H"], [7, "7D"], [30, "30D"]], state.days)}
        <button class="bi-icon" id="bi-refresh" title="刷新">↻</button></div>
      ${kpiCards(d)}
      <div class="bi-grid3">${byDataset(d)}${byGrade(d)}${byFailure(d)}</div>
      ${heatmap(d)}
      <div class="bi-grid2">${bySeverity(d)}${stages(d)}</div>
      ${detail(d)}
      <div class="bi-foot"><span>最近一次运行：${d.runs.length ? (d.runs[d.runs.length - 1].finished_at || "").replace("T", " ") : "–"}</span><span>页面刷新于 ${now.toTimeString().slice(0, 8)} · 每 10 秒自动刷新</span></div>`;
    const qi = document.getElementById("bi-q");
    if (hadFocus && qi) { qi.focus(); qi.setSelectionRange(caret, caret); }
    wire(box);
  }
  function save() { try { localStorage.setItem("emqc.dash", JSON.stringify({ days: state.days, dataset: state.dataset })); } catch (e) {} }
  function wire(box) {
    box.querySelectorAll("#bi-days button").forEach(b => b.onclick = () => { state.days = +b.dataset.v; save(); load(); });
    box.querySelectorAll("#bi-ds button").forEach(b => b.onclick = () => { state.dataset = b.dataset.v; save(); load(); });
    const sel = box.querySelector("#bi-ds-sel"); if (sel) sel.onchange = () => { state.dataset = sel.value; save(); load(); };
    box.querySelector("#bi-refresh").onclick = () => load();
    const qi = box.querySelector("#bi-q"); if (qi) qi.oninput = () => { state.q = qi.value; render(last); };
    box.querySelectorAll(".bi-sort").forEach(b => b.onclick = () => { const k = b.dataset.k; state.desc = state.sort === k ? !state.desc : true; state.sort = k; render(last); });
  }
  async function load() {
    const p = new URLSearchParams({ days: state.days });
    if (state.dataset) p.set("dataset_id", state.dataset);
    try { last = await (await fetch(`/api/v1/pipeline/dashboard?${p}`)).json(); } catch (e) { return; }
    for (const r of last.runs) r.n_high = Object.values(r.checks || {}).reduce((a, b) => a + b, 0);  // high 及以上，和 KPI 同口径
    render(last);
  }

  window.dashboardInit = function () {
    const root = document.getElementById("dashboard"); if (!root) return;
    try { const saved = JSON.parse(localStorage.getItem("emqc.dash") || "{}"); state = { ...state, days: +saved.days || 0, dataset: saved.dataset || "" }; } catch (e) {}
    tipInit(root);
    load();
    clearInterval(timer); timer = setInterval(() => { if (!document.hidden) load(); }, 10000);
  };
  window.dashboardRefresh = load;
})();
