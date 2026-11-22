# 第三方组件声明

本仓库代码以 MIT 许可发布（见 [LICENSE](LICENSE)）。仓库内还分发以下第三方组件，它们遵循各自的许可，不受本项目 MIT 许可覆盖。

## PP-OCRv3 识别模型

| 项 | 内容 |
| --- | --- |
| 文件 | `web/assets/ch_ppocr_v3_det.onnx`（文字检测）、`web/assets/ch_ppocr_v3_rec.onnx`（文字识别）、`web/assets/charset.json`（字符字典） |
| 来源 | PaddleOCR — https://github.com/PaddlePaddle/PaddleOCR |
| 版权 | Copyright (c) Baidu, Inc. |
| 许可 | Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0 |

模型为 PP-OCRv3 中文模型的 ONNX 导出（det 输入短边 320、rec 输入高 48），随 APK 打包以支持离线识别。

## ONNX Runtime Web

| 项 | 内容 |
| --- | --- |
| 文件 | `web/vendor/ort.min.js`、`web/vendor/ort-wasm-simd.wasm` |
| 来源 | ONNX Runtime — https://github.com/microsoft/onnxruntime |
| 版权 | Copyright (c) Microsoft Corporation |
| 许可 | MIT License |

以单线程 WASM 后端运行（`numThreads = 1`），因此不需要 COOP/COEP 跨源隔离头，兼容性最好。

## Apple / 其他图标资源

安卓启动图标由 `@capacitor/assets` 默认模板生成，未使用第三方商业素材。

---

如果你的使用场景对模型许可有额外要求（例如不能分发 Apache-2.0 模型），可以：

1. 删除 `web/assets/*.onnx`，改为首次启动时从你自己的服务器下载；
2. 或换用其他 OCR 模型（需同步调整 `web/ocr.js` 里的输入尺寸与字符字典）。

详见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第 6 节。
