/* ===========================================================================
 * autocorrect.js —— 读数自动校正（时序连续性 + 突变二次/三次验证）
 *
 * 为什么需要它
 * ------------
 * 1) 后处理正则吃掉小数点：模型把小数点读成逗号（5,6）时，老代码先删逗号再找点，
 *    结果 5.6 变成 56、23.6 变成 236。本模块先从原始文本枚举所有可能读数，
 *    再按“和上一段趋势是否吻合”来挑，逗号/空格/错位都能救回来。
 * 2) 单帧结果不可信：屏幕反光、手抖、刷新瞬间都可能读错。同一台仪器的读数
 *    在秒级尺度上变化平缓，所以「明显跳变」的帧值得再读两次确认。
 *
 * 设计原则（重要）
 * ----------------
 * · 只做“选择 + 复核”，绝不凭空造数：候选值全部来自模型输出的文本。
 * · 一致性优先于连续性：三次读数里有两次一致，就算它和预测不符也采信——
 *   真实浓度突变不能被算法压住，只是标记出来让人复核。
 * · 宁可疑，不可错：三次互不相同时取最接近预测的那个，并打「待复核」。
 * ========================================================================= */
(function (global) {
  "use strict";

  /* PGM-7300 量程 0~5000 ppm，超出这个范围的候选直接丢弃 */
  const RANGE_MIN = 0;
  const RANGE_MAX = 5000;

  /* 候选来源的“可信权重”，单位是 ln 比值，越小越优先 */
  const PENALTY = {
    原样: 0,        // 文本里本来就带点
    去点: 0.18,     // 文本带点，但也可能是噪点导致的多余点
    整数: 0.08,     // 文本没有点
    补点: 0.30,     // 由纯数字串插入小数点得来，需要“明显更吻合”才选
  };

  const DEFAULT_OPTS = {
    absTol: 0.40,       // 绝对容差（ppm），低于它的小起伏不打扰
    absRel: 0.03,       // 绝对容差随量程放大的比例（大量程下 0.4 ppm 太紧）
    tolRel: 0.15,       // 相对容差：15%
    maxHist: 8,         // 保留多少个已采纳点用于预测
    clusterRel: 0.04,   // 判定“两次读数一致”的相对阈值
    clusterAbs: 0.15,   // 判定“两次读数一致”的绝对阈值
    verifyTimes: 2,     // 触发校正后再读几次（2 = 总共三次验证）
  };

  function opts(o) { return Object.assign({}, DEFAULT_OPTS, o || {}); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function median(arr) {
    if (!arr.length) return NaN;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* ------------------------------------------------------- 文本归一化
   * 全角→半角、各种“像点”的符号统一成 .、去掉空白。
   * 注意：本仪器不显示千分位，所以逗号一律按小数点理解。
   */
  function normText(raw) {
    let t = String(raw == null ? "" : raw);
    t = t.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    t = t.replace(/[，,·。．、′’']/g, ".");
    t = t.replace(/[：:]/g, ".");
    return t.replace(/\s+/g, " ").trim();
  }

  /* 由原始文本枚举出所有可能的读数，带上是哪种来源 */
  function candidates(raw) {
    const t = normText(raw);
    const seen = new Map();
    const add = (v, how) => {
      if (!isFinite(v)) return;
      if (v < RANGE_MIN || v > RANGE_MAX) return;
      if (!seen.has(v)) seen.set(v, how);
    };

    const m = t.match(/(\d+)\.(\d{1,3})/);
    if (m) {
      add(parseFloat(m[1] + "." + m[2]), "原样");
      add(parseFloat(m[1] + m[2]), "去点");
    }

    const d = t.replace(/[^0-9]/g, "");
    if (d) {
      add(parseFloat(d), d.length <= 1 ? "原样" : "整数");
      for (let i = 1; i < d.length; i++) {
        const tail = d.length - i;
        if (tail >= 1 && tail <= 3) add(parseFloat(d.slice(0, i) + "." + d.slice(i)), "补点");
      }
    }

    return [...seen.entries()].map(([value, how]) => ({ value, how }));
  }

  /* 没有任何历史时怎么选：优先文本原样，其次整数，最后补点 */
  function pickCold(cands) {
    if (!cands.length) return null;
    const rank = { 原样: 0, 整数: 1, 去点: 2, 补点: 3 };
    return cands.slice().sort((a, b) => rank[a.how] - rank[b.how])[0];
  }

  /* 有历史时：按「和预测值的对数距离 + 来源惩罚」挑一个 */
  function pickWarm(cands, pred) {
    let best = null, bestCost = Infinity;
    for (const c of cands) {
      if (c.value <= 0) continue;
      const dist = Math.abs(Math.log(c.value / pred));
      const cost = dist + (PENALTY[c.how] || 0);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return best || pickCold(cands);
  }

  /* ------------------------------------------------------------- 预测
   * 用最近三段的斜率中位数外推到当前时刻，再限幅，避免把一次错读放大。
   */
  /* ------------------------------------------------------------- 趋势
   * 只估计“变化速度”，不外推具体数值——两点间线性外推一旦碰上错读就会爆表，
   * 而把速度折算成容差更稳：趋势快，允许的偏差就大一点，但不会因此造出数值。
   */
  function slopeOf(state) {
    const h = (state && state.hist) || [];
    if (h.length < 2) return 0;
    const segs = [];
    for (let i = Math.max(1, h.length - 3); i < h.length; i++) {
      const dt = (h[i].t - h[i - 1].t) / 1000;
      if (dt > 0.2) segs.push((h[i].v - h[i - 1].v) / dt);
    }
    return segs.length ? median(segs) : 0;
  }

  /* 预测值就取上一个采纳点；趋势体现在下面的限幅里 */
  function predict(state, now, rawOpts) {
    const h = (state && state.hist) || [];
    if (!h.length) return NaN;
    return h[h.length - 1].v;
  }

  /* 两道独立的容差：绝对（小读数时管用）和相对（大读数时管用）。
   * 只要有一道被突破就去复核——宁可多读两次，也别放过一个错值。
   * 采样间隔越大、趋势越快，本来允许的变化就越大，所以再加一个趋势补偿。
   */
  function limits(prev, pred, state, now, rawOpts) {
    const o = opts(rawOpts);
    const scale = Math.max(Math.abs(prev), isFinite(pred) ? Math.abs(pred) : 0);
    let k = 1;
    const h = (state && state.hist) || [];
    if (h.length) {
      const dt = Math.max(0.5, (now - h[h.length - 1].t) / 1000);
      k = clamp(Math.sqrt(dt / 5), 1, 2.5);
    }
    const slope = slopeOf(state);
    const dtNow = h.length ? Math.max(0, (now - h[h.length - 1].t) / 1000) : 0;
    // 趋势补偿最多不超过「上一点的一半 + 一倍绝对容差」，防止一次错读把窗口撑爆
    const trend = clamp(Math.abs(slope) * Math.min(dtNow, 30), 0, 0.5 * scale + o.absTol);
    return {
      abs: Math.max(o.absTol, o.absRel * scale) * k + trend,
      rel: o.tolRel * scale * k + trend,
      trend,
      k,
    };
  }

  /* 兼容用的单一容差（供 decide 判断“离预测有多远”） */
  function tolerance(prev, pred, state, now, rawOpts) {
    const L = limits(prev, pred, state, now, rawOpts);
    return Math.max(L.abs, L.rel);
  }

  /* 判断这一帧是否需要复核 */
  function assess(state, value, now, rawOpts) {
    const o = opts(rawOpts);
    const h = (state && state.hist) || [];
    const pred = predict(state, now, o);
    if (value == null || !h.length || !isFinite(pred)) return { need: false, pred };
    const L = limits(h[h.length - 1].v, pred, state, now, o);
    const delta = Math.abs(value - pred);
    const need = delta > L.abs || delta > L.rel;
    return { need, pred, tol: Math.max(L.abs, L.rel), delta, abs: L.abs, rel: L.rel };
  }

  /* --------------------------------------------------------- 多次读数合并 */
  function cluster(vals, tol) {
    const sorted = vals.slice().sort((a, b) => a - b);
    const out = [];
    for (const v of sorted) {
      const last = out[out.length - 1];
      if (last && v - last.max <= tol) {
        last.items.push(v);
        last.max = v;
        last.center = median(last.items);
      } else {
        out.push({ items: [v], max: v, center: v });
      }
    }
    return out.map((c) => ({ n: c.items.length, center: c.center }));
  }

  function clusterTol(vals, o) {
    return Math.max(o.clusterAbs, o.clusterRel * Math.max.apply(null, vals.map(Math.abs)));
  }

  /* 连续上升/下降、变化幅度合理、方向与历史趋势一致 → 认为在跟随真实变化，不是错读。
   * 加一个跨度上限：三次读数差 4 倍本身就更像错读，而不是一次真实爬升。
   */
  function isRamp(reads, state) {
    const v = reads.filter((r) => r.value != null).map((r) => r.value);
    if (v.length < 2) return false;
    let up = true, down = true;
    for (let i = 1; i < v.length; i++) {
      if (v[i] < v[i - 1]) up = false;
      if (v[i] > v[i - 1]) down = false;
    }
    if (!up && !down) return false;
    const lo = Math.min.apply(null, v.map(Math.abs));
    const hi = Math.max.apply(null, v.map(Math.abs));
    if (lo > 0 && hi / lo > 1.8) return false;
    const h = (state && state.hist) || [];
    if (h.length >= 2) {
      const trend = h[h.length - 1].v - h[0].v;
      if (up && trend < 0) return false;
      if (down && trend > 0) return false;
    }
    return true;
  }

  /* reads: [{ value, score, how }]，按读取先后排列
   * 返回 { value, flag, note, votes, center }
   */
  function decide(reads, pred, tol, state, rawOpts) {
    const o = opts(rawOpts);
    const list = (reads || []).filter((r) => r.value != null);
    const total = (reads || []).length;

    if (!list.length) return { value: null, flag: "未识别", note: "", votes: "0/" + total };

    const vals = list.map((r) => r.value);
    const cs = cluster(vals, clusterTol(vals, o)).sort(
      (a, b) => b.n - a.n || Math.abs(a.center - pred) - Math.abs(b.center - pred)
    );
    const top = cs[0];

    /* 三次一致：直接采信，并说明是突变还是稳住了 */
    if (cs.length === 1) {
      const far = isFinite(pred) && Math.abs(top.center - pred) > tol;
      return {
        value: top.center,
        flag: "",
        note: far ? "突变已确认" : "",
        votes: total + "/" + total,
        center: top.center,
      };
    }

    /* 两次一致：以多数为准 */
    if (top.n >= 2) {
      return {
        value: top.center,
        flag: "",
        note: "二次确认",
        votes: top.n + "/" + total,
        center: top.center,
      };
    }

    /* 三次全不一致：若是单调跟随趋势，按最新值采信 */
    if (isRamp(reads, state)) {
      const last = list[list.length - 1];
      return { value: last.value, flag: "", note: "跟随趋势", votes: "1/" + total, center: last.value };
    }

    /* 否则取最接近预测的那个，并标待复核 */
    let best = list[0], bestD = Infinity;
    for (const r of list) {
      const d = isFinite(pred) ? Math.abs(r.value - pred) : 0;
      if (d < bestD) { bestD = d; best = r; }
    }
    return { value: best.value, flag: "待复核", note: "读数抖动", votes: "1/" + total, center: best.value };
  }

  /* ------------------------------------------------------------ 状态维护 */
  function createState() { return { hist: [] }; }

  function push(state, value, t, rawOpts) {
    const o = opts(rawOpts);
    if (value == null || !isFinite(value)) return;
    state.hist.push({ v: value, t: t });
    while (state.hist.length > o.maxHist) state.hist.shift();
  }

  function reset(state) { state.hist.length = 0; }

  /* 把一次读取（含原始文本）折算成候选值 */
  function pickValue(rawText, pred, rawOpts) {
    const cands = candidates(rawText);
    if (!cands.length) return null;
    const best = (isFinite(pred) && pred > 0) ? pickWarm(cands, pred) : pickCold(cands);
    return { value: best.value, how: best.how, changed: best.how === "补点" || best.how === "去点" };
  }

  const API = {
    normText, candidates, pickValue, predict, slopeOf, tolerance, limits, assess,
    decide, createState, push, reset, cluster, isRamp,
    DEFAULT_OPTS,
  };

  global.AutoCorrect = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
