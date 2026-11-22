/* ===========================================================================
 * ocr.js —— 手机端离线读数识别（PP-OCRv3 检测 + 识别 双模型）
 *
 * 为什么改成两个模型
 * ------------------
 * 上一版只有 rec（识别）模型，会把“框里的整块画面”当作一行文字压到 48px 高，
 * 屏幕上同时有数值、单位、状态、菜单时必然读乱（实测置信度只有 0.29）。
 * 本版补上 det（DBNet 文字检测）模型，先在框内找出每一行文字，再把“单独一行”
 * 送进 rec —— 与 PC 端 13/13 的流程完全一致。
 * ========================================================================= */
(function (global) {
  "use strict";

  /* rec 固定输入高，宽上限防止超长行拖慢 */
  const REC_H = 48;
  const REC_MAX_W = 640;

  /* det 输入尺寸（短边放大到 320，长边不超过 960；都是 32 的倍数）
   * 官方是短边 736，手机单线程 wasm 跑那个太慢，实测 320 已足够定位屏幕数字 */
  const DET_MIN_SIDE = 320;
  const DET_MAX_SIDE = 960;

  /* 与 rapidocr config.yaml 保持一致 */
  const DET_THRESH = 0.3;        // 概率图二值化阈值
  const DET_BOX_THRESH = 0.5;    // 每个候选框的平均置信度下限
  const DET_UNCLIP = 1.6;        // 外扩系数（把文字区域往外张一点）
  const DET_MEAN = [0.485, 0.456, 0.406];
  const DET_STD = [0.229, 0.224, 0.225];

  const rt = global.ort;
  let detS = null, recS = null, charset = [];
  let ready = false, detOut = "", recOut = "";

  /* --------------------------------------------------------------- 初始化 */
  async function init(onProgress) {
    if (ready) return { ok: true };
    if (!rt) throw new Error("onnxruntime 未加载，请检查 vendor/ort.min.js");

    rt.env.wasm.wasmPaths = "vendor/";
    rt.env.wasm.numThreads = 1;   // 单线程：无需 COOP/COEP 跨源隔离，兼容性最好
    rt.env.logLevel = "error";

    onProgress && onProgress("加载字符字典…");
    charset = await (await fetch("assets/charset.json")).json();

    onProgress && onProgress("加载文字检测模型（2.4 MB）…");
    const detBuf = await (await fetch("assets/ch_ppocr_v3_det.onnx")).arrayBuffer();

    onProgress && onProgress("加载识别模型（11 MB，仅首次）…");
    const recBuf = await (await fetch("assets/ch_ppocr_v3_rec.onnx")).arrayBuffer();

    onProgress && onProgress("初始化推理引擎…");
    detS = await rt.InferenceSession.create(detBuf, {
      executionProviders: ["wasm"], graphOptimizationLevel: "all",
    });
    recS = await rt.InferenceSession.create(recBuf, {
      executionProviders: ["wasm"], graphOptimizationLevel: "all",
    });
    detOut = detS.outputNames[0];
    recOut = recS.outputNames[0];
    ready = true;
    return { ok: true, chars: charset.length };
  }

  /* ------------------------------------------------------- 复用画布，避免反复建 */
  let scratch = null;
  function scratchFor(w, h) {
    if (!scratch) scratch = document.createElement("canvas");
    if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
    return scratch;
  }

  /* 把 ROI 一次性裁到离屏画布，后续 det/rec 都只操作这块小图 */
  function cropToScratch(src, rect) {
    const w = Math.max(12, Math.round(rect.w));
    const h = Math.max(12, Math.round(rect.h));
    const cv = scratchFor(w, h);
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(src, Math.round(rect.x), Math.round(rect.y), w, h, 0, 0, w, h);
    return { cv, w, h };
  }

  /* =========================================================== 检测模型 det */
  function detPreprocess(sc) {
    const rw = sc.w, rh = sc.h;
    let scale = 1;
    const minSide = Math.min(rw, rh);
    if (minSide < DET_MIN_SIDE) scale = DET_MIN_SIDE / minSide;
    const longSide = Math.max(rw, rh) * scale;
    if (longSide > DET_MAX_SIDE) scale *= DET_MAX_SIDE / longSide;

    const W = Math.max(32, Math.round(rw * scale / 32) * 32);
    const H = Math.max(32, Math.round(rh * scale / 32) * 32);

    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(sc.cv, 0, 0, rw, rh, 0, 0, W, H);

    const px = g.getImageData(0, 0, W, H).data;
    const plane = W * H;
    const data = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      const r = px[i * 4] / 255, gg = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255;
      data[i] = (r - DET_MEAN[0]) / DET_STD[0];
      data[plane + i] = (gg - DET_MEAN[1]) / DET_STD[1];
      data[2 * plane + i] = (b - DET_MEAN[2]) / DET_STD[2];
    }
    return { data, W, H };
  }

  /* DBNet 后处理：概率图 → 连通域 → 置信度过滤 → 外扩 → 原图坐标
   * 说明：官方用 pyclipper 做多边形外扩 + cv2.minAreaRect 求旋转矩形；
   * 这里对每个连通域取轴对齐外接框再按同一公式外扩，对屏幕文字足够，
   * 且纯 JS 实现，无需额外 wasm。
   */
  function dbPost(prob, W, H, sx, sy) {
    const n = W * H;
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = prob[i] > DET_THRESH ? 1 : 0;

    const visited = new Uint8Array(n);
    const stack = new Int32Array(n);
    const boxes = [];

    for (let start = 0; start < n; start++) {
      if (!bin[start] || visited[start]) continue;
      let sp = 0;
      stack[sp++] = start;
      visited[start] = 1;
      let minx = W, maxx = -1, miny = H, maxy = -1, cnt = 0, psum = 0;

      while (sp > 0) {
        const p = stack[--sp];
        const x = p % W, y = (p - x) / W;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        cnt++;
        psum += prob[p];
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const q = ny * W + nx;
            if (bin[q] && !visited[q]) { visited[q] = 1; stack[sp++] = q; }
          }
        }
      }

      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (bw < 2 || bh < 2) continue;
      const score = psum / cnt;
      if (score < DET_BOX_THRESH) continue;

      // unclip：distance = area * ratio / perimeter（矩形周长 2(w+h)）
      const d = (bw * bh) * DET_UNCLIP / (2 * (bw + bh));
      const x0 = Math.max(0, minx - d), y0 = Math.max(0, miny - d);
      const x1 = Math.min(W, maxx + 1 + d), y1 = Math.min(H, maxy + 1 + d);

      boxes.push({
        x: x0 * sx, y: y0 * sy,
        w: (x1 - x0) * sx, h: (y1 - y0) * sy,
        score,
      });
    }
    return boxes;
  }

  /* 只检测不识别：预览时以低帧率调用，实时把“程序看到的行”画出来 */
  async function detect(sc) {
    if (!ready) throw new Error("识别引擎尚未初始化");
    const { data, W, H } = detPreprocess(sc);
    const t = new rt.Tensor("float32", data, [1, 3, H, W]);
    const out = await detS.run({ x: t });
    return dbPost(out[detOut].data, W, H, sc.w / W, sc.h / H);
  }

  /* =========================================================== 识别模型 rec */

  /* 对比度拉伸：液晶点阵字与底色灰度差很小，把 2%~98% 分位拉到 0~255，
   * 笔画边界会明显变清晰。返回 256 项查找表；对比度本来就够时返回 null。 */
  function contrastLut(px, plane) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < plane; i++) {
      hist[(px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8]++;
    }
    const cut = plane * 0.02;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
    if (hi - lo < 24) return null;            // 纯色块或对比度已足够，不处理
    const k = 255 / (hi - lo);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - lo) * k;
    return lut;
  }

  function recPreprocess(src, rect, opts) {
    const o = opts || {};
    const sw = Math.max(4, Math.round(rect.w));
    const sh = Math.max(4, Math.round(rect.h));
    let rw = Math.round(REC_H * sw / sh);
    rw = Math.max(16, Math.min(REC_MAX_W, rw));

    const cv = document.createElement("canvas");
    cv.width = rw; cv.height = REC_H;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";

    /* 超采样：先放大到 N 倍再缩回 48px 高。多一次插值等于低通滤波，
     * 能把点阵屏的锯齿边缘磨平，更接近印刷体（PC 端 upscale 3x 就是这么起作用的）。 */
    const up = Math.max(1, Math.min(4, o.upscale || 1));
    if (up > 1) {
      const mid = document.createElement("canvas");
      mid.width = rw * up; mid.height = REC_H * up;
      const gm = mid.getContext("2d", { willReadFrequently: true });
      gm.imageSmoothingEnabled = true;
      gm.imageSmoothingQuality = "high";
      gm.drawImage(src, Math.round(rect.x), Math.round(rect.y), sw, sh, 0, 0, mid.width, mid.height);
      g.drawImage(mid, 0, 0, rw, REC_H);
    } else {
      g.drawImage(src, Math.round(rect.x), Math.round(rect.y), sw, sh, 0, 0, rw, REC_H);
    }

    const px = g.getImageData(0, 0, rw, REC_H).data;
    const plane = rw * REC_H;

    if (o.enhance !== false) {
      const lut = contrastLut(px, plane);
      if (lut) {
        for (let i = 0; i < plane; i++) {
          const off = i * 4;
          px[off] = lut[px[off]];
          px[off + 1] = lut[px[off + 1]];
          px[off + 2] = lut[px[off + 2]];
        }
      }
    }

    const data = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
      data[i] = b / 127.5 - 1;              // B（rec 用 BGR）
      data[plane + i] = gg / 127.5 - 1;     // G
      data[2 * plane + i] = r / 127.5 - 1;  // R
    }
    return { data, w: rw, h: REC_H };
  }

  /* CTC 贪心解码：跳过 blank(0)，合并相邻重复，逐帧取最大概率字符 */
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

  /* 取数值：优先带小数点的，其次最长的整数串 */
  function pickNumber(text) {
    const t = String(text).replace(/[，,]/g, "");
    const withDot = t.match(/\d+\.\d+/g);
    if (withDot) return withDot.sort((a, b) => b.length - a.length)[0];
    const ints = t.match(/\d+/g);
    if (ints) return ints.sort((a, b) => b.length - a.length)[0];
    return null;
  }

  async function readLine(src, rect, opts) {
    const t0 = performance.now();
    const { data, w, h } = recPreprocess(src, rect, opts);
    const tensor = new rt.Tensor("float32", data, [1, 3, h, w]);
    const out = await recS.run({ x: tensor });
    const { text, score } = decode(out[recOut]);
    return { value: pickNumber(text), text, score, ms: Math.round(performance.now() - t0) };
  }

  /* ====================================================== 候选行筛选 / 合并 */

  /* det 有时把「8 . 9」拆成几段、有时把数值和单位连在一起，先做水平合并 */
  function mergeBoxes(boxes) {
    const list = boxes.slice().sort((a, b) => a.x - b.x);
    const out = [];
    for (const b of list) {
      if (b.h < 6 || b.w < 4) continue;
      let merged = false;
      for (const o of out) {
        const overlap = Math.min(o.y + o.h, b.y + b.h) - Math.max(o.y, b.y);
        const hMin = Math.min(o.h, b.h);
        const gap = b.x - (o.x + o.w);
        // 垂直方向重叠超过 60%、水平间距小于一个行高 → 同一行
        if (overlap > hMin * 0.6 && gap < hMin * 0.9 && gap > -hMin * 0.5) {
          const x0 = Math.min(o.x, b.x), y0 = Math.min(o.y, b.y);
          const x1 = Math.max(o.x + o.w, b.x + b.w), y1 = Math.max(o.y + o.h, b.y + b.h);
          o.x = x0; o.y = y0; o.w = x1 - x0; o.h = y1 - y0;
          o.score = Math.max(o.score, b.score);
          merged = true;
          break;
        }
      }
      if (!merged) out.push({ ...b });
    }
    return out;
  }

  /* 数字行天然「又高又宽、不是细长条」，用它排除图标与说明文字 */
  function pickCandidates(boxes, W, H) {
    const minH = Math.max(10, H * 0.05);
    const list = boxes.filter((b) => {
      if (b.h < minH) return false;
      const ar = b.w / b.h;                  // 宽高比
      if (ar < 0.55 || ar > 9) return false;  // 太竖（图标）/ 太扁（横线）
      if (b.w < W * 0.06) return false;       // 太窄，撑不起一个读数
      return true;
    });
    list.sort((a, b) => b.h - a.h);           // 行越高越可能是主读数
    return list;
  }

  /* 反色一份（深底浅字的屏幕，det 会认不出） */
  function invertScratch(sc) {
    const cv = document.createElement("canvas");
    cv.width = sc.w; cv.height = sc.h;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.filter = "invert(1)";
    g.drawImage(sc.cv, 0, 0);
    g.filter = "none";
    return { cv, w: sc.w, h: sc.h };
  }

  /* =========================================================== 主入口
   * 对框内画面：先检测出所有文字行，逐行识别，挑出最像读数的那个
   */
  async function readScreen(src, roiRect, opts) {
    if (!ready) throw new Error("识别引擎尚未初始化");
    const o = opts || {};
    const t0 = performance.now();

    let sc = cropToScratch(src, roiRect);
    let boxes = await detect(sc);
    let cands = pickCandidates(mergeBoxes(boxes), sc.w, sc.h);

    /* 一行都找不到时，可能是反色屏（深底浅字），反色后再试一次 */
    if (!cands.length && o.retryInvert !== false) {
      const inv = invertScratch(sc);
      const boxes2 = await detect(inv);
      const cands2 = pickCandidates(mergeBoxes(boxes2), inv.w, inv.h);
      if (cands2.length) { sc = inv; boxes = boxes2; cands = cands2; }
    }

    const lines = [];
    const maxLines = o.maxLines || 5;
    for (let i = 0; i < cands.length && i < maxLines; i++) {
      const b = cands[i];
      let r = await readLine(sc.cv, b);
      // 单次读不出数字、或置信度偏低时，上下左右放宽一点再试一次
      if (r.value == null || r.score < 0.5) {
        const pad = b.h * 0.12;
        const r2 = await readLine(sc.cv, {
          x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad),
          w: Math.min(sc.w - Math.max(0, b.x - pad), b.w + pad * 2),
          h: Math.min(sc.h - Math.max(0, b.y - pad), b.h + pad * 2),
        });
        if ((r2.value != null && r.value == null) || r2.score > r.score) r = r2;
      }
      lines.push({ ...b, ...r });
    }

    const best = chooseReading(lines);
    return {
      value: best ? best.value : null,
      text: best ? best.text : "",
      score: best ? best.score : 0,
      lines, best, nLines: boxes.length,
      picked: best
        ? { x: roiRect.x + best.x, y: roiRect.y + best.y, w: best.w, h: best.h }
        : null,
      ms: Math.round(performance.now() - t0),
    };
  }

  /* 多行都读到数字时怎么选：
   * 数字位数合法 + 置信度高 + 行大（主读数一定是最醒目的那行）
   */
  function chooseReading(lines) {
    let best = null, bestScore = -1;
    for (const L of lines) {
      if (L.value == null) continue;
      const digits = String(L.value).replace(".", "");
      if (digits.length < 1 || digits.length > 6) continue;
      if (L.score < 0.45) continue;
      const hw = 1 + Math.min(0.5, L.h / 400);   // 字越大加成越多
      const s = L.score * hw;
      if (s > bestScore) { bestScore = s; best = L; }
    }
    return best;
  }

  /* ================================================= 清晰度评估（调试用）
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

  global.OCR = {
    init, detect, readLine, readScreen, sharpness, autoSuggest,
    get ready() { return ready; },
  };
})(window);
