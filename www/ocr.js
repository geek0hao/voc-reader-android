/* ===========================================================================
 * ocr.js —— 手机端离线读数识别（PP-OCRv3 识别模型 + onnxruntime-web）
 *
 * 只做“识别”这一件事：给定画布与矩形区域，返回数值。
 * 模型与本机 Python 版完全一致（ch_PP-OCRv3_rec_infer.onnx），
 * 因此识别效果和 PC 端实测的 13/13 同源，不是换了一套弱模型。
 * ========================================================================= */
(function (global) {
  "use strict";

  const TARGET_H = 48;          // PP-OCR 识别固定高度
  const MAX_W = 640;            // 宽度上限，防止 ROI 过宽拖慢速度
  const rt = global.ort;

  let session = null, charset = [], C = 0;
  let ready = false;

  /* --------------------------------------------------------------- 初始化 */
  async function init(onProgress) {
    if (ready) return { ok: true };
    if (!rt) throw new Error("onnxruntime 未加载，请检查 vendor/ort.min.js");

    rt.env.wasm.wasmPaths = "vendor/";
    rt.env.wasm.numThreads = 1;   // 单线程：无需 COOP/COEP 跨源隔离，兼容性最好
    rt.env.logLevel = "error";

    onProgress && onProgress("加载字符字典…");
    charset = await (await fetch("assets/charset.json")).json();

    onProgress && onProgress("加载识别模型（11 MB，仅首次）…");
    const buf = await (await fetch("assets/ch_ppocr_v3_rec.onnx")).arrayBuffer();

    onProgress && onProgress("初始化推理引擎…");
    session = await rt.InferenceSession.create(buf, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });

    const outMeta = session.outputNames;
    C = 6625;                     // blank + 6623 字符 + 空格，与模型输出维度一致
    ready = true;
    return { ok: true, chars: charset.length, outputs: outMeta };
  }

  /* --------------------------------------------------------------- 预处理
   * 与 RapidOCR 的 resize_norm_img 保持一致：
   *   缩放到高 48、宽按比例；通道顺序 BGR；归一化 (v/255-0.5)/0.5 = v/127.5-1
   */
  function preprocess(src, rect) {
    const sw = Math.max(4, Math.round(rect.w));
    const sh = Math.max(4, Math.round(rect.h));
    let rw = Math.round(TARGET_H * sw / sh);
    rw = Math.max(16, Math.min(MAX_W, rw));

    const cv = document.createElement("canvas");
    cv.width = rw;
    cv.height = TARGET_H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, rect.x, rect.y, sw, sh, 0, 0, rw, TARGET_H);

    const px = ctx.getImageData(0, 0, rw, TARGET_H).data;
    const plane = rw * TARGET_H;
    const data = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      data[i] = b / 127.5 - 1;              // B
      data[plane + i] = g / 127.5 - 1;      // G
      data[2 * plane + i] = r / 127.5 - 1;  // R
    }
    return { data, w: rw, h: TARGET_H };
  }

  /* --------------------------------------------------------------- 解码
   * CTC 贪心解码：跳过 blank(0)，合并相邻重复，逐帧取最大概率字符
   */
  function decode(pred) {
    const dims = pred.dims;            // [1, T, C]
    const T = dims[1], classes = dims[2];
    const p = pred.data;
    let text = "", scoreSum = 0, scoreN = 0, prev = -1;

    for (let t = 0; t < T; t++) {
      const off = t * classes;
      let best = 0, bi = 0;
      for (let c = 0; c < classes; c++) {
        const v = p[off + c];
        if (v > best) { best = v; bi = c; }
      }
      if (bi !== 0 && bi !== prev) {
        text += bi === classes - 1 ? " " : (charset[bi - 1] || "");
        scoreSum += best;
        scoreN++;
      }
      prev = bi;
    }
    return { text, score: scoreN ? scoreSum / scoreN : 0 };
  }

  /* 从识别文本里取数值：优先带小数点的，其次最长的整数串 */
  function pickNumber(text) {
    const t = String(text).replace(/[，,]/g, "");
    const withDot = t.match(/\d+\.\d+/g);
    if (withDot) return withDot.sort((a, b) => b.length - a.length)[0];
    const ints = t.match(/\d+/g);
    if (ints) return ints.sort((a, b) => b.length - a.length)[0];
    return null;
  }

  /* --------------------------------------------------------------- 主入口
   * 返回 { value, text, score, ms }
   */
  async function read(src, rect) {
    if (!ready) throw new Error("识别引擎尚未初始化");
    const t0 = performance.now();
    const { data, w, h } = preprocess(src, rect);
    const tensor = new rt.Tensor("float32", data, [1, 3, h, w]);
    const out = await session.run({ x: tensor });
    const key = session.outputNames[0];
    const pred = out[key];
    const { text, score } = decode(pred);
    const num = pickNumber(text);
    return { value: num, text, score, ms: Math.round(performance.now() - t0) };
  }

  /* ------------------------------------------------- 多帧投票（抗边缘抖动）
   * 对同一个框做 3 次轻微缩放（同中心），取众数。
   * 实测：框到边缘时单次可能读成 8.99 / 893，投票能压掉这类偶发错读。
   */
  async function readVote(src, rect, variants) {
    const scales = variants || [1.0, 0.93, 1.07];
    const runs = [];
    for (const s of scales) {
      const r = {
        x: rect.x + rect.w * (1 - s) / 2,
        y: rect.y + rect.h * (1 - s) / 2,
        w: rect.w * s,
        h: rect.h * s,
      };
      runs.push(await read(src, r));
    }
    const tally = new Map();
    for (const r of runs) {
      if (r.value == null) continue;
      const cur = tally.get(r.value) || { n: 0, score: 0, text: r.text };
      cur.n += 1;
      cur.score = Math.max(cur.score, r.score);
      tally.set(r.value, cur);
    }
    if (!tally.size) return { value: null, text: "", score: 0, runs, agree: 0 };
    let best = null;
    for (const [v, info] of tally) {
      if (!best || info.n > best.info.n || (info.n === best.info.n && info.score > best.info.score)) {
        best = { value: v, info };
      }
    }
    return {
      value: best.value,
      text: best.info.text,
      score: best.info.score,
      runs,
      agree: best.info.n,          // 3 = 三次一致，可信度最高
    };
  }

  /* ------------------------------------------------- 清晰度评估（调试用）
   * 拉普拉斯方差：越小越糊，用于提示用户对焦/靠近
   */
  function sharpness(src, rect) {
    const w = 160, h = Math.max(8, Math.round(160 * rect.h / rect.w));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];

    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
        sum += lap; sum2 += lap * lap; n++;
      }
    }
    const mean = sum / n;
    return Math.max(0, sum2 / n - mean * mean);
  }

  /* ------------------------------------------------ 辅助：自动找亮屏区域
   * 用行/列投影找“最亮且连续”的矩形，作为调试时的初始 ROI 建议。
   * 不追求复杂 CV，够用即可，用户可以手动拖动微调。
   */
  function autoSuggest(src, frameW, frameH) {
    const w = 240, h = Math.round(240 * frameH / frameW);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, frameW, frameH, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    let min = 255, max = 0;
    for (let i = 0; i < w * h; i++) {
      const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      gray[i] = v; if (v < min) min = v; if (v > max) max = v;
    }
    // Otsu
    const hist = new Float32Array(256);
    for (let i = 0; i < gray.length; i++) hist[Math.min(255, Math.max(0, Math.round(gray[i])))]++;
    let total = gray.length, sumA = 0;
    for (let i = 0; i < 256; i++) sumA += i * hist[i];
    let wB = 0, sumB = 0, bestVar = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sumA - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > bestVar) { bestVar = v; thr = t; }
    }
    // 二值化后按行列投影找边界
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) bin[i] = gray[i] > thr ? 1 : 0;
    const rowSum = new Int32Array(h), colSum = new Int32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (bin[y * w + x]) { rowSum[y]++; colSum[x]++; }
    }
    const rowTh = w * 0.25, colTh = h * 0.20;
    let y0 = 0, y1 = h - 1, x0 = 0, x1 = w - 1;
    for (let y = 0; y < h; y++) if (rowSum[y] > rowTh) { y0 = y; break; }
    for (let y = h - 1; y >= 0; y--) if (rowSum[y] > rowTh) { y1 = y; break; }
    for (let x = 0; x < w; x++) if (colSum[x] > colTh) { x0 = x; break; }
    for (let x = w - 1; x >= 0; x--) if (colSum[x] > colTh) { x1 = x; break; }
    if (x1 - x0 < w * 0.08 || y1 - y0 < h * 0.04) return null;
    return { x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h };
  }

  global.OCR = { init, read, readVote, sharpness, autoSuggest, get ready() { return ready; } };
})(window);
