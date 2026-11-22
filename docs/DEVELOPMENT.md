# 开发说明

面向要改代码、重新打包的人。只想用 App 的话看 [README](../README.md) 就够了。

---

## 1. 环境准备

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 20.x / 22.x | 只用来跑 Capacitor CLI 与资源同步，不参与打包网页 |
| JDK | 17 | AGP 8.2 要求 17，不要用 21（Gradle 8.2 不完全兼容） |
| Android SDK | platform-34、build-tools 34.0.0 | 用 Android Studio 装，或命令行 `sdkmanager` |
| Python | 3.8+ | 仅运行 `web/serve_mobile.py`（局域网调试服务器） |

Windows 上注意设好环境变量：

```bat
set JAVA_HOME=C:\Program Files\Java\jdk-17
set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
```

`android/local.properties` 里写 `sdk.dir`（该文件不进仓库）。

---

## 2. 五分钟跑起来

```bash
git clone https://github.com/geek0hao/voc-reader-android.git
cd voc-reader-android

npm install            # 只装 @capacitor/{core,cli,android}
npm run cap:sync       # web/ → www/ → android/app/src/main/assets/public
cd android
./gradlew assembleDebug          # 首次会下载 Gradle 8.2.1 与依赖，约 3-8 分钟
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`。

装到手机：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
# 或用 ./gradlew installDebug
```

---

## 3. 开发循环

**改网页代码后不执行 `npm run cap:sync`，手机上的还是旧版本** —— 这是最容易浪费半小时的坑。

```bash
# 改 web/*.js|css|html 之后
npm run cap:sync
cd android && ./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
```

只想快速看效果，不必每次都装 APK：用浏览器调试（下节）。要调原生桥（存文件、打包）才必须装机。

Capacitor 的 `sync` 会做三件事：复制 `www/` → 安卓 assets；写 `capacitor.config.json` 到原生侧；更新 `strings.xml` 里的 `app_name`（所以改应用名要改 `capacitor.config.json` 的 `appName`，直接改 `strings.xml` 会被覆盖）。

---

## 4. 网页端调试

```bash
cd web
python serve_mobile.py                # 默认 8443，自动生成自签证书 + 二维码
python serve_mobile.py --port 9000
python serve_mobile.py --http         # 不开 TLS，仅本机 localhost 可用
```

手机与电脑在同一 WiFi，扫码打开。首次会提示证书不受信任 → 高级 → 继续前往。

浏览器版与 APK 版的差异：

| 能力 | 浏览器版 | APK 版 |
| --- | --- | --- |
| 摄像头识别 | 有（需 HTTPS 或 localhost） | 有 |
| 导出 CSV/Excel/PNG | 走 `<a download>` | 走 MediaStore 写进 `下载/VOCMonitor/` |
| 照片 zip / 归档包 | JS 内存打包（只适合小批量） | 原生流式打包 |
| 屏幕常亮 | Web Wake Lock（部分浏览器不支持） | 原生 `FLAG_KEEP_SCREEN_ON` |
| Service Worker | 启用（离线缓存） | 禁用（资源已在 APK 内，SW 反而会读到旧缓存） |

调试时可以直接在控制台操作内部状态（`app.js` 暴露了）：

```js
__VOC                        // 全局状态对象：records、meta、unitIn/Out、limitHiP、roi…
__VOC.records.length         // 当前记录数
__io                        // 内部入口集合：saveBlob / exportCSV / exportXLSX / exportArchive /
                             // buildCsvText / chartBlob / metaBlock / overOf / render …
