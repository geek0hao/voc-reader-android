# VOC 读数采集（安卓 APK）

把霍尼韦尔 MiniRAE Lite+（PGM-7300）液晶屏上的 VOC 读数，用手机摄像头定时拍下来、离线识别成数字、实时画曲线，并把照片和表格存进手机。

**完全离线**：识别模型（11 MB PP-OCRv3）打包在 APK 内，不联网、不上传、不需要电脑。

---

## 一、怎么拿到 APK（不用装 Android Studio）

仓库里已经配好 GitHub Actions，云端用 Ubuntu + JDK 17 + Android SDK 34 编译。

1. 把本目录推到这个 GitHub 仓库（见第四节）。
2. 打开仓库页面 → 顶部 **Actions** → 左侧 **Build APK** → 右侧 **Run workflow**（或直接 push 触发）。
3. 等约 3–5 分钟，构建完成后点进这次运行 → 页面底部 **Artifacts** → 下载 **VOC-Reader-apk**（zip 里就是 `app-debug.apk`）。
4. 手机下载后点开安装，需要允许「安装未知来源应用」。

> Debug 版用 Android 默认调试证书签名，自己装没问题；以后换版本覆盖安装也是同一签名，数据不会丢。
> 想发到应用商店才需要另做 release 签名和 AAB，这里不涉及。

---

## 二、手机上怎么用

| 界面 | 说明 |
| --- | --- |
| 上部 | 摄像头取景，蓝框套住整块液晶屏；HUD 显示当前读数 |
| 中部 | 时间-读数曲线（横轴时间、纵轴 ppm） |
| 下部 | 采集记录表 + 统计（当前/最大/平均/点数/待核对） |

1. 首次打开会申请**相机权限**，必须允许。
2. 点「**调试**」→ 拖动四个角，让蓝框正好套住液晶屏（不用管单位，程序只读数字）。
3. 点「**开始采集**」，按设定间隔（默认 5 秒）自动抓拍识别。
4. 勾选「**每张自动存到手机**」，照片会按 `下载/VOCMonitor/日期/` 存好。
5. 「导出 CSV / Excel / 照片打包」同样保存到 `下载/VOCMonitor/日期/`。

**运行期间请保持 App 在前台**（已强制竖屏 + 屏幕常亮）。安卓会在 App 退到后台时冻结网页计时器，这是系统行为，改不了。

---

## 三、目录结构

```
voc_android/
├─ capacitor.config.json        appId / 应用名 / webDir
├─ package.json                 只依赖 @capacitor 三件套
├─ scripts/copy-web.mjs         把 ../mobile_ocr 的网页资源搬到 www/
├─ www/                         网页资源（含 11MB 识别模型 + wasm，已提交）
├─ .github/workflows/build-apk.yml   云端打包
└─ android/                     原生工程
   ├─ app/src/main/AndroidManifest.xml   相机/常亮/存储权限
   ├─ app/src/main/java/cn/voc/reader/
   │   ├─ MainActivity.java              注册插件 + 屏幕常亮
   │   └─ NativeBridgePlugin.java        保存文件到下载目录 / 常亮 / 版本信息
   └─ app/src/main/assets/public/        cap sync 时从 www/ 复制（不入库）
```

网页源码的**唯一出处**仍是上层目录的 `../mobile_ocr/`。改完那边执行：

```bash
npm run cap:sync      # copy-web + cap sync android
```

---

## 四、推送到 GitHub 并触发构建

```bash
cd voc_android
git init
git add .
git commit -m "VOC reader android app"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

推送需要凭据：GitHub 已不支持密码，用 **Personal Access Token**（Settings → Developer settings → Personal access tokens → Fine-grained token，勾选该仓库的 Contents: Read and write），用户名填 GitHub 用户名、密码填 token。

仓库公开 / 私有都行：公开仓库 Actions 不限时长；私有仓库每月 2000 分钟免费额度，一次构建约 4 分钟，够用几百次。

---

## 五、已知限制

- **不能后台采集**：锁屏或切到别的 App 就停，必须前台运行（可插充电宝）。
- **斜拍近景**可能自动框选不到屏幕，手动把框拖准即可；框选位置会记在本地。
- 单张存档是**只裁屏幕区域**的 JPEG（约 15–20 KB），5 秒一张约 **12 MB/小时**，8 小时不到 100 MB。
- 采集数据存在页面内存里，**关闭 App 前请导出一次**（CSV 或 Excel）。
- 换手机 / 重装 APK 不影响已保存到「下载」目录的照片和表格。

---

## 六、License

识别模型为 PP-OCRv3（Apache-2.0），运行时为 ONNX Runtime Web（MIT）。本项目代码供科研自用。
