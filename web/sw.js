/* 离线缓存：首次联网打开后，即使电脑关机也能从缓存启动（相机仍可用） */
const CACHE = "voc-ocr-v5";
const ASSETS = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "autocorrect.js",
  "ocr.js",
  "manifest.webmanifest",
  "vendor/ort.min.js",
  "vendor/ort-wasm-simd.wasm",
  "assets/charset.json",
  "assets/ch_ppocr_v3_det.onnx",
  "assets/ch_ppocr_v3_rec.onnx",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          // 顺带缓存同源新资源
          if (res && res.status === 200 && new URL(req.url).origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit || Response.error());
    })
  );
});
