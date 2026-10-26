// 总览页的交互：右侧手风琴（悬停展开、一次一个）、和左侧流程图联动、两栏之间跟着滚动走的进度线。
(() => {
  const acc = document.getElementById("ov-acc");
  const steps = acc ? [...acc.querySelectorAll(".ov-step")] : [];
  const nodes = [...document.querySelectorAll(".ov-node[data-node]")];
  const hoverable = matchMedia("(hover: hover) and (pointer: fine)").matches;
  let current = null;

  function open(id) {
    if (id === current) return;
    current = id;
    for (const li of steps) {
      const on = li.dataset.step === id;
      li.toggleAttribute("data-open", on);
      li.querySelector(".ov-step-head").setAttribute("aria-expanded", on ? "true" : "false");
    }
    for (const n of nodes) {
      const on = n.dataset.node === id;
      n.toggleAttribute("data-on", on);
      n.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  for (const li of steps) {
    const id = li.dataset.step, head = li.querySelector(".ov-step-head");
    // 鼠标进入整行就展开（标题、说明、按钮都在这一行里，移动时不会闪）；触屏和键盘：点击 / 聚焦
    li.addEventListener("mouseenter", () => { if (hoverable) open(id); });
    head.addEventListener("focus", () => open(id));
    head.addEventListener("click", () => { if (!hoverable) open(current === id ? null : id); });
  }
  if (acc) acc.addEventListener("mouseleave", () => { if (hoverable) open(null); });

  // 点流程图节点：右边展开对应的一步（没有对应行的控制节点，如「取下一个 z 段」，只高亮自己）
  for (const n of nodes) {
    n.addEventListener("click", () => {
      const id = n.dataset.node;
      open(current === id ? null : id);
      const li = steps.find((x) => x.dataset.step === id);
      if (li && !hoverable) li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  // 进度线：两栏区域顶部到视口顶部 = 0，底部到视口底部 = 1，中间线性；每帧跟随真实滚动位置
  const split = document.getElementById("ov-split"), bar = document.getElementById("ov-progress");
  if (split && bar) {
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = split.getBoundingClientRect(), range = r.height - innerHeight;
      const p = range > 0 ? Math.min(1, Math.max(0, -r.top / range)) : r.top <= 0 ? 1 : 0;
      bar.style.transform = `scaleY(${p.toFixed(4)})`;
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(update); };
    addEventListener("scroll", queue, { passive: true });
    addEventListener("resize", queue);
    update();
  }
})();
