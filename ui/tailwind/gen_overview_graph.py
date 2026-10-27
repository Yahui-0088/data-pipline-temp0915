"""生成总览页左侧 LangGraph 流程图的 HTML 片段（卡片绝对定位 + 一张 SVG 画所有连线）。
流程图的结构是固定的（emqc/qc/workflow.py 的图），只有节点上的耗时是数据，由模板填。
用法：python ui/tailwind/gen_overview_graph.py > emqc/api/templates/_overview_graph.html"""
A_L, A_W = 130, 220; A_C = A_L + A_W // 2; A_R = A_L + A_W
B_L, B_W = 440, 180; B_C = B_L + B_W // 2
JX, TILE_X, Z_X = 395, 86, 30
H, DH = 60, 84
rows = {"start": (16, 32), "prepare": (82, H), "next_group": (172, DH), "ingest": (292, H), "slice_qc": (382, H), "serial_qc": (472, H),
        "aggregate": (562, H), "persist": (652, DH), "group_done": (772, H)}
cy = lambda k: rows[k][0] + rows[k][1] // 2
top = lambda k: rows[k][0]
bot = lambda k: rows[k][0] + rows[k][1]
W, HH = 630, 848
fin_top, end_top, can_top = cy("next_group") - H // 2, cy("ingest") - 16, cy("slice_qc") - H // 2

paths = []
def rounded(pts, r=10):
    """水平 / 垂直折线 → 拐角处用圆弧（二次贝塞尔）过渡的 path；流光沿它走，过弯连续不跳。"""
    if len(pts) < 3:
        return "M " + " L ".join(f"{x} {y}" for x, y in pts)
    out = [f"M {pts[0][0]} {pts[0][1]}"]
    for i in range(1, len(pts) - 1):
        (x0, y0), (x1, y1), (x2, y2) = pts[i - 1], pts[i], pts[i + 1]
        l1 = max(abs(x1 - x0), abs(y1 - y0)); l2 = max(abs(x2 - x1), abs(y2 - y1)); rr = min(r, l1 / 2, l2 / 2)
        ax = x1 - (x1 - x0) / l1 * rr if l1 else x1; ay = y1 - (y1 - y0) / l1 * rr if l1 else y1
        bx = x1 + (x2 - x1) / l2 * rr if l2 else x1; by = y1 + (y2 - y1) / l2 * rr if l2 else y1
        out.append(f"L {ax:g} {ay:g} Q {x1} {y1} {bx:g} {by:g}")
    out.append(f"L {pts[-1][0]} {pts[-1][1]}")
    return " ".join(out)


def seg(pts, head=True, dash=False, cls="text-neutral-600", ends=("", ""), kind="call"):
    # kind：call = 往下调用（蓝）/ answer = 回到前面的循环（青绿）；流光颜色按它来
    d = rounded(pts)
    paths.append(f'<path d="{d}" data-a="{ends[0]}" data-b="{ends[1]}" data-kind="{kind}" class="ov-edge" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" fill="none"{" stroke-dasharray=&quot;4 4&quot;" if dash else ""}{" marker-end=&quot;url(#ov-head)&quot;" if head else ""}/>'.replace("&quot;", '"'))
seq = ["prepare", "next_group", "ingest", "slice_qc", "serial_qc", "aggregate", "persist", "group_done"]
seg([(A_C, bot("start")), (A_C, top("prepare") - 3)], ends=("start", "prepare"))
for a, b in zip(seq, seq[1:]):
    seg([(A_C, bot(a)), (A_C, top(b) - 3)], ends=(a, b))
y = cy("next_group")
seg([(A_R, y), (B_L - 3, y)], ends=("next_group", "finalize"))
seg([(JX, y), (JX, cy("slice_qc")), (B_L - 3, cy("slice_qc"))], dash=True, ends=("next_group", "cancel"))
seg([(B_C, fin_top + H), (B_C, end_top - 3)], ends=("finalize", "end"))
seg([(B_C, can_top), (B_C, end_top + 32 + 3)], dash=True, ends=("cancel", "end"))
seg([(A_L, cy("persist")), (TILE_X, cy("persist")), (TILE_X, cy("slice_qc")), (A_L - 3, cy("slice_qc"))], ends=("persist", "slice_qc"), kind="answer")
seg([(A_L, cy("group_done")), (Z_X, cy("group_done")), (Z_X, cy("next_group")), (A_L - 3, cy("next_group"))], ends=("group_done", "next_group"), kind="answer")

