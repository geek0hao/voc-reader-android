/**
 * 把 ../mobile_ocr 里的网页资源同步到 www/
 * （mobile_ocr 仍是唯一源码，这里只做搬运，避免两份代码各改一处）
 */
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.resolve(root, "..", "mobile_ocr");
const dst = path.resolve(root, "www");

const FILES = ["index.html", "style.css", "app.js", "ocr.js", "manifest.webmanifest"];
const DIRS = ["assets", "vendor"];

if (!existsSync(src)) {
  console.error("[copy-web] 找不到源目录: " + src);
  process.exit(1);
}

await rm(dst, { recursive: true, force: true });
await mkdir(dst, { recursive: true });

let total = 0;
for (const f of FILES) {
  const p = path.join(src, f);
  if (!existsSync(p)) {
    console.warn("[copy-web] 跳过缺失文件: " + f);
    continue;
  }
  await cp(p, path.join(dst, f));
  total += (await stat(p)).size;
}
for (const d of DIRS) {
  const p = path.join(src, d);
  if (!existsSync(p)) {
    console.warn("[copy-web] 跳过缺失目录: " + d);
    continue;
  }
  await cp(p, path.join(dst, d), { recursive: true });
}

// 原生壳里不需要 Service Worker：资源已在 APK 内，SW 反而会导致升级后读到旧缓存
if (existsSync(path.join(dst, "sw.js"))) await rm(path.join(dst, "sw.js"), { force: true });

console.log(`[copy-web] 已同步到 www/ ，源文件 ${(total / 1048576).toFixed(1)} MB（含模型与 wasm）`);
