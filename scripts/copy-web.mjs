/**
 * 把 web/ 里的网页资源同步到 www/
 * （web/ 是唯一源码，www/ 是构建产物，只做搬运，避免两份代码各改一处）
 *
 * 兼容老目录：如果 web/ 不存在，退回上层目录的 mobile_ocr/
 * （早期开发时网页源码放在仓库外，保留这条回落路径免得打断老工作流）
 */
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dst = path.resolve(root, "www");

const candidates = [path.resolve(root, "web"), path.resolve(root, "..", "mobile_ocr")];
const src = candidates.find((p) => existsSync(p)) || candidates[0];

const FILES = ["index.html", "style.css", "app.js", "autocorrect.js", "ocr.js", "manifest.webmanifest"];
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