def node(k, title, sub_tpl, diamond=False, left=A_L, width=A_W, t=None):
    t = rows[k][0] if t is None else t
    h = DH if diamond else H
    shape = "ov-diamond" if diamond else "ov-box"
    return (f'<button type="button" data-node="{k}" aria-pressed="false" class="ov-node {shape}" style="left:{left}px;top:{t}px;width:{width}px;height:{h}px">'
            f'<span class="block text-[16px] font-semibold leading-tight">{title}</span>'
            + (f'<span class="block mt-1 text-[13px] text-neutral-400 tabular-nums">{sub_tpl}</span>' if sub_tpl else "") + '</button>')
pill = lambda left, t, txt: f'<div class="absolute flex items-center justify-center rounded-full border border-dashed border-neutral-700 bg-ink-900 font-mono text-[12px] text-neutral-400" style="left:{left}px;top:{t}px;width:96px;height:32px">{txt}</div>'
lab = lambda left, t, w, txt, cls="text-neutral-400": f'<div class="absolute text-center text-[13px] leading-4 {cls}" style="left:{left}px;top:{t}px;width:{w}px">{txt}</div>'
tm = lambda k, extra="": "{{ node_time.get('%s', '') }}%s" % (k, extra)
loop = "{% if n_tiles %} · ×{{ n_tiles }}{% endif %}"

out = [f'<div class="relative" style="width:{W}px;height:{HH}px">',
       f'<svg class="absolute inset-0" width="{W}" height="{HH}" viewBox="0 0 {W} {HH}" aria-hidden="true">'
       '<defs><marker id="ov-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
       '<path d="M0 0 L8 4 L0 8 Z" fill="rgba(255,255,255,0.32)"/></marker></defs>', *paths, '<g id="ov-flow" fill="none" stroke-linecap="round"></g>', "</svg>",
       pill(A_C - 48, top("start"), "__start__"),
       node("prepare", "打开数据", ""),
       node("next_group", "取下一个 z 段", "条件分支", diamond=True),
       node("ingest", "读取", tm("ingest")),
       node("slice_qc", "切片检查", tm("slice_qc", loop)),
       node("serial_qc", "序列检查", tm("serial_qc", loop)),
       node("aggregate", "汇总 · 分级", tm("aggregate", loop)),
       node("persist", "落库", tm("persist") + " · 条件分支", diamond=True),
       node("group_done", "本段完成", "回到取下一个 z 段"),
       node("finalize", "结果汇总", "{% if ds_grade %}等级 {{ ds_grade }} · {% endif %}{{ pct(latest.retention) if latest else '' }}", left=B_L, width=B_W, t=fin_top),
       pill(B_C - 48, end_top, "__end__"),
       f'<div class="absolute flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-700 bg-ink-900 text-center text-neutral-400" style="left:{B_L}px;top:{can_top}px;width:{B_W}px;height:{H}px"><span class="text-[16px] font-semibold">取消</span><span class="text-[12px]">请求取消时走这里</span></div>',
       lab(A_C + 10, (bot("next_group") + top("ingest")) // 2 - 8, 72, "还有 z 段"),
       lab(A_R + (B_L - A_R) // 2 - 40, cy("next_group") - 30, 80, "全部完成"),
       lab(JX + 6, cy("slice_qc") + 10, 40, "取消"),
       lab(Z_X + 2, (cy("slice_qc") + cy("persist")) // 2 - 16, 54, "下一个<br>tile", "text-neutral-400"),
       lab(Z_X + 2, cy("next_group") - 30, 100, "下一个 z 段", "text-neutral-400"),
       "</div>"]
print("{# 由 ui/tailwind/gen_overview_graph.py 生成，改流程图请改那个脚本 #}")
print("\n".join(out))
