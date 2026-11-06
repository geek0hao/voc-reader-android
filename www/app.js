/* ===========================================================================
 * app.js —— 手机端 VOCs 读数采集
 *
 * ① 上部：摄像头取景 + 可拖动的液晶屏取景框（调试模式实时显示识别结果）
 * ② 中部：随时间变化的浓度曲线
 * ③ 下部：采集记录表 + 导出
 *
 * 识别策略（经实测确定）：
 *   用户只需把蓝框套住【整块液晶屏】，程序自动在框内取【左侧 70%、上 8% 起 74% 高】
 *   作为数字区，再做 3 次轻微缩放的投票。实测在框偏 10% 的情况下仍 49/50 正确。
 *   不这么做的话，框一旦包含右侧的 "ppm" 就会读出 8.92 / 893 这类多位错误。
 * ========================================================================= */
(function () {
  "use strict";

  /* ----------------------------------------------------------- 常量 */
  const INNER = { x0: 0.0, wf: 0.70, y0: 0.08, hf: 0.74 }; // 屏幕 → 数字区
  const LS = { roi: "voc.roi", interval: "voc.interval", autosave: "voc.autosave", facing: "voc.facing" };
  const IMG_CAP_BYTES = 180 * 1024 * 1024;   // 照片占用上限，超了丢最旧的图（数据保留）
  const MAX_ROWS = 400;                      // 表格最多渲染行数

  const $ = (s) => document.querySelector(s);

  /* ----------------------------------------------------------- 状态 */
  const S = {
    running: false,
    debug: false,
    facing: "environment",
    roi: { x: 0.24, y: 0.33, w: 0.52, h: 0.26 },  // 归一化，相对视频帧
    records: [],
    seq: 0,
    bytes: 0,
    stream: null,
    videoW: 0,
    videoH: 0,
    map: { s: 1, ox: 0, oy: 0 },
    fps: 0,
    wakeLock: null,
    drag: null,
    timer: null,
    debugTimer: null,
    nextAt: 0,
    lastValue: null,
    busy: false,
  };

  /* ----------------------------------------------------------- 元素 */
  const el = {
    boot: $("#boot"), bootMsg: $("#bootMsg"), bootBar: $("#bootBar"),
    stage: $("#stage"), preview: $("#preview"),
    pillCam: $("#pillCam"), pillAwake: $("#pillAwake"), pillFps: $("#pillFps"),
    hud: $("#hud"), hudValue: $("#hudValue"), hudTag: $("#hudTag"),
    debugPanel: $("#debugPanel"), cropPreview: $("#cropPreview"),
    dbgValue: $("#dbgValue"), dbgScore: $("#dbgScore"), dbgSharp: $("#dbgSharp"),
    dbgMs: $("#dbgMs"), debugTip: $("#debugTip"),
    btnDebug: $("#btnDebug"), btnAuto: $("#btnAuto"), btnFlip: $("#btnFlip"),
    chart: $("#chart"), chartSub: $("#chartSub"),
    stCur: $("#stCur"), stMax: $("#stMax"), stAvg: $("#stAvg"), stCnt: $("#stCnt"), stBad: $("#stBad"),
    list: $("#list"), listEmpty: $("#listEmpty"), tbody: $("#tbody"),
    btnRun: $("#btnRun"), interval: $("#interval"),
    btnCsv: $("#btnCsv"), btnXlsx: $("#btnXlsx"), btnZip: $("#btnZip"), btnClear: $("#btnClear"),
    autoSave: $("#autoSave"), toast: $("#toast"),
  };

  const ctxP = el.preview.getContext("2d");
  const ctxC = el.cropPreview.getContext("2d");
  const ctxChart = el.chart.getContext("2d");

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.setAttribute("playsinline", "");
  video.style.display = "none";
  document.body.appendChild(video);

  const frameCv = document.createElement("canvas");   // 全分辨率抓帧
  const cropCv = document.createElement("canvas");    // 待保存的屏幕截图

  /* ----------------------------------------------------------- 工具 */
  let toastTimer = null;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms || 2200);
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  function fmtTime(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function fmtStamp(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
           `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function fmtFileStamp(d) {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_` +
           `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ----------------------------------------------------------- 原生桥（APK 内） */
  const CAP = (typeof window !== "undefined" && window.Capacitor) ? window.Capacitor : null;
  const isNative = !!(CAP && typeof CAP.isNativePlatform === "function" && CAP.isNativePlatform());

  function nativeBridge() {
    try { return (isNative && CAP.Plugins && CAP.Plugins.NativeBridge) || null; }
    catch (e) { return null; }
  }

  const MIME_BY_EXT = {
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
  };

  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(fr.error || new Error("读取文件失败"));
      fr.readAsDataURL(blob);
    });
  }

  /* 浏览器走 a[download]；APK 内走原生 MediaStore 写入「下载/VOCMonitor/日期/」 */
  async function saveBlob(blob, name) {
    const nb = nativeBridge();
    if (!nb) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 20000);
      return;
    }
    const ext = (name.split(".").pop() || "").toLowerCase();
    const mime = blob.type || MIME_BY_EXT[ext] || "application/octet-stream";
    try {
      const data = await blobToDataURL(blob);
      const r = await nb.saveFile({ data, name, mime, folder: "VOCMonitor" });
      const kb = blob.size >= 1048576
        ? (blob.size / 1048576).toFixed(1) + " MB"
        : Math.max(1, Math.round(blob.size / 1024)) + " KB";
      toast(`已保存 ${name}（${kb}）`);
      return r;
    } catch (e) {
      console.error(e);
      toast("保存失败：" + (e && e.message || e));
    }
  }

  /* =========================================================== 启动 */
  async function boot() {
    progress(8, "准备识别引擎…");
    try {
      await OCR.init((m) => progress(null, m));
      progress(55, "启动相机…");
      await openCamera(S.facing);
      progress(80, "屏幕常亮…");
      const got = await requestWakeLock();
      el.pillAwake.textContent = got ? "常亮" : "常亮未启用";
      el.pillAwake.className = "pill " + (got ? "on" : "warn");

      restoreSettings();
      startPreview();
      progress(100, "就绪");
      setTimeout(() => el.boot.classList.add("hide"), 320);
      bindUI();
      drawChart();
      registerSW();
    } catch (e) {
      progress(null, "启动失败");
      el.bootMsg.innerHTML =
        "启动失败：" + (e && e.message || e) +
        "<br><br>常见原因：<br>1) 未通过 https 打开（手机要求安全上下文才能用相机）<br>" +
        "2) 没给相机权限<br>3) 识别模型文件缺失";
      el.bootMsg.style.color = "#ef6b6b";
      console.error(e);
    }
  }

  /* 注册离线缓存：首次打开后，即使电脑关机也能从缓存启动 */
  function registerSW() {
    if (isNative) return;                          // APK 资源已在包内，SW 只会带来旧缓存
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:") return;   // 仅 https 下注册
    navigator.serviceWorker.register("sw.js").then(
      () => console.log("离线缓存已启用"),
      (e) => console.warn("离线缓存未启用", e)
    );
  }

  function progress(pct, msg) {    if (msg) el.bootMsg.textContent = msg;
    if (pct != null) el.bootBar.style.width = Math.min(100, pct) + "%";
  }

  function restoreSettings() {
    try {
      const roi = JSON.parse(localStorage.getItem(LS.roi) || "null");
      if (roi && typeof roi.x === "number") S.roi = roi;
      const iv = parseFloat(localStorage.getItem(LS.interval) || "");
      if (iv > 0) el.interval.value = iv;
      el.autoSave.checked = localStorage.getItem(LS.autosave) === "1";
    } catch (e) {}
  }

  /* =========================================================== 相机 */
  async function openCamera(facing) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("浏览器不支持相机接口");
    }
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());

    // 720p 足够：屏幕上的三位数字在画面里只占几百像素，
    // 降到 720p 后单帧内存/耗时更小，存档也更省空间。
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
    video.srcObject = S.stream;
    await video.play();
    await new Promise((r) => {
      if (video.videoWidth) return r();
      video.onloadedmetadata = () => r();
    });
    S.videoW = video.videoWidth;
    S.videoH = video.videoHeight;
    el.pillCam.textContent = (facing === "user" ? "前" : "后") + ` ${S.videoW}×${S.videoH}`;
    el.pillCam.className = "pill on";
  }

  /* =========================================================== 常亮 */
  async function requestWakeLock() {
    const nb = nativeBridge();
    if (nb && nb.keepAwake) {
      try { await nb.keepAwake({ on: true }); return true; } catch (e) { console.warn("原生常亮失败", e); }
    }
    try {
      if ("wakeLock" in navigator) {
        S.wakeLock = await navigator.wakeLock.request("screen");
        S.wakeLock.addEventListener("release", () => { S.wakeLock = null; });
        return true;
      }
    } catch (e) { console.warn("wakeLock 失败", e); }
    return false;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      requestWakeLock().then((ok) => {
        el.pillAwake.textContent = ok ? "常亮" : "常亮未启用";
        el.pillAwake.className = "pill " + (ok ? "on" : "warn");
      });
      if (S.running) scheduleNext(true);
    }
  });

  /* =========================================================== 预览 */
  function startPreview() {
    let last = performance.now(), frames = 0, acc = 0;
    const loop = (now) => {
      requestAnimationFrame(loop);
      const dt = now - last; last = now;
      acc += dt; frames++;
      if (acc > 500) { S.fps = Math.round(frames * 1000 / acc); acc = 0; frames = 0;
        el.pillFps.textContent = S.fps + " fps"; }

      drawPreview();
    };
    requestAnimationFrame(loop);
  }

  function drawPreview() {
    const cw = el.preview.clientWidth, ch = el.preview.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (el.preview.width !== Math.round(cw * dpr) || el.preview.height !== Math.round(ch * dpr)) {
      el.preview.width = Math.round(cw * dpr);
      el.preview.height = Math.round(ch * dpr);
    }
    ctxP.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctxP.clearRect(0, 0, cw, ch);
    if (!S.videoW) return;

    // 等比铺满（cover），保持比例不拉伸
    const s = Math.max(cw / S.videoW, ch / S.videoH);
    const dw = S.videoW * s, dh = S.videoH * s;
    const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    S.map = { s, ox, oy };

    ctxP.drawImage(video, ox, oy, dw, dh);

    // ROI 转屏幕坐标
    const r = roiToScreen();
    // 框外压暗
    ctxP.save();
    ctxP.fillStyle = "rgba(6,10,14,.42)";
    ctxP.fillRect(0, 0, cw, ch);
    ctxP.clearRect(r.x, r.y, r.w, r.h);
    ctxP.drawImage(video, ox + S.roi.x * S.videoW * s, oy + S.roi.y * S.videoH * s,
                   S.roi.w * S.videoW * s, S.roi.h * S.videoH * s,
                   r.x, r.y, r.w, r.h);
    ctxP.restore();

    // 外框
    ctxP.strokeStyle = S.debug ? "#4a9fe0" : "rgba(74,159,224,.65)";
    ctxP.lineWidth = 2;
    ctxP.strokeRect(r.x, r.y, r.w, r.h);

    if (S.debug) {
      // 内区（真正送识别的范围）用绿色虚线标出
      const ir = innerScreen(r);
      ctxP.save();
      ctxP.strokeStyle = "#3ecf8e";
      ctxP.setLineDash([6, 4]);
      ctxP.lineWidth = 1.5;
      ctxP.strokeRect(ir.x, ir.y, ir.w, ir.h);
      ctxP.restore();

      // 四角手柄
      ctxP.fillStyle = "#4a9fe0";
      for (const [hx, hy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
        ctxP.beginPath();
        ctxP.arc(hx, hy, 9, 0, Math.PI * 2);
        ctxP.fill();
        ctxP.strokeStyle = "rgba(255,255,255,.85)";
        ctxP.lineWidth = 2;
        ctxP.stroke();
      }
    }
  }

  function roiToScreen() {
    const { s, ox, oy } = S.map;
    return {
      x: ox + S.roi.x * S.videoW * s,
      y: oy + S.roi.y * S.videoH * s,
      w: S.roi.w * S.videoW * s,
      h: S.roi.h * S.videoH * s,
    };
  }
  function innerOf(r) {
    return {
      x: r.x + r.w * INNER.x0, y: r.y + r.h * INNER.y0,
      w: r.w * INNER.wf, h: r.h * INNER.hf,
    };
  }
  function innerScreen(r) { return innerOf(r); }

  /* 归一化 ROI → 视频帧像素 */
  function roiPx(roi) {
    return {
      x: roi.x * S.videoW, y: roi.y * S.videoH,
      w: roi.w * S.videoW, h: roi.h * S.videoH,
    };
  }

  /* =========================================================== 取景框拖动 */
  function bindStagePointer() {
    const pv = el.preview;

    const toClient = (e) => {
      const t = e.touches ? e.touches[0] : e;
      return { x: t.clientX, y: t.clientY };
    };

    pv.addEventListener("pointerdown", (e) => {
      if (!S.debug) return;
      pv.setPointerCapture(e.pointerId);
      const box = pv.getBoundingClientRect();
      const px = e.clientX - box.left, py = e.clientY - box.top;
      const r = roiToScreen();
      const corners = [
        ["nw", r.x, r.y], ["ne", r.x + r.w, r.y],
        ["sw", r.x, r.y + r.h], ["se", r.x + r.w, r.y + r.h],
      ];
      const hit = corners.find(([, cx, cy]) => Math.hypot(px - cx, py - cy) < 34);
      if (hit) {
        S.drag = { mode: hit[0] };
      } else if (px > r.x && px < r.x + r.w && py > r.y && py < r.y + r.h) {
        S.drag = { mode: "move", gx: px - r.x, gy: py - r.y, ow: r.w, oh: r.h };
      } else {
        S.drag = { mode: "new", ax: px, ay: py };
      }
    });

    pv.addEventListener("pointermove", (e) => {
      if (!S.drag || !S.debug) return;
      const box = pv.getBoundingClientRect();
      const px = e.clientX - box.left, py = e.clientY - box.top;
      const { s, ox, oy } = S.map;
      const nx = clamp((px - ox) / (S.videoW * s), 0, 1);
      const ny = clamp((py - oy) / (S.videoH * s), 0, 1);
      const r = roiToScreen();
      const nRoi = { ...S.roi };

      if (S.drag.mode === "move") {
        const nw = S.drag.ow / (S.videoW * s);
        const nh = S.drag.oh / (S.videoH * s);
        nRoi.x = clamp(nx - S.drag.gx / (S.videoW * s), 0, 1 - nw);
        nRoi.y = clamp(ny - S.drag.gy / (S.videoH * s), 0, 1 - nh);
        nRoi.w = nw; nRoi.h = nh;
      } else if (S.drag.mode === "new") {
        const ax = (S.drag.ax - ox) / (S.videoW * s);
        const ay = (S.drag.ay - oy) / (S.videoH * s);
        nRoi.x = clamp(Math.min(ax, nx), 0, 1);
        nRoi.y = clamp(Math.min(ay, ny), 0, 1);
        nRoi.w = clamp(Math.abs(nx - ax), 0.06, 1);
        nRoi.h = clamp(Math.abs(ny - ay), 0.05, 1);
      } else {
        // 拖角：固定对角
        let x0 = S.roi.x, y0 = S.roi.y, x1 = S.roi.x + S.roi.w, y1 = S.roi.y + S.roi.h;
        if (S.drag.mode.includes("n")) y0 = Math.min(ny, y1 - 0.04);
        if (S.drag.mode.includes("s")) y1 = Math.max(ny, y0 + 0.04);
        if (S.drag.mode.includes("w")) x0 = Math.min(nx, x1 - 0.05);
        if (S.drag.mode.includes("e")) x1 = Math.max(nx, x0 + 0.05);
        nRoi.x = clamp(x0, 0, 1); nRoi.y = clamp(y0, 0, 1);
        nRoi.w = clamp(x1 - x0, 0.05, 1); nRoi.h = clamp(y1 - y0, 0.04, 1);
      }
      S.roi = nRoi;
    });

    const end = () => {
      if (S.drag) {
        S.drag = null;
        try { localStorage.setItem(LS.roi, JSON.stringify(S.roi)); } catch (e) {}
      }
    };
    pv.addEventListener("pointerup", end);
    pv.addEventListener("pointercancel", end);
  }

  /* =========================================================== 抓帧 */
  function grabFrame() {
    if (!S.videoW) return null;
    if (frameCv.width !== S.videoW || frameCv.height !== S.videoH) {
      frameCv.width = S.videoW;
      frameCv.height = S.videoH;
    }
    frameCv.getContext("2d").drawImage(video, 0, 0, S.videoW, S.videoH);
    return frameCv;
  }

  /* =========================================================== 识别 */
  async function recognizeFrame(src) {
    const outer = roiPx(S.roi);
    const inner = innerOf(outer);
    const r = await OCR.readVote(src, inner);
    let flag = "";
    if (r.value == null) flag = "未识别";
    else if (r.agree < 2) flag = "不一致";
    else if (r.score < 0.5) flag = "低置信";
    return { ...r, flag, outer, inner };
  }

  /* =========================================================== 时间戳烧录 */
  function stampImage(srcCanvas, rect, when, value, flag, seq) {
    const w = Math.round(rect.w), h = Math.round(rect.h);
    cropCv.width = w; cropCv.height = h;
    const g = cropCv.getContext("2d");
    g.drawImage(srcCanvas, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);

    const fs = Math.max(12, Math.round(w / 26));
    const barH = Math.round(fs * 1.75);
    // 顶部时间戳
    g.fillStyle = "rgba(0,0,0,.62)";
    g.fillRect(0, 0, w, barH);
    g.fillStyle = "#fff";
    g.font = `600 ${fs}px -apple-system, "PingFang SC", sans-serif`;
    g.textBaseline = "middle";
    g.fillText(`${fmtStamp(when)}  #${String(seq).padStart(3, "0")}`, Math.round(fs * 0.6), Math.round(barH / 2));

    // 底部读数
    const txt = value != null ? `${value} ppm` : "未识别";
    const txt2 = flag ? `  [${flag}]` : "";
    g.fillStyle = "rgba(0,0,0,.62)";
    g.fillRect(0, h - barH, w, barH);
    g.fillStyle = flag ? "#f0b429" : "#fff";
    g.font = `700 ${Math.round(fs * 1.05)}px -apple-system, "PingFang SC", sans-serif`;
    g.fillText(txt + txt2, Math.round(fs * 0.6), h - Math.round(barH / 2));
    return cropCv;
  }

  function canvasToBlob(cv, q) {
    return new Promise((res) => cv.toBlob((b) => res(b), "image/jpeg", q || 0.9));
  }

  /* =========================================================== 采集一次 */
  async function captureOnce() {
    if (S.busy) return;
    S.busy = true;
    try {
      const src = grabFrame();
      if (!src) { toast("相机未就绪"); return; }

      const when = new Date();
      const r = await recognizeFrame(src);
      S.seq += 1;
      const seq = S.seq;

      const cv = stampImage(src, r.outer, when, r.value, r.flag, seq);
      const blob = await canvasToBlob(cv, 0.85);

      const rec = {
        id: seq, t: when.getTime(), value: r.value, score: r.score,
        agree: r.agree, flag: r.flag, blob, bytes: blob ? blob.size : 0,
        name: `VOC_${fmtFileStamp(when)}_${String(seq).padStart(3, "0")}.jpg`,
      };
      S.records.push(rec);
      S.bytes += rec.bytes || 0;
      trimImages();

      el.hudValue.textContent = r.value != null ? r.value : "--";
      el.hudTag.textContent = r.flag || "";
      el.hudTag.className = "hud-tag" + (r.flag ? " show" : "");

      renderChart();
      renderStats();
      renderRows();
      if (el.autoSave.checked && blob) saveBlob(blob, rec.name);
    } catch (e) {
      console.error(e);
      toast("采集失败：" + (e.message || e));
    } finally {
      S.busy = false;
    }
  }

  /* 图片占内存，超上限就丢最早的图（记录仍然保留） */
  function trimImages() {
    while (S.bytes > IMG_CAP_BYTES && S.records.length) {
      const r = S.records.find((x) => x.blob);
      if (!r) break;
      S.bytes -= r.bytes || 0;
      r.blob = null;
      r.dropped = true;
    }
  }

  /* =========================================================== 定时排程 */
  function scheduleNext(reset) {
    clearTimeout(S.timer);
    if (!S.running) return;
    const iv = Math.max(0.5, parseFloat(el.interval.value) || 5) * 1000;
    if (reset || !S.nextAt) S.nextAt = Date.now() + iv;
    const wait = Math.max(0, S.nextAt - Date.now());
    S.timer = setTimeout(async () => {
      if (!S.running) return;
      await captureOnce();
      S.nextAt += iv;
      // 落后太多（例如切后台）就重置，避免补拍一串
      if (S.nextAt < Date.now() - iv) S.nextAt = Date.now() + iv;
      scheduleNext(false);
    }, wait);
  }

  function startRun() {
    S.running = true;
    if (S.debug) toggleDebug(false);
    el.btnRun.textContent = "停止采集";
    el.btnRun.classList.add("running");
    S.nextAt = Date.now();      // 立即拍第一张
    scheduleNext(false);
    toast("开始采集，每 " + el.interval.value + " 秒一张");
  }

  function stopRun() {
    S.running = false;
    clearTimeout(S.timer);
    el.btnRun.textContent = "开始采集";
    el.btnRun.classList.remove("running");
    toast("已停止");
  }

  /* =========================================================== 调试模式 */
  function toggleDebug(force) {
    S.debug = force != null ? force : !S.debug;
    el.btnDebug.classList.toggle("active", S.debug);
    el.debugPanel.classList.toggle("show", S.debug);
    if (S.debug) {
      if (S.running) stopRun();
      debugLoop();
    } else {
      clearTimeout(S.debugTimer);
    }
    drawPreview();
  }

  async function debugLoop() {
    if (!S.debug) return;
    try {
      const src = grabFrame();
      if (src) {
        const r = await recognizeFrame(src);

        // 裁剪预览
        const inner = innerOf(roiPx(S.roi));
        const iw = el.cropPreview.clientWidth * 2, ih = el.cropPreview.clientHeight * 2;
        if (el.cropPreview.width !== iw) { el.cropPreview.width = iw; el.cropPreview.height = ih; }
        ctxC.fillStyle = "#0b1118";
        ctxC.fillRect(0, 0, iw, ih);
        ctxC.drawImage(src, inner.x, inner.y, inner.w, inner.h, 0, 0, iw, ih);

        const sharp = Math.round(OCR.sharpness(src, inner));
        el.dbgValue.textContent = r.value != null ? r.value : "--";
        el.dbgScore.textContent = "置信度 " + r.score.toFixed(2) + "　一致性 " + r.agree + "/3";
        el.dbgSharp.textContent = "清晰度 " + sharp;
        el.dbgMs.textContent = "耗时 " + r.runs.reduce((a, b) => a + b.ms, 0) + " ms";

        el.hudValue.textContent = r.value != null ? r.value : "--";
        el.hudTag.textContent = r.flag || "";
        el.hudTag.className = "hud-tag" + (r.flag ? " show" : "");

        let tip;
        if (r.value == null) tip = "框内没读到数字：把蓝框套住整块液晶屏，避开反光";
        else if (sharp < 80) tip = "画面偏模糊：靠近一点，或点一下画面让手机重新对焦";
        else if (r.agree < 2) tip = "读数不稳定：稳住手机，避开屏幕反光";
        else if (r.flag) tip = "结果异常：" + r.flag + "，试着把框套得更正一些";
        else tip = "读数稳定，可以退出调试并开始采集";
        el.debugTip.textContent = tip;
      }
    } catch (e) { console.warn(e); }
    S.debugTimer = setTimeout(debugLoop, 380);
  }

  /* =========================================================== 曲线 */
  function renderChart() { drawChart(); }

  function drawChart() {
    const cv = el.chart;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    }
    const g = ctxChart;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);

    const pad = { l: 34, r: 10, t: 8, b: 18 };
    const iw = cw - pad.l - pad.r, ih = ch - pad.t - pad.b;
    const pts = S.records.filter((r) => r.value != null).map((r) => ({ t: r.t, v: parseFloat(r.value), flag: r.flag }));

    const iv = Math.max(0.5, parseFloat(el.interval.value) || 5) * 1000;

    if (!pts.length) {
      g.fillStyle = "#5b6875"; g.font = "11px -apple-system, sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(S.records.length ? "已采集，但暂无有效读数" : "等待采集…", cw / 2, ch / 2);
      el.chartSub.textContent = S.running ? "采集中" : "等待采集";
      return;
    }

    // 纵轴取整：先把「单格」取成好看的数字，再乘格数，刻度才会是 0/5/10/15 这种
    const niceNum = (v) => {
      if (!(v > 0)) return 1;
      const base = Math.pow(10, Math.floor(Math.log10(v)));
      const n = v / base;
      const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
      return m * base;
    };
    const vmax = Math.max(...pts.map((p) => p.v));
    const ticks = 3;
    const step = niceNum(vmax * 1.12 / ticks);
    const top = step * ticks;

    g.font = "10px -apple-system, sans-serif";
    g.textAlign = "right"; g.textBaseline = "middle";
    for (let i = 0; i <= ticks; i++) {
      const y = pad.t + ih - ih * i / ticks;
      g.strokeStyle = i === 0 ? "#3a4754" : "#232f3a";
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(pad.l + iw, y); g.stroke();
      g.fillStyle = "#7d8b9a";
      const v = step * i;
      g.fillText(v >= 100 ? v.toFixed(0) : (step % 1 ? v.toFixed(1) : v.toFixed(0)), pad.l - 5, y);
    }

    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const span = Math.max(t1 - t0, 1);
    const X = (t) => pad.l + (t - t0) / span * iw;
    const Y = (v) => pad.t + ih - Math.min(v / top, 1) * ih;

    // 漏采竖带
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t - pts[i - 1].t > iv * 2.5) {
        g.fillStyle = "rgba(239,107,107,.10)";
        g.fillRect(X(pts[i - 1].t), pad.t, X(pts[i].t) - X(pts[i - 1].t), ih);
      }
    }

    // 折线
    g.strokeStyle = "#4a9fe0"; g.lineWidth = 1.8; g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v))));
    g.stroke();

    // 点：待核对画红叉
    pts.forEach((p) => {
      const x = X(p.t), y = Y(p.v);
      if (p.flag) {
        g.strokeStyle = "#f0b429"; g.lineWidth = 1.8;
        g.beginPath(); g.moveTo(x - 3, y - 3); g.lineTo(x + 3, y + 3);
        g.moveTo(x + 3, y - 3); g.lineTo(x - 3, y + 3); g.stroke();
      } else {
        g.fillStyle = "#4a9fe0";
        g.beginPath(); g.arc(x, y, 2.2, 0, Math.PI * 2); g.fill();
      }
    });

    // 最新值
    const last = pts[pts.length - 1];
    g.fillStyle = "#cfe8fb"; g.font = "600 10.5px -apple-system, sans-serif";
    g.textBaseline = "middle";
    const nearRight = X(last.t) > pad.l + iw - 30;
    g.textAlign = nearRight ? "right" : "left";
    g.fillText(last.v.toFixed(1), nearRight ? X(last.t) - 6 : X(last.t) + 6, Y(last.v) - 9);

    // 时间刻度
    g.fillStyle = "#7d8b9a"; g.font = "10px -apple-system, sans-serif"; g.textBaseline = "top";
    const spanMin = (pts[pts.length - 1].t - pts[0].t) / 60000;
    const fmtAxis = spanMin < 5 ? (d) => fmtTime(d) : (d) => fmtTime(d).slice(0, 5);
    const n = Math.min(4, pts.length);
    for (let i = 0; i < n; i++) {
      const p = pts[Math.round(i * (pts.length - 1) / Math.max(n - 1, 1))];
      const d = new Date(p.t);
      const x = X(p.t);
      g.textAlign = x < pad.l + 18 ? "left" : (x > pad.l + iw - 18 ? "right" : "center");
      g.fillText(fmtAxis(d), x, pad.t + ih + 4);
    }

    el.chartSub.textContent = `${pts.length} 点 · 最大 ${vmax.toFixed(1)} ppm`;
  }

  /* =========================================================== 统计 & 列表 */
  function renderStats() {
    const vals = S.records.filter((r) => r.value != null);
    const good = vals.filter((r) => !r.flag);
    el.stCur.textContent = vals.length ? vals[vals.length - 1].value : "--";
    el.stMax.textContent = good.length ? Math.max(...good.map((r) => parseFloat(r.value))).toFixed(1) : "--";
    el.stAvg.textContent = good.length
      ? (good.reduce((a, r) => a + parseFloat(r.value), 0) / good.length).toFixed(1) : "--";
    el.stCnt.textContent = S.records.length;
    el.stBad.textContent = vals.filter((r) => r.flag).length +
      S.records.filter((r) => r.value == null).length;
  }

  function renderRows() {
    el.listEmpty.style.display = S.records.length ? "none" : "block";
    const rows = S.records.slice(-MAX_ROWS).reverse();
    el.tbody.innerHTML = rows.map((r) => {
      const d = new Date(r.t);
      const cls = r.flag ? "bad" : "";
      const tag = r.flag
        ? `<span class="tag bad">${r.flag}</span>`
        : `<span class="tag ok">正常</span>`;
      const btn = r.blob
        ? `<button class="savebtn" data-id="${r.id}">存图</button>`
        : `<span class="dim" style="font-size:10px">图已释放</span>`;
      return `<tr class="${cls}"><td>${fmtTime(d)}</td><td class="v">${r.value != null ? r.value : "--"}</td><td>${tag}</td><td>${btn}</td></tr>`;
    }).join("");
  }

  el.tbody.addEventListener("click", (e) => {
    const b = e.target.closest(".savebtn");
    if (!b) return;
    const rec = S.records.find((r) => r.id === +b.dataset.id);
    if (rec && rec.blob) saveBlob(rec.blob, rec.name);
  });

  /* =========================================================== 导出 */
  function baseName(prefix) {
    const d = new Date();
    return `${prefix}_${fmtFileStamp(d)}`;
  }

  function exportCSV() {
    if (!S.records.length) return toast("还没有数据");
    const lines = ["序号,时间,读数(ppm),置信度,一致性,状态,图片文件"];
    for (const r of S.records) {
      const d = new Date(r.t);
      lines.push([
        r.id, `${fmtStamp(d)}`, r.value != null ? r.value : "",
        r.score ? r.score.toFixed(3) : "", r.agree || "", r.flag || "正常", r.name,
      ].join(","));
    }
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    saveBlob(blob, baseName("VOC数据") + ".csv");
    toast("CSV 已导出到手机下载目录");
  }

  /* ---- 极简 ZIP（仅存储不压缩），足够打 Excel 与照片包 ---- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
    const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

    for (const f of files) {
      const nameBuf = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = new Uint8Array([
        0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(nameBuf.length), ...u16(0), ...nameBuf,
      ]);
      chunks.push(local, data);
      central.push(new Uint8Array([
        0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(nameBuf.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(offset), ...nameBuf,
      ]));
      offset += local.length + data.length;
    }
    let cdSize = 0;
    for (const c of central) { chunks.push(c); cdSize += c.length; }
    chunks.push(new Uint8Array([
      0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0),
      ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0),
    ]));
    return new Blob(chunks, { type: "application/octet-stream" });
  }

  function xmlEsc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  const colName = (i) => String.fromCharCode(65 + i);

  function exportXLSX() {
    if (!S.records.length) return toast("还没有数据");
    const enc = new TextEncoder();
    const header = ["序号", "时间", "读数(ppm)", "置信度", "一致性", "状态", "图片文件"];
    const rows = [header];
    for (const r of S.records) {
      rows.push([
        r.id, fmtStamp(new Date(r.t)), r.value != null ? Number(r.value) : "",
        r.score ? +r.score.toFixed(3) : "", r.agree || 0, r.flag || "正常", r.name,
      ]);
    }
    let sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    rows.forEach((row, ri) => {
      sheet += `<row r="${ri + 1}">`;
      row.forEach((cell, ci) => {
        const ref = colName(ci) + (ri + 1);
        if (typeof cell === "number" && isFinite(cell)) {
          sheet += `<c r="${ref}"><v>${cell}</v></c>`;
        } else if (cell === "" || cell == null) {
          // 空
        } else {
          sheet += `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(cell)}</t></is></c>`;
        }
      });
      sheet += "</row>";
    });
    sheet += "</sheetData></worksheet>";

    const files = [
      { name: "[Content_Types].xml", data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>') },
      { name: "_rels/.rels", data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>') },
      { name: "xl/workbook.xml", data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="采集数据" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>') },
      { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) },
    ];
    saveBlob(zipStore(files), baseName("VOC数据") + ".xlsx");
    toast("Excel 已导出到手机下载目录");
  }

  async function exportZip() {
    const withBlob = S.records.filter((r) => r.blob);
    if (!withBlob.length) return toast("没有可打包的照片");
    toast(`正在打包 ${withBlob.length} 张照片…`);
    const files = [];
    for (const r of withBlob) {
      const buf = new Uint8Array(await r.blob.arrayBuffer());
      files.push({ name: r.name, data: buf });
    }
    saveBlob(zipStore(files), baseName("VOC照片") + ".zip");
    toast(`已打包 ${files.length} 张照片`);
  }

  /* =========================================================== UI 绑定 */
  function bindUI() {
    bindStagePointer();

    el.btnRun.addEventListener("click", () => (S.running ? stopRun() : startRun()));
    el.btnDebug.addEventListener("click", () => toggleDebug());
    el.btnFlip.addEventListener("click", async () => {
      S.facing = S.facing === "environment" ? "user" : "environment";
      try {
        await openCamera(S.facing);
        localStorage.setItem(LS.facing, S.facing);
        toast("已切到" + (S.facing === "user" ? "前置" : "后置") + "镜头");
      } catch (e) { toast("切换失败：" + e.message); }
    });

    el.btnAuto.addEventListener("click", () => {
      const src = grabFrame();
      if (!src) return toast("相机未就绪");
      const s = OCR.autoSuggest(src, S.videoW, S.videoH);
      if (s) {
        // 自动建议偏大，向内收一点更贴近液晶屏
        S.roi = { x: s.x + s.w * 0.06, y: s.y + s.h * 0.10, w: s.w * 0.88, h: s.h * 0.80 };
        try { localStorage.setItem(LS.roi, JSON.stringify(S.roi)); } catch (e) {}
        toast("已按画面亮区给出建议框，可在调试模式微调");
        if (!S.debug) toggleDebug(true);
      } else {
        toast("没找到明显亮屏，请手动拖动蓝框");
        if (!S.debug) toggleDebug(true);
      }
    });

    el.interval.addEventListener("change", () => {
      const v = Math.max(0.5, parseFloat(el.interval.value) || 5);
      el.interval.value = v;
      localStorage.setItem(LS.interval, String(v));
      if (S.running) scheduleNext(true);
      drawChart();
    });

    el.autoSave.addEventListener("change", () => {
      localStorage.setItem(LS.autosave, el.autoSave.checked ? "1" : "0");
      if (el.autoSave.checked) toast("开启后每张都会下载，注意浏览器下载提示");
    });

    el.btnCsv.addEventListener("click", exportCSV);
    el.btnXlsx.addEventListener("click", exportXLSX);
    el.btnZip.addEventListener("click", exportZip);
    el.btnClear.addEventListener("click", () => {
      if (!S.records.length) return toast("没有数据");
      if (!confirm("清空所有采集记录和已缓存照片？导出后请先保存。")) return;
      S.records = []; S.seq = 0; S.bytes = 0;
      el.hudValue.textContent = "--"; el.hudTag.className = "hud-tag";
      renderStats(); renderRows(); drawChart();
      toast("已清空");
    });

    window.addEventListener("resize", () => { drawChart(); });

    // 首次进入：给个引导
    if (!localStorage.getItem(LS.roi)) {
      setTimeout(() => toast("先点「调试」，把蓝框套住整块液晶屏", 3600), 900);
    }
  }

  /* =========================================================== 启动 */
  boot();
})();