__redraw()                   // 强制重绘取景预览与曲线
```

改完 `web/serve_mobile.py` 即可；它只是个带 TLS 的静态服务器，没有业务逻辑。

---

## 5. 自动化测试

这个项目没有用 Jest/Playwright 那套体系，测试分两层：

### 5.1 纯函数单元测试（`autocorrect.js`）

用 node 直接跑，把 `autocorrect.js` 用 `global` 挂载：

```js
// tests/autocorrect.test.mjs 思路
import { readFileSync } from "node:fs";
const code = readFileSync("web/autocorrect.js", "utf8");
const g = {};
new Function("global", code)(g);         // 文件是 UMD 风格，挂到传入的 global 上
const AC = g.AC;
// 断言：候选枚举、预测、容差、三票表决
```

覆盖过的 23 条断言里，最有价值的几条：

- `"5,6"` 在历史为 5.4/5.5/5.6 时选中 `5.6`，历史为 55/56/57 时选中 `56`；
- 真实突变（5.0 → 8.0 连续三帧一致）必须采信 8.0，不能被预测压回 5.x；
- 三帧互不相同 → 返回 `待复核` 而不是编一个中间值；
- 间隔从 5 s 拉到 60 s 时容差按 √(dt/5) 放大且不超过 2.5 倍。

### 5.2 端到端（无头浏览器 + 假摄像头）

真机跑半小时太慢，改界面/导出逻辑时用 CDP 驱动无头浏览器：

1. 用本地静态服务器托管 `web/`（`python -m http.server` 也可以，但需 `--bind 127.0.0.1` 才被当作安全上下文）。
2. 启动带调试端口的 Edge/Chrome：
   ```bash
   msedge.exe --headless=new --remote-debugging-port=9223 \
     --user-data-dir=/tmp/edge-test --no-first-run about:blank
   ```
3. 用 CDP `Page.addScriptToEvaluateOnNewDocument` 在页面加载前把 `navigator.mediaDevices.getUserMedia` 换成返回 `canvas.captureStream()` 的假流——canvas 上画一张模拟的仪器屏幕（白字黑底 `5.6`、带单位行），比 `--use-file-for-fake-video-capture` 灵活得多，也不用准备 y4m 文件。
4. `Runtime.evaluate` 把间隔改成 1 秒、用 `__io.render()` 或直接点按钮推进流程，跑 100~200 帧后取 `__VOC.records` 断言数量、单位换算、超标计数。
5. 导出后用 `Page.setDownloadBehavior` 收到指定目录，检查 ZIP 里的条目数与 CSV 行数；趋势图直接用 canvas `toDataURL` 抓出来目测。

关键点：**断言要落在数据上**（记录条数、换算值、文件名规则），不要断言像素。

### 5.3 真机回归清单

每次改识别或存储相关代码，真机至少要过这几条：

1. 冷启动 → 相机出图 → 「自动框」能框住屏幕。
2. 「学习数字区」后连续采 20 点，读数与仪器屏幕一致。
3. 间隔设 1 秒，采 5 分钟，中途切后台 10 秒再回来：**相机自动恢复、曲线有断点**。
4. 「归档包」→ 用文件管理器打开 `下载/VOCMonitor/<日期>/`，zip 内的照片数 = 记录数。
5. 强杀 App 再打开：提示恢复未导出记录。
6. 遮挡屏幕 10 秒：出现「未识别」，不产生假数据。

---

## 6. 改识别相关参数

| 想调什么 | 位置 | 注意 |
| --- | --- | --- |
| det 输入尺寸 | `ocr.js` `DET_MIN_SIDE/DET_MAX_SIDE` | 调大更准但慢，320/960 是 720p 下的平衡点 |
| 检测阈值 | `ocr.js` `DET_THRESH`（0.3）/ `DET_BOX_THRESH`（0.5） | 漏检调低，误检调高 |
| 认哪些行 | `ocr.js` `readScreen` 里的选值规则 | 数字长度、是否含字母 |
| 校正容差 | `autocorrect.js` `DEFAULT_OPTS` | `absTol` 调大更"宽容"，也更容易接受错读 |
| 验证次数 | `autocorrect.js` `verifyTimes`（默认 2，即共 3 次） | 加大会拖慢突变响应 |
| 量程 | `autocorrect.js` `RANGE_MIN/RANGE_MAX` | 换仪器必改 |

换模型时注意 rec 的输入高固定 48 px，换成 PP-OCRv4/v5 要同步改 `REC_H` 与字符字典，否则识别结果全是乱码。

---

## 7. 版本与发布

改版本号要动两处：

1. `android/app/build.gradle`：`versionCode`（整数递增）+ `versionName`
2. `capacitor.config.json`：`appName`（显示名，`cap sync` 会写进 `strings.xml`）

`applicationId` 保持 `cn.voc.reader` 不变，否则覆盖安装会被当成另一个应用、旧数据看不见。

发布 Debug APK 走 GitHub Actions：

```bash
git add -A && git commit -m "feat: ..." && git push
```

推上去自动触发 `.github/workflows/build-apk.yml`，3–5 分钟后在 Actions 运行页底部下载 artifact。

要做正式分发（应用商店/长期分发）需要：

1. 生成 release keystore（**不要提交到仓库**，`.gitignore` 已排除 `*.jks`）；
2. `android/app/build.gradle` 配 `signingConfigs`；
3. `./gradlew bundleRelease` 生成 AAB。

---

## 8. 常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 装上去还是旧界面 | 没 `npm run cap:sync` | 同步后重装 |
| 应用名变回"VOC读数采集" | 只改了 `strings.xml` | 改 `capacitor.config.json` 的 `appName` |
| `getUserMedia` 报 `NotAllowedError` | 非安全上下文（http + 局域网 IP） | 用 `serve_mobile.py` 的 HTTPS |
| 相机黑屏但 `readyState=live` | 后台回来后 `videoWidth=0` | 已在 v1.5 处理；改相机代码时别删这段判断 |
| 导出大文件时闪退 | 单次过桥数据太大 | 守住 `BRIDGE_MAX_BYTES`，大批量走原生 zip |
| Actions 编译失败在 SDK 步骤 | runner 的 cmdline-tools 版本差异 | workflow 里已做"缺 android-34 才补装、失败不中断" |
| Gradle 报 JDK 版本 | 用了 21 | 切回 17 |

---

## 9. 代码风格

- 不引入构建工具：`web/` 是纯静态文件，直接 `<script>` 加载，改完刷新即可。加框架会让"改一行→装机验证"的循环变长。
- 注释写**为什么**，不写**做了什么**。特别是反直觉的地方（为什么先置空 `srcObject` 再 stop、为什么 blob 要立刻置 null）。
- 单位换算只在边界做：记录内部统一存 ppm 基准值 `p`，显示和导出时才按 `unitOut` 换算，避免中途单位漂移。
- 新增导出/设置项时，同步更新 `metaBlock()`，否则报告里会缺字段。
