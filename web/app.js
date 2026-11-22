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
  const LS = {
    roi: "voc.roi", interval: "voc.interval", autosave: "voc.autosave", facing: "voc.facing",
    tpl: "voc.tpl", ac: "voc.autocorrect",
    meta: "voc.meta", unit: "voc.unit", limit: "voc.limit", alarm: "voc.alarm",
  };

  /* 照片目录沿用 VOCMonitor —— 改名只换显示名，不动已落盘的路径，
   * 否则升级后历史照片会「找不到」，用户以为数据丢了。 */
  const FOLDER = "VOCMonitor";

  /* 单位：内部一律把读数归一成 ppm 再存、再算。
   * 显示和导出时才按 unitOut 换算，所以中途改单位不会污染历史记录的数值。 */
  const UNIT_LABEL = { ppm: "ppm", ppb: "ppb", mgm3: "mg/m³" };
  const UNIT_DEC = { ppm: 1, ppb: 0, mgm3: 2 };     // 各单位的常用小数位
  const MG_FACTOR_DEFAULT = 2.33;                    // 异丁烯：1 ppm ≈ 2.33 mg/m³

  /* 自动校正模块（autocorrect.js）。缺失时整条链路自动降级为“不校正”，不影响采集。 */
  const AC = (typeof window !== "undefined" && window.AutoCorrect) || null;
  const VERIFY_TIMES = (AC && AC.DEFAULT_OPTS.verifyTimes) || 2;

  /* 数字区相对液晶屏的默认比例。
   * 实测 p1/p3/p5 三张正拍：数字行位于屏内 x 0.32~0.71、y 0.13~0.59、行高占 0.40，
   * 这里四周各留余量，既容得下 4 位读数，也不至于切边。 */
  const TPL_DEFAULT = { x0: 0.22, y0: 0.05, wf: 0.60, hf: 0.63 };
  /* 照片改为“边采边落盘”，内存里只留排队中的一两张，所以上限可以压得很小。
   * 旧版留 180MB 在内存里等导出，30 分钟 1 秒一张就直接把 App 撑爆了。 */
  const IMG_CAP_BYTES = 24 * 1024 * 1024;
  const MAX_ROWS = 400;                      // 表格最多渲染行数

  /* 单次过桥（JS → 原生）的硬上限。base64 会再膨胀 4/3，且原生侧还要再解码一份，
   * 实测超过 10MB 就很容易把 WebView/Java 堆吃穿直接闪退，所以宁可在前端先挡住。 */
  const BRIDGE_MAX_BYTES = 10 * 1024 * 1024;
  const SAVE_QUEUE_MAX = 40;                 // 存图队列上限，积压说明卡了，直接放弃这一条
  const SESSION_KEY = "voc.session.v1";      // 崩溃后的数据兜底快照

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
    lastLines: [],       // 最近一次 det 检测到的文字行（画在预览上）
    lastPick: null,      // 最近一次选中的数值行
    detBusy: false,
    detAt: 0,
    tpl: null,           // 数字区相对屏框的比例；非空即“模板已锁定”
    ac: AC ? AC.createState() : null,   // 已采纳读数的短历史，用于判断变化率
    acOn: true,          // 自动校正开关（可在界面上关掉）
    lastGrabT: 0,        // 上一次抓帧时 video.currentTime，用于判断是否是新帧
    savedCount: 0,       // 已确认写入手机的照片数
    saveFail: 0,         // 存图失败数
    exported: false,     // 本次会话是否已成功导出过表格
    sessionDate: "",     // 采集开始日期，用于照片打包只取当天目录

    /* —— 采集元数据：写进导出表格、文件名和趋势图，缺了这组信息，
     * 一周后就说不清这组数字采自哪里、谁采的。 —— */
    meta: { scene: "", point: "", sample: "", device: "", operator: "", temp: "", hum: "", note: "" },
    unitIn: "ppm",       // 仪器屏幕上显示的单位
    unitOut: "ppm",      // 界面/导出用的单位
    factor: MG_FACTOR_DEFAULT,   // 1 ppm = factor mg/m³
    limitHiP: null,      // 上限，存 ppm 基准值，改单位不会变义
    limitLoP: null,      // 下限，null = 不限
    alarmOn: true,       // 超限震动/提示音
    lastAlarmAt: 0,      // 报警节流，避免连续超标时每秒响一次
  };

  /* ----------------------------------------------------------- 元素 */
  const el = {
    boot: $("#boot"), bootMsg: $("#bootMsg"), bootBar: $("#bootBar"),
    stage: $("#stage"), preview: $("#preview"),
    pillCam: $("#pillCam"), pillAwake: $("#pillAwake"), pillFps: $("#pillFps"),
    hud: $("#hud"), hudValue: $("#hudValue"), hudTag: $("#hudTag"), hudUnit: $("#hudUnit"),
    debugPanel: $("#debugPanel"), cropPreview: $("#cropPreview"),
    dbgValue: $("#dbgValue"), dbgScore: $("#dbgScore"), dbgSharp: $("#dbgSharp"),
    dbgMs: $("#dbgMs"), debugTip: $("#debugTip"),
    btnDebug: $("#btnDebug"), btnAuto: $("#btnAuto"), btnFlip: $("#btnFlip"),
    btnCalib: $("#btnCalib"), btnTplReset: $("#btnTplReset"), tplState: $("#tplState"),
    chart: $("#chart"), chartSub: $("#chartSub"), chartwrap: $("#chartwrap"),
    stCur: $("#stCur"), stMax: $("#stMax"), stAvg: $("#stAvg"), stCnt: $("#stCnt"),
    stBad: $("#stBad"), stSaved: $("#stSaved"), stOver: $("#stOver"),
    list: $("#list"), listEmpty: $("#listEmpty"), tbody: $("#tbody"),
    btnRun: $("#btnRun"), interval: $("#interval"),
    btnCsv: $("#btnCsv"), btnXlsx: $("#btnXlsx"), btnZip: $("#btnZip"), btnClear: $("#btnClear"),
    btnChart: $("#btnChart"), btnArchive: $("#btnArchive"),
    autoSave: $("#autoSave"), autoCorrect: $("#autoCorrect"), toast: $("#toast"),
    /* 设置面板 */
    btnSet: $("#btnSet"), sheet: $("#sheet"), sheetMask: $("#sheetMask"), sheetClose: $("#sheetClose"),
    mScene: $("#mScene"), mPoint: $("#mPoint"), mSample: $("#mSample"), mDevice: $("#mDevice"),
    mOperator: $("#mOperator"), mTemp: $("#mTemp"), mHum: $("#mHum"), mNote: $("#mNote"),
    unitIn: $("#unitIn"), unitOut: $("#unitOut"), factor: $("#factor"), factorRow: $("#factorRow"),
    unitHint: $("#unitHint"), limitHi: $("#limitHi"), limitLo: $("#limitLo"), alarmOn: $("#alarmOn"),
    chartTitle: $("#chartTitle"),
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

  /* ----------------------------------------------------------- 超限报警
   * 盯着屏幕半小时，人一定会走神；超了要当场知道，而不是事后翻表。
   * 震动 + 一声短提示音，节流 8 秒——连续超标时不会每秒都响。 */
  let audioCtx = null;
  function beep() {
    try {
      const ACtx = window.AudioContext || window.webkitAudioContext;
      if (!ACtx) return;
      audioCtx = audioCtx || new ACtx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "square";
      o.frequency.setValueAtTime(880, t);
      o.frequency.setValueAtTime(660, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.10, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.26);
    } catch (e) { /* 音频被系统挡了就只震动 */ }
  }
  function fireAlarm(over) {
    if (!S.alarmOn) return;
    try { if (navigator.vibrate) navigator.vibrate([140, 90, 140]); } catch (e) {}
    beep();
    const now = Date.now();
    if (now - S.lastAlarmAt > 8000) {
      S.lastAlarmAt = now;
      toast(over > 0 ? "读数超上限" : "读数低于下限", 1600);
    }
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
  function fmtDateOnly(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ----------------------------------------------------------- 单位换算
   * 基准是 ppm。记录里存三样：v（屏幕上看到的原值）、u（当时的单位）、p（ppm 基准值）。
   * 之后无论怎么改单位，p 都不动，显示/导出时才乘 outK()。 */
  function toBaseVal(v, unit) {
    const n = typeof v === "number" ? v : parseFloat(v);
    if (!isFinite(n)) return null;
    if (unit === "ppb") return n * 0.001;
    if (unit === "mgm3") return n / (S.factor > 0 ? S.factor : MG_FACTOR_DEFAULT);
    return n;
  }
  function outK() {
    if (S.unitOut === "ppb") return 1000;
    if (S.unitOut === "mgm3") return S.factor > 0 ? S.factor : MG_FACTOR_DEFAULT;
    return 1;
  }
  function unitTxt() { return UNIT_LABEL[S.unitOut] || "ppm"; }
  /* 记录 → ppm 基准值（老记录没有 p，按记录自带的单位补算） */
  function baseOf(rec) {
    if (!rec || rec.value == null) return null;
    if (rec.p != null && isFinite(rec.p)) return rec.p;
    return toBaseVal(rec.value, rec.u || "ppm");
  }
  /* 记录 → 当前输出单位下的值 */
  function outOf(rec) {
    const b = baseOf(rec);
    return b == null ? null : b * outK();
  }
  /* 已是输出单位的值 → 显示文本 */
  function fmtOut(v, dec) {
    if (v == null || !isFinite(v)) return "--";
    const d = dec != null ? dec : (UNIT_DEC[S.unitOut] != null ? UNIT_DEC[S.unitOut] : 1);
    return v.toFixed(d);
  }
  /* ppm 基准值 → 当前输出单位的显示文本 */
  function fmtBase(p, dec) {
    if (p == null || !isFinite(p)) return "--";
    return fmtOut(p * outK(), dec);
  }

  /* 超限判定：上下限都以 ppm 基准存，比较时也换成基准，改显示单位不会让判定漂移。
   * 返回 1 = 超上限，-1 = 低于下限，0 = 正常 */
  function overOf(rec) {
    const b = baseOf(rec);
    if (b == null) return 0;
    if (S.limitHiP != null && isFinite(S.limitHiP) && b > S.limitHiP) return 1;
    if (S.limitLoP != null && isFinite(S.limitLoP) && b < S.limitLoP) return -1;
    return 0;
  }

  /* 文件名里不能出现的字符，顺手截断，免得手机文件系统报错 */
  function cleanName(s, max) {
    return String(s || "").replace(/[\\/:*?"<>|\r\n\t]/g, "").trim().slice(0, max || 24);
  }
  /* 场景名（图表标题、归档名用），没填就用默认软件名 */
  function sceneName() { return cleanName(S.meta.scene, 16) || "屏读采集"; }
  /* 曲线区/趋势图的标题：填了场景就带上，没填就朴素一点 */
  function chartTitleText() {
    const s = cleanName(S.meta.scene, 16);
    return s ? `${s} 读数趋势` : "读数趋势";
  }

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

  /* 浏览器走 a[download]；APK 内走原生 MediaStore 写入「下载/VOCMonitor/日期/」。
   * 返回 { ok, path | error }，调用方据此决定提示内容——成功提示绝不在真正写完之前弹。 */
  async function saveBlob(blob, name, opts) {
    const quiet = !!(opts && opts.quiet);
    const nb = nativeBridge();
    if (!nb) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 20000);
      return { ok: true, path: name };
    }
    if (blob.size > BRIDGE_MAX_BYTES) {
      const msg = `文件 ${fmtSize(blob.size)} 超过 ${fmtSize(BRIDGE_MAX_BYTES)} 上限，已拒绝过桥（防止闪退）`;
      if (!quiet) toast(msg);
      return { ok: false, error: msg };
    }
    const ext = (name.split(".").pop() || "").toLowerCase();
    const mime = blob.type || MIME_BY_EXT[ext] || "application/octet-stream";
    try {
      const data = await blobToDataURL(blob);
      const r = await nb.saveFile({ data, name, mime, folder: FOLDER });
      if (!quiet) toast(`已保存 ${name}（${fmtSize(blob.size)}）`);
      return { ok: true, path: (r && r.path) || name };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.error("保存失败", name, e);
      if (!quiet) toast("保存失败：" + msg);
      return { ok: false, error: msg };
    }
  }

  function fmtSize(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }

  /* ----------------------------------------------------------- 存图队列
   * 每帧一张、严格串行写入：既不会并发抢内存，也不会出现几百个桥调用堆在队列里。
   * 写完立刻把 blob 从记录里摘掉，内存占用保持恒定（≈ 一两张图）。 */
  const SaveQ = {
    q: [],
    busy: false,
    push(rec, blob) {
      if (this.q.length >= SAVE_QUEUE_MAX) {
        rec.photoErr = "存图积压";
        S.saveFail += 1;
        updateSaveStat();
        return false;
      }
      this.q.push({ rec, blob });
      this.pump();
      return true;
    },
    async pump() {
      if (this.busy) return;
      this.busy = true;
      try {
        while (this.q.length) {
          const job = this.q.shift();
          let r = await saveBlob(job.blob, job.rec.name, { quiet: true });
          if (!r.ok) {                     // 相机/存储偶发抽风，隔 250ms 再来一次
            await new Promise((res) => setTimeout(res, 250));
            r = await saveBlob(job.blob, job.rec.name, { quiet: true });
          }
          if (r.ok) {
            job.rec.saved = 1;
            job.rec.path = r.path;
            S.savedCount += 1;
            S.bytes = Math.max(0, S.bytes - (job.rec.bytes || 0));
            job.rec.blob = null;           // 图已落盘，内存立刻释放
          } else {
            job.rec.saved = 0;
            job.rec.photoErr = r.error;
            S.saveFail += 1;
          }
          updateSaveStat();
        }
      } finally {
        this.busy = false;
      }
      updateSaveStat();               // 队列排空后把「已存/待写」的计数刷成准确的
      if (S.records.length) renderRows();
    },
  };

  function updateSaveStat() {
    if (!el.stSaved) return;
    const pend = SaveQ.q.length + (SaveQ.busy ? 1 : 0);
    el.stSaved.textContent = pend ? `${S.savedCount}+${pend}` : String(S.savedCount);
    el.stSaved.parentElement.classList.toggle("bad", S.saveFail > 0);
    el.stSaved.title = S.saveFail ? `${S.saveFail} 张存图失败` : "已写入手机下载目录";
  }

  /* ----------------------------------------------------------- 会话兜底
   * 记录本身很小（一条 ~150 字节），定期快照到 localStorage。
   * 就算 App 被系统杀掉，重开后数据还在，能重新导出表格；照片早就落盘了，不会跟着丢。 */
  let persistTimer = null;
  function sessionPayload() {
    return JSON.stringify({
      v: 1, at: Date.now(), seq: S.seq, sessionDate: S.sessionDate,
      savedCount: S.savedCount, exported: S.exported,
      records: S.records.map((r) => ({
        id: r.id, t: r.t, value: r.value, p: r.p, u: r.u, score: r.score,
        nLines: r.nLines, lineH: r.lineH, flag: r.flag, note: r.note,
        votes: r.votes, verify: r.verify, name: r.name,
        saved: r.saved ? 1 : 0, photoErr: r.photoErr || "",
      })),
    });
  }
  function persistSession() {
    try {
      if (!S.records.length) return;
      localStorage.setItem(SESSION_KEY, sessionPayload());
    } catch (e) {
      console.warn("会话快照写入失败", e);
    }
  }
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; persistSession(); }, 3000);
  }
  function restoreSession() {
    let o = null;
    try { o = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { o = null; }
    if (!o || !Array.isArray(o.records) || !o.records.length) return;
    if (o.exported) { localStorage.removeItem(SESSION_KEY); return; }   // 已导出过的不用再恢复
    S.records = o.records.map((r) => ({ ...r, blob: null, bytes: 0 }));
    S.seq = o.seq || S.records.length;
    S.sessionDate = o.sessionDate || fmtDateOnly(new Date(o.at || Date.now()));
    S.savedCount = o.savedCount || S.records.filter((r) => r.saved).length;
    S.bytes = 0;
    renderChart(); renderStats(); renderRows();
    toast(`已恢复上次 ${S.records.length} 条记录（照片在 下载/${FOLDER}）`);
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  function logFatal(kind, msg) {
    const text = `[${kind}] ${msg}`;
    console.error(text);
    try {
      const log = JSON.parse(localStorage.getItem("voc.errlog") || "[]");
      log.push({ t: Date.now(), text: String(text).slice(0, 500) });
      localStorage.setItem("voc.errlog", JSON.stringify(log.slice(-12)));
    } catch (e) {}
    persistSession();      // 出错前先保住数据
    toast("内部错误：" + String(msg).slice(0, 60));
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
      refreshView();          // 单位、场景名、限值都要在首屏就生效
      progress(100, "就绪");
      setTimeout(() => el.boot.classList.add("hide"), 320);
      bindUI();
      drawChart();
      restoreSession();          // 上次被系统杀掉的话，把记录捞回来
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
      el.autoSave.checked = localStorage.getItem(LS.autosave) !== "0";   // 默认开启：照片必须随手落盘
      if (el.autoCorrect) {
        el.autoCorrect.checked = localStorage.getItem(LS.ac) !== "0";   // 默认开启
        S.acOn = el.autoCorrect.checked;
      }
      const tpl = JSON.parse(localStorage.getItem(LS.tpl) || "null");
      if (tpl && typeof tpl.x0 === "number") S.tpl = tpl;

      /* 元数据 / 单位 / 限值：这些都是「设一次、长期用」的现场信息，持久化到本机 */
      const meta = JSON.parse(localStorage.getItem(LS.meta) || "null");
      if (meta && typeof meta === "object") S.meta = { ...S.meta, ...meta };
      const unit = JSON.parse(localStorage.getItem(LS.unit) || "null");
      if (unit && UNIT_LABEL[unit.in] && UNIT_LABEL[unit.out]) {
        S.unitIn = unit.in; S.unitOut = unit.out;
        if (unit.factor > 0) S.factor = unit.factor;
      }
      const lim = JSON.parse(localStorage.getItem(LS.limit) || "null");
      if (lim && typeof lim === "object") {
        S.limitHiP = isFinite(lim.hi) ? lim.hi : null;
        S.limitLoP = isFinite(lim.lo) ? lim.lo : null;
      }
      S.alarmOn = localStorage.getItem(LS.alarm) !== "0";
    } catch (e) {}
    updateTplState();
    syncSettingsUI();
  }

  /* 把内存里的设置回填到设置面板（首次进入、以及改动单位后刷新限值显示都要用） */
  function syncSettingsUI() {
    if (!el.mPoint) return;
    el.unitIn.value = S.unitIn;
    el.unitOut.value = S.unitOut;
    el.factor.value = S.factor;
    el.alarmOn.checked = S.alarmOn;
    // 正在输入的那一格不要回写，否则光标会跳、小数点被吃掉
    const put = (node, text) => {
      if (node && document.activeElement !== node) node.value = text;
    };
    put(el.limitHi, S.limitHiP == null ? "" : fmtBase(S.limitHiP));
    put(el.limitLo, S.limitLoP == null ? "" : fmtBase(S.limitLoP));
    [el.mScene, el.mPoint, el.mSample, el.mDevice, el.mOperator, el.mTemp, el.mHum, el.mNote]
      .forEach((n, i) => {
        const key = ["scene", "point", "sample", "device", "operator", "temp", "hum", "note"][i];
        put(n, S.meta[key] || "");
      });
    if (el.chartTitle) el.chartTitle.textContent = chartTitleText();
    refreshUnitUI();
  }

  function refreshUnitUI() {
    if (!el.unitHint) return;
    const u = unitTxt();
    document.querySelectorAll(".sheet .u").forEach((n) => (n.textContent = u));
    const needFactor = S.unitIn === "mgm3" || S.unitOut === "mgm3";
    el.factorRow.classList.toggle("need", needFactor);
    el.unitHint.textContent = S.unitIn === S.unitOut
      ? `仪器读数与导出同为 ${u}，不做换算。`
      : `按 1 ppm = ${S.factor} mg/m³ 换算后导出（${UNIT_LABEL[S.unitIn]} → ${u}）。`;
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

    // 等比铺满（cover）：液晶屏位于画面中央，铺满后屏幕本身更大更清楚，
    // 左右多出来的视野裁掉不影响对准。
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
    /* 框内重新按原分辨率画一遍（提亮）。
     * 注意：drawImage 的源坐标是「视频像素」，不能加上画布偏移 ox/oy——
     * 老版本这里错误地带了偏移，导致框里画出的是画面外的区域（一块黑）。 */
    ctxP.drawImage(video,
      S.roi.x * S.videoW, S.roi.y * S.videoH,
      S.roi.w * S.videoW, S.roi.h * S.videoH,
      r.x, r.y, r.w, r.h);
    ctxP.restore();

    // 外框
    ctxP.strokeStyle = S.debug ? "#4a9fe0" : "rgba(74,159,224,.65)";
    ctxP.lineWidth = 2;
    ctxP.strokeRect(r.x, r.y, r.w, r.h);

    // 数字区（真正送进识别模型的那块）——模板模式按比例实时算，否则用检测结果
    const target = S.tpl ? tplToScreen() : (S.lastPick ? lineToScreen(S.lastPick) : null);

    if (S.debug) {
      // 自动模式下把检测到的每一行文字都用绿色细框标出
      if (!S.tpl) {
        ctxP.save();
        ctxP.lineWidth = 1.5;
        for (const L of S.lastLines) {
          if (S.lastPick && L === S.lastPick) continue;   // 选中行另画
          const q = lineToScreen(L);
          ctxP.strokeStyle = "rgba(62,207,142,.92)";
          ctxP.strokeRect(q.x, q.y, q.w, q.h);
        }
        ctxP.restore();
      }

      if (target) {
        ctxP.fillStyle = "rgba(240,150,40,.16)";
        ctxP.fillRect(target.x, target.y, target.w, target.h);
        ctxP.strokeStyle = "#f09628";
        ctxP.lineWidth = 2.5;
        ctxP.strokeRect(target.x, target.y, target.w, target.h);
        // 标注文字，让“这一块就是识别区”一目了然
        ctxP.save();
        ctxP.fillStyle = "#f09628";
        ctxP.font = '600 11px -apple-system, "PingFang SC", sans-serif';
        ctxP.textBaseline = "bottom";
        ctxP.fillText(S.tpl ? "数字区（已锁定）" : "数字区（自动）", target.x + 2, target.y - 3);
        ctxP.restore();
      }

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
    } else if (target) {
      // 采集过程中也标一下当前锁定的读数区，便于确认没跑偏
      ctxP.strokeStyle = "rgba(240,150,40,.85)";
      ctxP.lineWidth = 2;
      ctxP.strokeRect(target.x, target.y, target.w, target.h);
    }
  }

  /* 模板数字区 → 屏幕坐标 */
  function tplToScreen() {
    const { s, ox, oy } = S.map;
    const d = tplRect(roiPx(S.roi));
    return { x: ox + d.x * s, y: oy + d.y * s, w: d.w * s, h: d.h * s };
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

  /* 检测行（相对 ROI 的像素坐标）→ 屏幕坐标 */
  function lineToScreen(L) {
    const { s, ox, oy } = S.map;
    return {
      x: ox + (S.roi.x * S.videoW + L.x) * s,
      y: oy + (S.roi.y * S.videoH + L.y) * s,
      w: L.w * s,
      h: L.h * s,
    };
  }

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

    /* 模板已锁定时：不再跑文字检测，直接按“屏幕 → 数字区”的固定比例裁剪。
     * 这台仪器屏幕布局固定、只有数值在变，所以位置可以一次校准、长期复用，
     * 比每帧重新找文字稳得多，也快得多。 */
    if (S.tpl) {
      const d = tplRect(outer);
      // 双次读取：原位置 + 轻微外扩，两者一致才算稳定（沿用旧的抗抖思路）
      const a = await OCR.readLine(src, d);
      const pad = 0.045;
      const d2 = {
        x: Math.max(0, d.x - d.w * pad), y: Math.max(0, d.y - d.h * pad),
        w: d.w * (1 + pad * 2), h: d.h * (1 + pad * 2),
      };
      const b = await OCR.readLine(src, d2);
      const same = a.value != null && a.value === b.value;
      const use = (!same && b.score > a.score) ? b : a;
      const line = {
        x: d.x - outer.x, y: d.y - outer.y, w: d.w, h: d.h,
        ...use, agree: same ? 2 : 1,
      };
      let flag = "";
      if (line.value == null) flag = "未识别";
      else if (!same) flag = "不一致";
      else if (line.score < 0.5) flag = "低置信";

      S.lastLines = [line];
      S.lastPick = line;
      return {
        value: line.value, text: line.text, score: line.score,
        flag, lines: [line], best: line, nLines: 1,
        ms: a.ms + b.ms, outer, agree: line.agree,
      };
    }

    // 未校准时：先检测出框内所有文字行，再逐行识别，挑出最像读数的那个
    const r = await OCR.readScreen(src, outer, { maxLines: 5 });
    let flag = "";
    if (r.value == null) flag = r.nLines ? "未识别" : "无文字";
    else if (r.score < 0.5) flag = "低置信";

    // 保存给预览层画框用
    S.lastLines = r.lines || [];
    S.lastPick = r.best || null;

    return { ...r, flag, outer };
  }

  /* ==================================================== 自动校正（时序）
   * 思路：同一台仪器的读数在秒级尺度上变化平缓。
   *   ① 先用原始文本重新挑一次值——模型把小数点读成逗号时，老的正则会把点吃掉；
   *   ② 若新值仍明显偏离「上一段趋势」，等一下新帧再读两次；
   *   ③ 三次读数投票：两次一致就采信（真实突变也不会被压住），三次互不相同才标「待复核」。
   * 只有触发复核时才会多读，正常帧零额外开销。
   */
  function waitNewFrame(timeout) {
    return new Promise((resolve) => {
      if (!video || !video.srcObject) return resolve(false);
      const t0 = video.currentTime;
      const start = performance.now();
      const tick = () => {
        if (video.currentTime !== t0 && !video.paused) return resolve(true);
        if (performance.now() - start > (timeout || 500)) return resolve(false);
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  async function refineReading(first, when) {
    const now = when || Date.now();
    const out = {
      ...first,
      value: first.value,
      flag: first.flag,
      note: "",
      votes: "1/1",
      verify: 0,
    };
    if (!AC || !S.acOn || !S.ac) return out;

    const pick = AC.pickValue(first.text, AC.predict(S.ac, now));
    if (pick && pick.value != null) {
      if (pick.value !== first.value) out.note = "点已校正";
      out.value = pick.value;
    }

    const a = AC.assess(S.ac, out.value, now);
    if (out.value == null || !a.need) {
      out.flag = out.value == null ? (first.flag || "未识别") : "";
      return out;
    }

    /* 变化率超标：等新帧再读，最多两次（合计三次验证） */
    const reads = [{ value: out.value, score: first.score, how: pick ? pick.how : "" }];
    for (let i = 0; i < VERIFY_TIMES; i++) {
      const ok = await waitNewFrame(500);
      if (!ok) break;
      const src = grabFrame();
      if (!src) break;
      const r = await recognizeFrame(src);
      const p = AC.pickValue(r.text, AC.predict(S.ac, Date.now()));
      reads.push({ value: p ? p.value : r.value, score: r.score, how: p ? p.how : "" });
      out.verify = i + 1;
    }

    const dec = AC.decide(reads, a.pred, a.tol, S.ac);
    out.value = dec.value;
    out.flag = dec.value == null ? (first.flag || "未识别") : dec.flag;
    if (dec.note) out.note = dec.note;
    out.votes = dec.votes;
    return out;
  }

  /* 只有“无异常标记”的读数才进历史，避免一次错读把之后的预测带偏 */
  function pushAccepted(r, t) {
    if (!AC || !S.ac) return;
    if (r.value == null || r.flag) return;
    AC.push(S.ac, parseFloat(r.value), t);
  }

  /* 模板比例 → 帧内像素矩形 */
  function tplRect(outer) {
    const t = S.tpl || TPL_DEFAULT;
    return {
      x: outer.x + outer.w * t.x0,
      y: outer.y + outer.h * t.y0,
      w: outer.w * t.wf,
      h: outer.h * t.hf,
    };
  }

  /* ------------------------------------------------ 学习数字区（校准）
   * 在已对准的屏框内跑一次文字检测，把找到的读数行换算成“相对屏幕的比例”存下来。
   * 自动结果会加边距，避免换到 4 位读数时被切边。
   */
  async function calibrateTemplate() {
    const src = grabFrame();
    if (!src) return toast("相机未就绪");
    const outer = roiPx(S.roi);
    toast("正在学习数字区…");
    let r;
    try {
      r = await OCR.readScreen(src, outer, { maxLines: 5 });
    } catch (e) {
      return toast("学习失败：" + (e.message || e));
    }
    if (!r.best) {
      S.tpl = { ...TPL_DEFAULT };
      saveTpl();
      updateTplState();
      return toast("没检测到数字，已改用默认比例，请看橙框是否套住读数");
    }
    const b = r.best;
    // 相对屏框的比例 + 边距（左右各 12%，上下各 18%）
    let x0 = b.x / outer.w, y0 = b.y / outer.h;
    let wf = b.w / outer.w, hf = b.h / outer.h;
    const mx = wf * 0.12, my = hf * 0.18;
    x0 = Math.max(0, x0 - mx);
    y0 = Math.max(0, y0 - my);
    wf = Math.min(1 - x0, wf + mx * 2);
    hf = Math.min(1 - y0, hf + my * 2);
    // 读数可能从 1 位变到 4 位，宽度给足，避免切掉高位数字
    if (wf < 0.52) {
      const grow = 0.52 - wf;
      x0 = Math.max(0, x0 - grow / 2);
      wf = Math.min(1 - x0, 0.52);
    }
    S.tpl = { x0, y0, wf, hf };
    saveTpl();
    updateTplState();
    toast(`数字区已锁定：屏内 (${x0.toFixed(2)}, ${y0.toFixed(2)}, ${wf.toFixed(2)}×${hf.toFixed(2)})`);
  }

  function saveTpl() {
    try {
      if (S.tpl) localStorage.setItem(LS.tpl, JSON.stringify(S.tpl));
      else localStorage.removeItem(LS.tpl);
    } catch (e) {}
  }

  function updateTplState() {
    if (!el.tplState) return;
    if (S.tpl) {
      el.tplState.textContent = "模板已锁定";
      el.tplState.classList.add("ok");
    } else {
      el.tplState.textContent = "模板未锁定（自动找字）";
      el.tplState.classList.remove("ok");
    }
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

    // 底部读数：写屏幕上的原值 + 仪器单位，和液晶屏本身对得上（导出时再换算）
    const txt = value != null ? `${value} ${UNIT_LABEL[S.unitIn] || "ppm"}` : "未识别";
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
      const raw = await recognizeFrame(src);
      const r = await refineReading(raw, when.getTime());
      S.seq += 1;
      const seq = S.seq;

      /* 复核期间画面可能已经刷新，存档用最新一帧，
       * 免得照片里的数字和记录的值对不上 */
      const shot = r.verify ? (grabFrame() || src) : src;
      const cv = stampImage(shot, r.outer, when, r.value, r.flag, seq);
      const blob = await canvasToBlob(cv, 0.85);

      const rec = {
        id: seq, t: when.getTime(), value: r.value,
        /* 单位信息随记录一起存：以后改单位，这条的历史值仍然正确 */
        u: S.unitIn, p: toBaseVal(r.value, S.unitIn),
        score: r.score,
        nLines: r.nLines || 0, lineH: r.best ? Math.round(r.best.h) : 0,
        flag: r.flag, note: r.note || "", votes: r.votes || "", verify: r.verify || 0,
        blob, bytes: blob ? blob.size : 0,
        name: `RD_${fmtFileStamp(when)}_${String(seq).padStart(3, "0")}.jpg`,
      };
      S.records.push(rec);
      S.bytes += rec.bytes || 0;
      if (!S.sessionDate) S.sessionDate = fmtDateOnly(when);
      trimImages();
      pushAccepted(r, when.getTime());

      /* 照片随采集落盘。早期版本只在导出时把整批图打进 zip，
       * 30 分钟几万张堆在内存里过桥，必然闪退——现在每张单独写、写完即释放。 */
      if (el.autoSave.checked && blob) {
        if (!SaveQ.push(rec, blob)) toast("存图队列积压，本条照片未保存（数据仍在）");
        updateSaveStat();
      }

      const over = overOf(rec);
      el.hudValue.textContent = rec.p != null ? fmtBase(rec.p) : "--";
      el.hudUnit.textContent = unitTxt();
      el.hud.classList.toggle("over", over !== 0);
      // 「点已校正」几乎每帧都会出现，只在真的复核过时才提示，避免刷屏（明细见表格与导出）
      const hudNote = over !== 0 ? (over > 0 ? "超上限" : "低于下限") : (r.flag || (r.verify ? r.note : ""));
      el.hudTag.textContent = hudNote;
      el.hudTag.className = "hud-tag" + (hudNote ? " show" : "") + (over ? " over" : "");
      if (over) fireAlarm(over);

      renderChart();
      renderStats();
      renderRows();
      persistSoon();
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
    // 调试时把曲线区让给调试面板，画面保持完整不被遮挡
    if (el.chartwrap) el.chartwrap.style.display = S.debug ? "none" : "";
    // 调试时收起数据表格与说明，把高度留给取景画面，方便对准
    document.body.classList.toggle("debug-mode", S.debug);
    if (S.debug) {
      if (S.running) stopRun();
      debugLoop();
    } else {
      clearTimeout(S.debugTimer);
    }
    drawPreview();
    // 布局变化（曲线区隐藏、画面变高）后必须重算画布映射，否则框会落在旧位置
    setTimeout(() => { drawPreview(); if (!S.debug) drawChart(); }, 60);
    setTimeout(() => { drawPreview(); if (!S.debug) drawChart(); }, 260);
  }

  async function debugLoop() {
    if (!S.debug) return;
    try {
      const src = grabFrame();
      if (src) {
        const t0 = performance.now();
        const r = await recognizeFrame(src);

        /* 浮窗显示的就是“真正送进识别模型的那一行”——所见即所识别。
         * 没挑到行时退回显示整个框，让用户知道框内大概是什么内容。 */
        const roi = roiPx(S.roi);
        const show = r.best
          ? { x: roi.x + r.best.x, y: roi.y + r.best.y, w: r.best.w, h: r.best.h }
          : roi;
        const iw = el.cropPreview.clientWidth * 2, ih = el.cropPreview.clientHeight * 2;
        if (el.cropPreview.width !== iw) { el.cropPreview.width = iw; el.cropPreview.height = ih; }
        ctxC.fillStyle = "#0b1118";
        ctxC.fillRect(0, 0, iw, ih);
        // 等比铺满，避免压扁导致和真实形状对不上
        const sc = Math.max(iw / show.w, ih / show.h);
        const dw = show.w * sc, dh = show.h * sc;
        ctxC.drawImage(src, show.x, show.y, show.w, show.h,
                       (iw - dw) / 2, (ih - dh) / 2, dw, dh);

        const sharp = Math.round(OCR.sharpness(src, show));
        el.dbgValue.textContent = r.value != null ? r.value : "--";
        el.dbgScore.textContent =
          "置信度 " + r.score.toFixed(2) + "　检出 " + (r.lines ? r.lines.length : 0) + " 行";
        el.dbgSharp.textContent = "清晰度 " + sharp;
        el.dbgMs.textContent = "耗时 " + r.ms + " ms";

        el.hudValue.textContent = r.value != null ? r.value : "--";
        el.hudTag.textContent = r.flag || "";
        el.hudTag.className = "hud-tag" + (r.flag ? " show" : "");

        let tip;
        if (r.value == null && !r.nLines) tip = "框里没找到文字：把蓝框套住整块液晶屏，避开反光";
        else if (r.value == null) tip = "找到文字但都不是读数：让数字行完整落在框内，别切边";
        else if (sharp < 80) tip = "画面偏模糊：靠近一点，或点一下画面让手机重新对焦";
        else if (r.score < 0.5) tip = "读数置信度偏低：稳住手机，避开屏幕反光";
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
    const pts = S.records.filter((r) => r.value != null)
      .map((r) => ({ t: r.t, v: outOf(r), flag: r.flag, over: overOf(r) }));

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
    const vmaxData = Math.max(...pts.map((p) => p.v));
    const hiOut = S.limitHiP != null ? S.limitHiP * outK() : null;
    const loOut = S.limitLoP != null ? S.limitLoP * outK() : null;
    const vmax = Math.max(vmaxData, hiOut != null && isFinite(hiOut) ? hiOut : 0);
    const ticks = 3;
    const step = niceNum(Math.max(vmax * 1.12, 0.1) / ticks);
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

    /* 限值线：界面上也画出来，测的时候一眼能看出离限值还有多远 */
    const drawLimit = (val, text, color) => {
      if (val == null || !isFinite(val) || val <= 0 || val > top) return;
      const y = Y(val);
      g.save();
      g.setLineDash([5, 4]);
      g.strokeStyle = color; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(pad.l + iw, y); g.stroke();
      g.restore();
      g.fillStyle = color; g.font = "9px -apple-system, sans-serif";
      g.textAlign = "left"; g.textBaseline = "bottom";
      g.fillText(text, pad.l + 3, y - 1);
    };
    drawLimit(hiOut, `上限 ${fmtBase(S.limitHiP)}`, "#ef6b6b");
    drawLimit(loOut, `下限 ${fmtBase(S.limitLoP)}`, "#ef6b6b");

    // 漏采竖带
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t - pts[i - 1].t > iv * 2.5) {
        g.fillStyle = "rgba(239,107,107,.10)";
        g.fillRect(X(pts[i - 1].t), pad.t, X(pts[i].t) - X(pts[i - 1].t), ih);
      }
    }

    // 折线：断采处断开，不画并不存在的连线
    g.strokeStyle = "#4a9fe0"; g.lineWidth = 1.8;
    let segStart = 0;
    for (let i = 1; i <= pts.length; i++) {
      const brk = i === pts.length || pts[i].t - pts[i - 1].t > iv * 2.5;
      if (!brk) continue;
      g.beginPath();
      for (let k = segStart; k < i; k++) {
        const x = X(pts[k].t), y = Y(pts[k].v);
        k === segStart ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
      segStart = i;
    }

    // 点：超限画红点，待核对画黄叉，其余小圆点
    pts.forEach((p) => {
      const x = X(p.t), y = Y(p.v);
      if (p.over) {
        g.fillStyle = "#ef6b6b";
        g.beginPath(); g.arc(x, y, 2.8, 0, Math.PI * 2); g.fill();
      } else if (p.flag) {
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
    g.fillStyle = last.over ? "#ffb3b3" : "#cfe8fb";
    g.font = "600 10.5px -apple-system, sans-serif";
    g.textBaseline = "middle";
    const nearRight = X(last.t) > pad.l + iw - 30;
    g.textAlign = nearRight ? "right" : "left";
    g.fillText(fmtOut(last.v), nearRight ? X(last.t) - 6 : X(last.t) + 6, Y(last.v) - 9);

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

    const overCnt = pts.filter((p) => p.over).length;
    el.chartSub.textContent = `${pts.length} 点 · 最大 ${fmtOut(vmaxData)} ${unitTxt()}` +
      (overCnt ? ` · 超限 ${overCnt}` : "");
  }

  /* =========================================================== 趋势图导出
   * 界面上那条曲线是深色的，直接截图放进报告不好看也糊。
   * 这里用同一份数据另画一张 1600×900 的白底图：标题、时间范围、纵轴刻度、
   * 漏采带、待核对点、统计摘要全都标上，导出 PNG 后可直接插进 Word/PPT。 */
  function chartPoints() {
    return S.records
      .filter((r) => r.value != null)
      .map((r) => ({ t: r.t, v: outOf(r), base: baseOf(r), flag: r.flag, over: overOf(r) }));
  }

  /* 趋势图副标题里的现场信息，没填的字段自动跳过 */
  function metaChips() {
    const m = S.meta, out = [];
    if (m.point) out.push(`点位 ${m.point}`);
    if (m.sample) out.push(`样品 ${m.sample}`);
    if (m.device) out.push(`仪器 ${m.device}`);
    if (m.operator) out.push(`操作人 ${m.operator}`);
    if (m.temp) out.push(`${m.temp} ℃`);
    if (m.hum) out.push(`${m.hum} %RH`);
    return out.join("　·　");
  }

  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + " 秒";
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return `${m} 分${rs ? " " + rs + " 秒" : ""}`;
    const h = Math.floor(m / 60), rm = m % 60;
    return `${h} 小时${rm ? " " + rm + " 分" : ""}`;
  }

  function buildReportChart() {
    const W = 1600, H = 900;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

    const pts = chartPoints();
    const all = S.records;
    const iv = Math.max(0.5, parseFloat(el.interval.value) || 5) * 1000;

    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, W, H);

    // —— 标题区
    const chips = metaChips();
    g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.fillStyle = "#16202b";
    g.font = `700 34px ${FONT}`;
    g.fillText(chartTitleText(), 70, chips ? 72 : 78);
    g.fillStyle = "#6b7785";
    g.font = `400 19px ${FONT}`;
    if (pts.length) {
      const t0 = new Date(pts[0].t), t1 = new Date(pts[pts.length - 1].t);
      g.fillText(`${fmtStamp(t0)}  —  ${fmtStamp(t1)}　共 ${fmtDur(t1 - t0)}　采样间隔 ${(iv / 1000).toFixed(iv % 1000 ? 1 : 0)} 秒`, 70, chips ? 102 : 110);
    } else {
      g.fillText("暂无有效读数", 70, chips ? 102 : 110);
    }
    if (chips) {
      g.fillStyle = "#37424f";
      g.font = `500 19px ${FONT}`;
      g.fillText(chips, 70, 134);
    }
    g.textAlign = "right";
    g.font = `400 17px ${FONT}`;
    g.fillStyle = "#93a1b0";
    g.fillText(`单位 ${unitTxt()}　·　${all.length} 条记录`, W - 70, chips ? 72 : 78);

    const pad = { l: 118, r: 70, t: chips ? 196 : 182, b: 172 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

    if (!pts.length) {
      g.strokeStyle = "#dfe5ec"; g.lineWidth = 2;
      g.strokeRect(pad.l, pad.t, iw, ih);
      g.fillStyle = "#93a1b0"; g.font = `400 22px ${FONT}`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("还没有可绘制的数据", pad.l + iw / 2, pad.t + ih / 2);
      return cv;
    }

    // —— 纵轴刻度（1 / 2 / 2.5 / 5 取整，保证刻度是整数）
    const niceNum = (v) => {
      if (!(v > 0)) return 1;
      const base = Math.pow(10, Math.floor(Math.log10(v)));
      const n = v / base;
      const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
      return m * base;
    };
    const vals = pts.map((p) => p.v);
    const vmax = Math.max(...vals), vmin = Math.min(...vals);
    const hiOut = S.limitHiP != null ? S.limitHiP * outK() : null;
    const loOut = S.limitLoP != null ? S.limitLoP * outK() : null;
    const capMax = Math.max(vmax, hiOut != null && isFinite(hiOut) ? hiOut : 0);
    const ticks = 5;
    const step = niceNum(Math.max(capMax * 1.15, 0.1) / ticks);
    const top = step * ticks;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const span = Math.max(t1 - t0, 1);
    const X = (t) => pad.l + (t - t0) / span * iw;
    const Y = (v) => pad.t + ih - Math.min(Math.max(v / top, 0), 1) * ih;

    // —— 漏采竖带（两帧间隔超过 2.5 个采样间隔，说明中间断了）
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t - pts[i - 1].t > iv * 2.5) {
        g.fillStyle = "rgba(214,72,72,.07)";
        g.fillRect(X(pts[i - 1].t), pad.t, X(pts[i].t) - X(pts[i - 1].t), ih);
      }
    }

    // —— 网格 + 纵轴标签
    g.font = `400 17px ${FONT}`;
    g.textAlign = "right"; g.textBaseline = "middle";
    for (let i = 0; i <= ticks; i++) {
      const y = pad.t + ih - ih * i / ticks;
      g.strokeStyle = i === 0 ? "#c9d3de" : "#eef2f6";
      g.lineWidth = i === 0 ? 1.6 : 1;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(pad.l + iw, y); g.stroke();
      g.fillStyle = "#6b7785";
      const v = step * i;
      g.fillText(String(+(step % 1 ? v.toFixed(1) : v.toFixed(0))), pad.l - 14, y);
    }
    g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.fillStyle = "#93a1b0"; g.font = `400 16px ${FONT}`;
    g.fillText(`读数 (${unitTxt()})`, pad.l - 108, pad.t - 34);   // 放到图区左上角外侧，避免和最高刻度挤在一起

    // —— 限值线（红虚线）+ 超标区间淡红底，一眼看出哪里越线了
    const limitLine = (v, label, below) => {
      if (v == null || !isFinite(v) || v <= 0 || v > top) return;
      const y = Y(v);
      g.save();
      g.setLineDash([9, 7]);
      g.strokeStyle = "rgba(214,72,72,.78)"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(pad.l + iw, y); g.stroke();
      g.restore();
      g.fillStyle = "#c0392b"; g.font = `600 16px ${FONT}`;
      g.textAlign = "left"; g.textBaseline = below ? "top" : "bottom";
      g.fillText(`${label} ${fmtOut(v)} ${unitTxt()}`, pad.l + 10, below ? y + 6 : y - 6);
    };
    limitLine(hiOut, "上限", false);
    limitLine(loOut, "下限", true);

    // —— 按“是否连续”切段：断采期间不连线，否则图上会出现一条并不存在的实测线段
    const segs = [[pts[0]]];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t - pts[i - 1].t > iv * 2.5) segs.push([pts[i]]);
      else segs[segs.length - 1].push(pts[i]);
    }

    // —— 面积 + 折线（每段各自填充，断口处自然留白）
    const base = pad.t + ih;
    for (const seg of segs) {
      if (seg.length < 2) continue;
      g.beginPath();
      seg.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v))));
      g.lineTo(X(seg[seg.length - 1].t), base);
      g.lineTo(X(seg[0].t), base);
      g.closePath();
      const grad = g.createLinearGradient(0, pad.t, 0, base);
      grad.addColorStop(0, "rgba(43,127,212,.20)");
      grad.addColorStop(1, "rgba(43,127,212,.02)");
      g.fillStyle = grad; g.fill();
    }

    g.strokeStyle = "#2b7fd4"; g.lineWidth = 2.6;
    g.lineJoin = "round"; g.lineCap = "round";
    for (const seg of segs) {
      if (seg.length === 1) {                       // 孤立点画个小圆，别让它消失
        g.fillStyle = "#2b7fd4";
        g.beginPath(); g.arc(X(seg[0].t), Y(seg[0].v), 3.4, 0, Math.PI * 2); g.fill();
        continue;
      }
      g.beginPath();
      seg.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v))));
      g.stroke();
    }

    // —— 数据点：超限红实心，待核对橙色空心圈，其余小圆点（点太密就不画，免得糊成一条）
    const drawDots = pts.length <= 600;
    pts.forEach((p) => {
      const x = X(p.t), y = Y(p.v);
      if (p.over) {
        g.fillStyle = "#d64848";
        g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
      } else if (p.flag) {
        g.fillStyle = "#ffffff";
        g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
        g.strokeStyle = "#d9822b"; g.lineWidth = 2.4;
        g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke();
      } else if (drawDots) {
        g.fillStyle = "#2b7fd4";
        g.beginPath(); g.arc(x, y, 3.4, 0, Math.PI * 2); g.fill();
      }
    });

    // —— 最大 / 最小 标注（贴着点放，但夹在图区内，免得压住时间轴或跑出画布）
    const annotate = (p, label, below) => {
      const x = X(p.t), y = Y(p.v);
      const wantBelow = below && y < pad.t + ih - 46;      // 底部放不下就翻到上面
      const ty = wantBelow ? y + 30 : Math.max(y - 16, pad.t + 18);
      const tx = clamp(x, pad.l + 30, pad.l + iw - 30);
      g.textAlign = "center"; g.textBaseline = "alphabetic";
      g.fillStyle = "#16202b"; g.font = `600 17px ${FONT}`;
      g.fillText(`${label} ${fmtOut(p.v)}`, tx, ty);
    };
    const maxP = pts.reduce((a, b) => (b.v > a.v ? b : a), pts[0]);
    const minP = pts.reduce((a, b) => (b.v < a.v ? b : a), pts[0]);
    annotate(maxP, "最大", false);
    if (minP !== maxP) annotate(minP, "最小", true);

    // —— 横轴时间刻度
    g.fillStyle = "#6b7785"; g.font = `400 17px ${FONT}`; g.textBaseline = "top";
    const nX = 6;
    for (let i = 0; i < nX; i++) {
      const p = pts[Math.round(i * (pts.length - 1) / (nX - 1))];
      const x = X(p.t);
      g.textAlign = i === 0 ? "left" : (i === nX - 1 ? "right" : "center");
      g.fillText(fmtTime(new Date(p.t)), x, pad.t + ih + 16);
    }

    // —— 底部统计条
    const good = pts.filter((p) => !p.flag);
    const avg = good.length ? good.reduce((a, p) => a + p.v, 0) / good.length : NaN;
    const bad = all.filter((r) => r.flag || r.value == null).length;
    const overCnt = pts.filter((p) => p.over).length;
    const u = unitTxt();
    const stats = [
      ["最大值", fmtOut(maxP.v) + " " + u],
      ["最小值", fmtOut(minP.v) + " " + u],
      ["平均值", (isFinite(avg) ? fmtOut(avg) : "--") + " " + u],
      ["有效点数", String(pts.length)],
      ["待核对", String(bad)],
      ["超标", String(overCnt)],
      ["采集时长", fmtDur(t1 - t0)],
    ];
    const boxY = H - 122, boxH = 76, boxX = 70, boxW = W - 140;
    g.fillStyle = "#f7f9fb";
    roundRect(g, boxX, boxY, boxW, boxH, 10); g.fill();
    const cw = boxW / stats.length;
    stats.forEach(([k, v], i) => {
      const cx = boxX + cw * i + cw / 2;
      g.textAlign = "center";
      g.fillStyle = "#8b98a6"; g.font = `400 15px ${FONT}`;
      g.fillText(k, cx, boxY + 30);
      g.fillStyle = (k === "超标" && overCnt) ? "#c0392b" : "#16202b";
      g.font = `600 22px ${FONT}`;
      g.fillText(v, cx, boxY + 58);
    });

    g.textAlign = "right"; g.textBaseline = "alphabetic";
    g.fillStyle = "#aab4c0"; g.font = `400 14px ${FONT}`;
    g.fillText(`${sceneName()} · 手机离线识别`, W - 70, H - 12);
    return cv;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function canvasToPngBlob(cv) {
    return new Promise((res) => cv.toBlob((b) => res(b), "image/png"));
  }

  /* 导出曲线图；ts 传进来是为了和数据文件共用同一个时间戳，便于配对 */
  async function saveChartPNG(ts) {
    const blob = await chartBlob();
    if (!blob) return { ok: false, error: "没有可绘制的数据" };
    return await saveBlob(blob, baseName("趋势", ts) + ".png", { quiet: true });
  }

  async function chartBlob() {
    if (!chartPoints().length) return null;
    try { return await canvasToPngBlob(buildReportChart()); } catch (e) { return null; }
  }

  async function exportChart() {
    if (!chartPoints().length) return toast("还没有可绘制的读数");
    const res = await saveChartPNG(fmtFileStamp(new Date()));
    toast(res.ok ? "曲线图已保存到 下载/" + FOLDER : "曲线图保存失败：" + (res.error || ""));
  }

  /* =========================================================== 统计 & 列表 */
  function renderStats() {
    const vals = S.records.filter((r) => r.value != null);
    const good = vals.filter((r) => !r.flag);
    const cur = vals.length ? baseOf(vals[vals.length - 1]) : null;
    el.stCur.textContent = cur == null ? "--" : fmtBase(cur);
    const goodBases = good.map(baseOf).filter((v) => v != null);
    el.stMax.textContent = goodBases.length ? fmtBase(Math.max(...goodBases)) : "--";
    el.stAvg.textContent = goodBases.length
      ? fmtBase(goodBases.reduce((a, b) => a + b, 0) / goodBases.length) : "--";
    el.stCnt.textContent = S.records.length;
    el.stBad.textContent = vals.filter((r) => r.flag).length +
      S.records.filter((r) => r.value == null).length;
    const over = S.records.filter((r) => overOf(r) !== 0).length;
    el.stOver.textContent = over;
    el.stOver.parentElement.classList.toggle("over", over > 0);
    updateSaveStat();
  }

  function renderRows() {
    el.listEmpty.style.display = S.records.length ? "none" : "block";
    const rows = S.records.slice(-MAX_ROWS).reverse();
    el.tbody.innerHTML = rows.map((r) => {
      const d = new Date(r.t);
      const over = overOf(r);
      const cls = over ? "over" : (r.flag ? "bad" : "");
      // 超限时不再显示「正常」，避免同一格里自相矛盾
      const tag = r.flag
        ? `<span class="tag bad">${r.flag}</span>`
        : (over ? "" : `<span class="tag ok">正常</span>`);
      const fix = r.note ? `<span class="tag fix">${r.note}</span>` : "";
      const overTag = over ? `<span class="tag over">${over > 0 ? "超上限" : "低于下限"}</span>` : "";
      let btn;
      if (r.saved) btn = `<span class="tag saved">已存</span>`;
      else if (r.blob) btn = `<button class="savebtn" data-id="${r.id}">存图</button>`;
      else if (r.photoErr) btn = `<span class="tag bad" title="${r.photoErr}">未存</span>`;
      else btn = `<span class="dim" style="font-size:10px">未存</span>`;
      return `<tr class="${cls}"><td>${fmtTime(d)}</td><td class="v">${r.value != null ? fmtBase(baseOf(r)) : "--"}</td><td>${tag}${fix}${overTag}</td><td>${btn}</td></tr>`;
    }).join("");
  }

  el.tbody.addEventListener("click", (e) => {
    const b = e.target.closest(".savebtn");
    if (!b) return;
    const rec = S.records.find((r) => r.id === +b.dataset.id);
    if (!rec || !rec.blob) return;
    SaveQ.push(rec, rec.blob);      // 统一走队列，成功后自动标记「已存」
  });

  /* =========================================================== 导出
   * 文件名统一为「<点位>_<种类>_<时间戳>」；时间戳由调用方传入，
   * 让 csv / xlsx / png 三个文件同名配对，进报告时不会拿错。 */
  function baseName(kind, ts) {
    const tag = cleanName(S.meta.point, 20);
    return `${tag ? tag + "_" : ""}${kind}_${ts || fmtFileStamp(new Date())}`;
  }

  function photoCell(r) {
    return r.saved ? r.name : "未保存";
  }

  function csvCell(v) {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* 元数据块：键值两列，放在数据之前。
   * 现场信息比数据本身更容易丢——三个月后回看，哪台仪器、哪个点位、谁采的，
   * 比多一列读数重要得多。没填的字段自动跳过，老用户不会突然多出一堆空行。 */
  function metaBlock() {
    const m = S.meta, out = [];
    const add = (k, v) => {
      if (v != null && String(v).trim() !== "") out.push([k, String(v).trim()]);
    };
    add("场景", m.scene);
    add("点位名称", m.point);
    add("样品编号", m.sample);
    add("仪器编号", m.device);
    add("操作人", m.operator);
    add("温度(℃)", m.temp);
    add("湿度(%RH)", m.hum);
    add("备注", m.note);
    const pts = chartPoints();
    if (pts.length) {
      const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
      add("采集区间", `${fmtStamp(new Date(t0))} — ${fmtStamp(new Date(t1))}`);
      add("采集时长", fmtDur(t1 - t0));
    }
    add("采样间隔", (parseFloat(el.interval.value) || 0) + " 秒");
    add("读数单位", unitTxt());
    if (S.limitHiP != null) add("上限", `${fmtBase(S.limitHiP)} ${unitTxt()}`);
    if (S.limitLoP != null) add("下限", `${fmtBase(S.limitLoP)} ${unitTxt()}`);
    add("导出时间", fmtStamp(new Date()));
    return out;
  }

  function buildCsvText() {
    const u = unitTxt();
    const lines = [];
    for (const [k, v] of metaBlock()) lines.push([csvCell(k), csvCell(v)].join(","));
    if (lines.length) lines.push("");
    lines.push([
      "序号", "时间", `读数(${u})`, `原始读数(${UNIT_LABEL[S.unitIn]})`,
      "状态", "超限", "置信度", "校正", "验证次数", "图片文件",
    ].join(","));
    for (const r of S.records) {
      const over = overOf(r);
      lines.push([
        r.id, fmtStamp(new Date(r.t)),
        r.value != null ? fmtBase(baseOf(r)) : "",
        r.value != null ? r.value : "",
        r.flag || (over ? "" : "正常"),
        over ? (over > 0 ? "超上限" : "低于下限") : "",
        r.score ? r.score.toFixed(3) : "", r.note || "", r.verify || 0, photoCell(r),
      ].map(csvCell).join(","));
    }
    return "\ufeff" + lines.join("\r\n");
  }

  async function exportCSV() {
    if (!S.records.length) return toast("还没有数据");
    const ts = fmtFileStamp(new Date());
    const blob = new Blob([buildCsvText()], { type: "text/csv;charset=utf-8" });
    const res = await saveBlob(blob, baseName("数据", ts) + ".csv");
    if (res.ok) {
      S.exported = true; persistSession();
      const pic = await saveChartPNG(ts);          // 同名时间戳，数据图配一套
      toast(pic.ok
        ? `CSV 已保存（${S.records.length} 条）+ 趋势图`
        : `CSV 已保存（${S.records.length} 条），但趋势图没存成：${pic.error || ""}`);
    }
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

  /* 生成 xlsx 的 Blob（导出和归档包共用，避免两条路径各写一份） */
  function buildXlsxBlob() {
    const enc = new TextEncoder();
    const u = unitTxt();
    const header = [
      "序号", "时间", `读数(${u})`, `原始读数(${UNIT_LABEL[S.unitIn]})`,
      "状态", "超限", "置信度", "校正", "验证次数", "图片文件",
    ];
    // 元数据放在表头上方，两列键值；与数据之间空一行
    const rows = metaBlock().map(([k, v]) => [k, v]);
    if (rows.length) rows.push([]);
    rows.push(header);
    for (const r of S.records) {
      const over = overOf(r);
      const b = baseOf(r);
      rows.push([
        r.id, fmtStamp(new Date(r.t)),
        b == null ? "" : Number((b * outK()).toFixed(UNIT_DEC[S.unitOut] != null ? UNIT_DEC[S.unitOut] : 1)),
        r.value != null ? Number(r.value) : "",
        r.flag || (over ? "" : "正常"),
        over ? (over > 0 ? "超上限" : "低于下限") : "",
        r.score ? +r.score.toFixed(3) : "", r.note || "", r.verify || 0, photoCell(r),
      ]);
    }
    let sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    rows.forEach((row, ri) => {
      if (!row.length) return;
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
    return zipStore(files);
  }

  async function exportXLSX() {
    if (!S.records.length) return toast("还没有数据");
    const zb = buildXlsxBlob();
    const ts = fmtFileStamp(new Date());
    const res = await saveBlob(zb, baseName("数据", ts) + ".xlsx");
    if (res.ok) {
      S.exported = true; persistSession();
      const pic = await saveChartPNG(ts);
      toast(pic.ok
        ? `Excel 已保存（${S.records.length} 行）+ 趋势图`
        : `Excel 已保存（${S.records.length} 行），但趋势图没存成：${pic.error || ""}`);
    }
  }

  /* 本次会话的日期目录；跨了零点目录不止一个，就交给原生打整个根目录 */
  function sessionFolderDate() {
    const dates = new Set(S.records.map((r) => fmtDateOnly(new Date(r.t))));
    return dates.size === 1 ? [...dates][0] : "";
  }

  /* 照片打包：交给原生端在手机上直接压，JS 一律不碰整批图。
   * 旧实现把几千张 JPEG 收进内存 → arrayBuffer → zip → base64 过桥，
   * 峰值轻松上千 MB，这就是「提示保存了、文件没出来、App 直接退出」的元凶。 */
  async function exportZip() {
    const nb = nativeBridge();
    if (nb && typeof nb.zipFolder === "function") {
      toast("正在手机上打包照片…");
      try {
        const r = await nb.zipFolder({
          folder: FOLDER,
          date: sessionFolderDate(),
          name: baseName("照片", fmtFileStamp(new Date())) + ".zip",
        });
        const cnt = (r && r.count) || 0;
        toast(`已保存 ${(r && r.name) || "照片包"}：${cnt} 张，${fmtSize((r && r.bytes) || 0)}`);
      } catch (e) {
        toast("打包失败：" + ((e && e.message) || e));
      }
      return;
    }

    /* 浏览器兜底：按体积分批，单包不超过 8MB，避免把标签页撑爆 */
    const withBlob = S.records.filter((r) => r.blob);
    if (!withBlob.length) {
      return toast(`没有可打包的照片。手机版会自动把照片存到 下载/${FOLDER}/日期/，可直接去那里取。`);
    }
    const LIMIT = 8 * 1024 * 1024;
    const batches = [];
    let cur = [], curBytes = 0;
    for (const r of withBlob) {
      const sz = r.bytes || 0;
      if (cur.length && curBytes + sz > LIMIT) { batches.push(cur); cur = []; curBytes = 0; }
      cur.push(r); curBytes += sz;
    }
    if (cur.length) batches.push(cur);

    let done = 0;
    for (let i = 0; i < batches.length; i++) {
      const files = [];
      for (const r of batches[i]) {
        files.push({ name: r.name, data: new Uint8Array(await r.blob.arrayBuffer()) });
        r.blob = null;                       // 打一张放一张
      }
      const suffix = batches.length > 1 ? `-${i + 1}of${batches.length}` : "";
      const res = await saveBlob(zipStore(files), baseName("照片", fmtFileStamp(new Date())) + suffix + ".zip");
      if (res.ok) done += batches[i].length;
    }
    toast(done ? `已保存 ${done} 张照片（分 ${batches.length} 个包）` : "照片保存失败，详见提示");
  }

  /* ----------------------------------------------------------- 一键归档
   * 表格 + 趋势图 + 照片一股脑塞进同一个 zip。
   * 表格和 PNG 都只有几百 KB，走 base64 过桥没问题；照片仍由原生流式读取，
   * 所以整包再大也不会在 JS 侧炸掉。 */
  async function exportArchive() {
    if (!S.records.length) return toast("还没有数据");
    const ts = fmtFileStamp(new Date());
    const nb = nativeBridge();
    const zipName = baseName("归档", ts) + ".zip";
    const dataName = baseName("数据", ts);

    toast("正在整理归档包…");
    const png = await chartBlob();
    const extras = [
      { name: dataName + ".csv", data: await blobToDataURL(new Blob([buildCsvText()], { type: "text/csv;charset=utf-8" })) },
      { name: dataName + ".xlsx", data: await blobToDataURL(buildXlsxBlob()) },
    ];
    if (png) extras.push({ name: baseName("趋势", ts) + ".png", data: await blobToDataURL(png) });

    if (nb && typeof nb.archive === "function") {
      try {
        const r = await nb.archive({
          folder: FOLDER, date: sessionFolderDate(), name: zipName, extras,
        });
        const cnt = (r && r.count) || 0;
        S.exported = true; persistSession();
        toast(`归档包已保存：${cnt} 张照片 + 表格/趋势图，共 ${fmtSize((r && r.bytes) || 0)}`, 3200);
      } catch (e) {
        toast("归档失败：" + ((e && e.message) || e), 3200);
      }
      return;
    }

    /* 浏览器兜底：照片本来就在内存里，直接和表格一起打 */
    const files = [];
    for (const ex of extras) {
      const b = await (await fetch(ex.data)).blob();
      files.push({ name: ex.name, data: new Uint8Array(await b.arrayBuffer()) });
    }
    for (const r of S.records) {
      if (!r.blob) continue;
      files.push({ name: r.name, data: new Uint8Array(await r.blob.arrayBuffer()) });
      r.blob = null;
    }
    const res = await saveBlob(zipStore(files), zipName);
    if (res.ok) {
      S.exported = true; persistSession();
      toast(`归档包已保存：${files.length} 个文件`, 3200);
    }
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

    el.btnCalib && el.btnCalib.addEventListener("click", calibrateTemplate);
    el.btnTplReset && el.btnTplReset.addEventListener("click", () => {
      S.tpl = null;
      saveTpl();
      updateTplState();
      S.lastLines = [];
      S.lastPick = null;
      toast("已改回自动找字模式");
      drawPreview();
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
      toast(el.autoSave.checked
        ? `已开启：每张照片采集后立即写入 下载/${FOLDER}`
        : "已关闭存图：照片只留在内存，导出时才打包（长时采集不建议关）");
    });

    if (el.autoCorrect) {
      el.autoCorrect.addEventListener("change", () => {
        S.acOn = el.autoCorrect.checked;
        localStorage.setItem(LS.ac, S.acOn ? "1" : "0");
        AC && S.ac && AC.reset(S.ac);
        toast(S.acOn ? "自动校正已开启（读数突变时复核）" : "自动校正已关闭");
      });
    }

    el.btnClear.addEventListener("click", () => {
      if (!S.records.length) return toast("没有数据");
      if (!confirm("清空所有采集记录和已缓存照片？\n手机上已保存的照片不会被删除。")) return;
      S.records = []; S.seq = 0; S.bytes = 0;
      S.savedCount = 0; S.saveFail = 0; S.exported = false; S.sessionDate = "";
      SaveQ.q.length = 0;
      clearSession();
      if (AC && S.ac) AC.reset(S.ac);
      el.hudValue.textContent = "--"; el.hudTag.className = "hud-tag"; el.hud.classList.remove("over");
      renderStats(); renderRows(); drawChart();
      toast("已清空");
    });

    /* 导出/打包都是异步写盘，期间给按钮加个忙状态，避免连点重复写 */
    const guard = (btn, fn) => async () => {
      if (btn.dataset.busy === "1") return;
      btn.dataset.busy = "1";
      const old = btn.textContent;
      btn.textContent = "处理中…";
      try { await fn(); } catch (e) { logFatal("export", (e && e.message) || e); }
      finally { btn.dataset.busy = "0"; btn.textContent = old; }
    };
    el.btnCsv.onclick = guard(el.btnCsv, exportCSV);
    el.btnXlsx.onclick = guard(el.btnXlsx, exportXLSX);
    el.btnZip.onclick = guard(el.btnZip, exportZip);
    if (el.btnChart) el.btnChart.onclick = guard(el.btnChart, exportChart);
    if (el.btnArchive) el.btnArchive.onclick = guard(el.btnArchive, exportArchive);

    bindSettings();

    window.addEventListener("resize", () => { drawChart(); drawPreview(); });
    // 首次进入：给个引导
    if (!localStorage.getItem(LS.roi)) {
      setTimeout(() => toast("先点「调试」，把蓝框套住整块液晶屏", 3600), 900);
    }
  }

  /* =========================================================== 设置面板
   * 现场信息（点位/样品/仪器/操作人/温湿度）、单位换算、超标限值都在这里。
   * 全部落 localStorage：设一次，下次打开还在，不用每次采集重新填。 */
  function openSheet() {
    syncSettingsUI();
    el.sheet.classList.add("show");
    el.sheetMask.classList.add("show");
  }
  function closeSheet() {
    el.sheet.classList.remove("show");
    el.sheetMask.classList.remove("show");
    // 离开面板时补存一次，避免最后输入的文字因没触发 change 而丢
    readMeta(); readLimits();
  }

  function readMeta() {
    S.meta = {
      scene: el.mScene.value.trim(), point: el.mPoint.value.trim(),
      sample: el.mSample.value.trim(), device: el.mDevice.value.trim(),
      operator: el.mOperator.value.trim(), temp: el.mTemp.value.trim(),
      hum: el.mHum.value.trim(), note: el.mNote.value.trim(),
    };
    try { localStorage.setItem(LS.meta, JSON.stringify(S.meta)); } catch (e) {}
    if (el.chartTitle) el.chartTitle.textContent = chartTitleText();
  }

  function readLimits() {
    const hiTxt = el.limitHi.value.trim(), loTxt = el.limitLo.value.trim();
    const hi = parseFloat(hiTxt), lo = parseFloat(loTxt);
    S.limitHiP = hiTxt === "" || !isFinite(hi) ? null : toBaseVal(hi, S.unitOut);
    S.limitLoP = loTxt === "" || !isFinite(lo) ? null : toBaseVal(lo, S.unitOut);
    try { localStorage.setItem(LS.limit, JSON.stringify({ hi: S.limitHiP, lo: S.limitLoP })); } catch (e) {}
    refreshView();
  }

  /* 单位改了要整体重算：改的是「同一批数据的表达方式」，不是重采。
   * 仪器读数单位一变，自动校正的历史就跨单位了，直接清掉更安全。 */
  function applyUnitChange() {
    const prevIn = S.unitIn;
    if (UNIT_LABEL[el.unitIn.value]) S.unitIn = el.unitIn.value;
    if (UNIT_LABEL[el.unitOut.value]) S.unitOut = el.unitOut.value;
    const f = parseFloat(el.factor.value);
    if (f > 0) S.factor = f;
    try {
      localStorage.setItem(LS.unit, JSON.stringify({ in: S.unitIn, out: S.unitOut, factor: S.factor }));
    } catch (e) {}
    if (prevIn !== S.unitIn && AC && S.ac) AC.reset(S.ac);
    syncSettingsUI();
    refreshView();
  }

  /* 一套刷新：HUD 单位、统计、表格、曲线、标题 —— 改设置后统一走这里 */
  function refreshView() {
    el.hudUnit.textContent = unitTxt();
    if (el.chartTitle) el.chartTitle.textContent = chartTitleText();
    renderStats(); renderRows(); drawChart();
  }

  function bindSettings() {
    if (!el.btnSet || !el.sheet) return;
    el.btnSet.addEventListener("click", openSheet);
    el.sheetClose.addEventListener("click", closeSheet);
    el.sheetMask.addEventListener("click", closeSheet);

    const metaFields = [el.mScene, el.mPoint, el.mSample, el.mDevice, el.mOperator, el.mTemp, el.mHum, el.mNote];
    metaFields.forEach((n) => n && n.addEventListener("change", readMeta));
    [el.limitHi, el.limitLo].forEach((n) => n && n.addEventListener("change", readLimits));
    [el.unitIn, el.unitOut].forEach((n) => n && n.addEventListener("change", applyUnitChange));
    if (el.factor) el.factor.addEventListener("change", applyUnitChange);
    if (el.alarmOn) {
      el.alarmOn.addEventListener("change", () => {
        S.alarmOn = el.alarmOn.checked;
        localStorage.setItem(LS.alarm, S.alarmOn ? "1" : "0");
        if (S.alarmOn) { beep(); toast("报警已开启：超限会震动并响一声"); }
      });
    }
  }

  /* =========================================================== 启动 */
  // 暴露内部状态，方便排查（也可在浏览器控制台里手动调整 ROI：__VOC.roi）
  window.__VOC = S;
  window.__redraw = () => { drawPreview(); drawChart(); };
  // 导出/存图的内部入口，端到端测试与现场排查用（不影响正常流程）
  window.__io = {
    saveBlob, exportCSV, exportXLSX, exportZip, exportChart, exportArchive, SaveQ, persistSession,
    buildCsvText, buildXlsxBlob, chartBlob, metaBlock, overOf, toBaseVal, fmtBase, baseOf, outOf,
    openSheet, closeSheet, readMeta, readLimits, syncSettingsUI, refreshView,
    render: () => { renderStats(); renderRows(); drawChart(); },
  };

  /* 兜住没人 catch 的异常：至少先把数据快照存下来，别白跑半小时 */
  window.addEventListener("error", (e) => logFatal("error", (e && e.message) || "未知错误"));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    logFatal("reject", (r && (r.message || r)) || "Promise 未处理异常");
  });
  // 切后台/页面被回收前强制存一次（localStorage 是同步写，来得及）
  window.addEventListener("pagehide", () => { persistSession(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistSession();
  });

  boot();
})();
