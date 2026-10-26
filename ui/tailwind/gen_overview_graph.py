"""生成总览页左侧 LangGraph 流程图的 HTML 片段（卡片绝对定位 + 一张 SVG 画所有连线）。
流程图的结构是固定的（emqc/qc/workflow.py 的图），只有节点上的耗时是数据，由模板填。
用法：python ui/tailwind/gen_overview_graph.py > emqc/api/templates/_overview_graph.html"""
A_L, A_W = 140, 200; A_C = A_L + A_W // 2; A_R = A_L + A_W
B_L, B_W = 440, 160; B_C = B_L + B_W // 2
JX, TILE_X, Z_X = 390, 96, 36
H, DH = 52, 80
rows = {"start": (24, 32), "prepare": (104, H), "next_group": (204, DH), "ingest": (332, H), "slice_qc": (432, H), "serial_qc": (532, H),
        "aggregate": (632, H), "persist": (732, DH), "group_done": (860, H)}
cy = lambda k: rows[k][0] + rows[k][1] // 2
top = lambda k: rows[k][0]
bot = lambda k: rows[k][0] + rows[k][1]
W, HH = 620, 948
fin_top, end_top, can_top = cy("next_group") - H // 2, cy("ingest") - 16, cy("slice_qc") - H // 2

paths = []
def seg(pts, head=True, dash=False, cls="text-neutral-600"):
    d = "M " + " L ".join(f"{x} {y}" for x, y in pts)
    paths.append(f'<path d="{d}" class="{cls}" stroke="currentColor" stroke-width="1.5" fill="none"{" stroke-dasharray=&quot;5 5&quot;" if dash else ""}{" marker-end=&quot;url(#ov-head)&quot;" if head else ""}/>'.replace("&quot;", '"'))
seq = ["prepare", "next_group", "ingest", "slice_qc", "serial_qc", "aggregate", "persist", "group_done"]
seg([(A_C, bot("start")), (A_C, top("prepare") - 3)])
for a, b in zip(seq, seq[1:]):
    seg([(A_C, bot(a)), (A_C, top(b) - 3)])
y = cy("next_group")
seg([(A_R, y), (B_L - 3, y)])
seg([(JX, y), (JX, cy("slice_qc")), (B_L - 3, cy("slice_qc"))], dash=True)
seg([(B_C, fin_top + H), (B_C, end_top - 3)])
seg([(B_C, can_top), (B_C, end_top + 32 + 3)], dash=True)
seg([(A_L, cy("persist")), (TILE_X, cy("persist")), (TILE_X, cy("slice_qc")), (A_L - 3, cy("slice_qc"))], cls="text-neutral-500")
seg([(A_L, cy("group_done")), (Z_X, cy("group_done")), (Z_X, cy("next_group")), (A_L - 3, cy("next_group"))], cls="text-neutral-500")

def node(k, title, sub_tpl, diamond=False, left=A_L, width=A_W, t=None):
    t = rows[k][0] if t is None else t
    h = DH if diamond else H
    shape = "ov-diamond" if diamond else "ov-box"
    return (f'<button type="button" data-node="{k}" aria-pressed="false" class="ov-node {shape}" style="left:{left}px;top:{t}px;width:{width}px;height:{h}px">'
            f'<span class="block text-[13.5px] font-semibold leading-tight">{title}</span>'
            f'<span class="block mt-0.5 text-[11.5px] text-neutral-400 tabular-nums">{sub_tpl}</span></button>')
pill = lambda left, t, txt: f'<div class="absolute flex items-center justify-center rounded-full border border-dashed border-neutral-700 bg-ink-900 font-mono text-[11px] text-neutral-400" style="left:{left}px;top:{t}px;width:96px;height:32px">{txt}</div>'
lab = lambda left, t, w, txt, cls="text-neutral-400": f'<div class="absolute text-center text-[12px] leading-4 {cls}" style="left:{left}px;top:{t}px;width:{w}px">{txt}</div>'
tm = lambda k, extra="": "{{ node_time.get('%s', '') }}%s" % (k, extra)
loop = "{% if n_tiles %} · ×{{ n_tiles }}{% endif %}"

out = [f'<div class="relative" style="width:{W}px;height:{HH}px">',
       f'<svg class="absolute inset-0" width="{W}" height="{HH}" viewBox="0 0 {W} {HH}" aria-hidden="true">'
       '<defs><marker id="ov-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
       '<path d="M0 0 L8 4 L0 8 Z" fill="currentColor"/></marker></defs>', *paths, "</svg>",
       pill(A_C - 48, top("start"), "__start__"),
       node("prepare", "准备 · 打开数据", "{% if latest %}{{ latest.n_sections|int }} 切片{% if n_tiles %} · {{ n_tiles }} tile{% endif %}{% endif %}"),
       node("next_group", "取下一个 z 段", "条件分支", diamond=True),
       node("ingest", "读取 · 统计", tm("ingest")),
       node("slice_qc", "切片检查", tm("slice_qc", loop)),
       node("serial_qc", "序列检查", tm("serial_qc", loop)),
       node("aggregate", "汇总 · 分级", tm("aggregate", loop)),
       node("persist", "落库", tm("persist") + " · 条件分支", diamond=True),
       node("group_done", "本段完成", "回到取下一个 z 段"),
       node("finalize", "数据集收尾", "{% if ds_grade %}等级 {{ ds_grade }} · {% endif %}{{ pct(latest.retention) if latest else '' }}", left=B_L, width=B_W, t=fin_top),
       pill(B_C - 48, end_top, "__end__"),
       f'<div class="absolute flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-700 bg-ink-900 text-center text-neutral-400" style="left:{B_L}px;top:{can_top}px;width:{B_W}px;height:{H}px"><span class="text-[13.5px] font-semibold">取消</span><span class="text-[11px]">请求取消时走这里</span></div>',
       lab(A_C + 12, (bot("next_group") + top("ingest")) // 2 - 8, 64, "还有 z 段"),
       lab(A_R + (B_L - A_R) // 2 - 34, cy("next_group") - 28, 68, "全部完成"),
       lab(JX + 8, cy("slice_qc") + 12, 40, "取消"),
       lab(A_C + 12, (bot("persist") + top("group_done")) // 2 - 8, 84, "本段 tile 完"),
       lab(Z_X + 6, (cy("slice_qc") + cy("persist")) // 2 - 16, 52, "下一个<br>tile", "text-neutral-400"),
       lab(Z_X + 4, cy("next_group") - 28, 96, "下一个 z 段", "text-neutral-400"),
       "</div>"]
print("{# 由 ui/tailwind/gen_overview_graph.py 生成，改流程图请改那个脚本 #}")
print("\n".join(out))
