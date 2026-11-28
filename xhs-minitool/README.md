# 小红书小工具 · 净帧

纯离线 H5：清理照片隐私、套水印模板、生成 3:4 发布图，并带图进入原生发布流程。

**当前进度：P0 + 水印模板。** 选图 → 读隐私 → 3:4 预览 → 套模板 → 一键清理 → 保存相册 / 去发布。

## 直接预览

双击 `index.html`。没有 `type="module"`、没有 `fetch`、没有外部资源，`file://` 也能打开。

浏览器里只能预览：`window.xhs.miniTool` 不存在时，保存和发布会明确提示需要在小工具容器中运行，而不是假装成功。

## 已经做的

- 移动端单列布局、安全区、固定底部操作栏（390px 无横向溢出）
- `<input type="file">` 选 1–18 张 JPG / PNG / WebP
- **只读** EXIF / XMP / IPTC / PNG 文本 / WebP 元数据，按「位置·设备·时间·作者·软件」分组标出风险项
- **水印模板**：小红书号 / 极简署名 / 旅行记录 / 探店 / 不加水印，可改主副文字、四角位置、颜色
- **自动反差**：水印落笔前采样下方像素，浅色背景自动改用深色字，避免白字消失
- 原图 / 已清理两个 3:4 预览视图；改水印会实时重绘当前这张
- 一键清理：按 EXIF 方向摆正 → 3:4 居中裁切 → 套水印 → 导出 1080×1440 JPEG(q=0.86)
- 处理进度、可取消、部分失败有可读提示
- `writeTempFile` → `saveImageToPhotosAlbum` → `postNote` 调用链，兼容三种返回约定

## 验证方式

```bash
node dev/check.mjs    # 27 项：解析器/几何/水印/静态合规/体积
node dev/e2e.mjs      # 37 项：真实 Chromium 端到端
node dev/pack.mjs     # 产出 dist/cleanframe-xhs.zip 并自检
node dev/e2e.mjs --root=<解压目录>   # 对 zip 解压产物跑同一套端到端
```

`dev/` 只用于开发，**不会**打进 zip。

- `dev/check.mjs` 用 `../project/tests/fixtures` 的真实样本做回归：GPS 31.2401/121.4904、
  X-T5、作者、外滩关键词、orientation 6 → 90°；水印模板、空文本、四角跟随、自动反差取色。
- `dev/e2e.mjs` 用 CDP 驱动无头 Chrome：真实文件走 `input[type=file]`，断言导出为
  1080×1440、水印真的改变了导出像素、390px 无溢出、8 个方向四角映射符合 EXIF 规范，
  并与 Chrome 自身的 EXIF 处理做像素差分。截图落在 `dev/out/`。

> 注意：DSH 的 Windows 沙箱会阻止 Chrome 的命名管道 IPC，`dev/e2e.mjs` 需要更宽的
> 执行权限才能启动浏览器。

## 三个关键决定

**1. 不移植 `project/js/metadata.js` 的清理逻辑。**
网页版为了「尽量不重压缩」做字节级手术（`stripJpegBytes` 等，约占该文件大半）。
小工具的导出路径是 canvas 重编码，出来的 JPEG 天然没有任何 APP 段，所以只需要
`metadata.js` 里**读**的那部分。这同时绕开了 `DecompressionStream` 和
`Blob.arrayBuffer`（Chrome 61 都不支持）。

**2. 方向矩阵由我们自己负责。**
Chrome 61 画 canvas 时不看 EXIF 方向，Chrome 81+ 会看。为了两边行为一致，导出前把
JPEG 的 Orientation 标签**原地改成 1**（`CleanFrameExif.neutralizeOrientation`，
等长改写、不动其它段），再按读到的方向手动套矩阵。这样矩阵是唯一事实来源。

**3. 水印尺寸用「画布短边百分比」。**
`size` 是短边的百分比，所以 540×720 预览和 1080×1440 导出视觉完全一致，不需要两套参数。

## 关于保存相册 API

`XHS-MINITOOL-BRIEF.md` 里的规范快照说明：

- `saveImageToPhotosAlbum({ filePath })`，必填 `filePath`，支持 base64 data:uri 或本地路径，
  **不支持网络 URL**，且必须由用户操作触发。
- `writeTempFile({ data })`，`data` 要是 `data:<mime>;base64,...` 全量，返回 `{ filePath }`。

**返回约定没有查到。** 本次尝试读取官方文档页
（`miniapp.xiaohongshu.com/doc/DC940286`）时，本环境把所有外部域名都解析到非公网 IP，
`web_fetch` 一律被拒，因此无法确认它返回 Promise、走回调、还是同步返回对象。

所以 `assets/app.js` 里的 `invokeBridge` 按**四种形态**兼容实现，并在 e2e 里逐个验证：

| 形态 | 处理 | 已验证 |
| --- | --- | --- |
| 返回 Promise | await | ✅ |
| 回调 `fn(payload, cb)` | `cb(res)` / `cb.success(res)` / `cb.fail(e)` 都接受 | ✅ |
| 同步返回对象 | `{ filePath }` / `{ code }` / `{ errMsg }` | ✅ |
| 无返回 | 视为成功（原生界面自己会反馈） | ✅ |

关键点：`writeTempFile` 用 `{ needsResult: true }` 调用——如果它既没返回也没回调，
会明确报错（10 秒超时）而不是把 `undefined` 当 `filePath` 传给相册 API。
权限被拒（`auth deny` 之类）会翻译成「相册权限被拒绝，请在系统设置里允许小红书访问照片」。

**仍需真机确认的**：真实容器到底走哪种、是否需要 `writeTempFile` 这一跳
（如果 `saveImageToPhotosAlbum` 直接吃 data:uri，可以省掉一次落盘）。

## 文件

```text
index.html              单页入口
assets/exif.js          元数据只读解析 + 方向标签中和
assets/render.js        3:4 画布几何、方向矩阵、JPEG data URI 导出
assets/watermark.js     水印模板、自动反差取色、文字绘制
assets/app.js           状态机、进度/取消/部分失败、bridge 调用
assets/style.css        Chrome 61 基线样式
dev/check.mjs           Node 层验证（不入包）
dev/e2e.mjs             浏览器端到端验证（不入包）
dev/pack.mjs            zip 打包 + 自检（不入包）
dist/cleanframe-xhs.zip 上传用产物
```

## 打包

```bash
node dev/pack.mjs
```

产出 `dist/cleanframe-xhs.zip`（当前 30 KB，6 个文件，未压缩 106 KB）。

打包脚本用**白名单**而不是排除列表，只放行：

```text
index.html
assets/*.js
assets/*.css
```

它会自检：`index.html` 在 zip 根目录、没有 `dev/`、每一条都在白名单内、体积在 2 MiB 目标与
10 MiB 硬上限之内。压缩时直接打包「内容」，不会多套一层目录。

这个 zip 已经用独立工具解开并跑过完整端到端（`node dev/e2e.mjs --root=<解压目录>`，37/37），
解压文件与源码哈希一致。

## 下一步

1. **真机验证**是现在唯一剩下的事：把 `dist/cleanframe-xhs.zip` 传到创作服务平台，
   在真机上走一遍保存相册和带图发布。需要确认的三项：
   - 容器里 `writeTempFile` / `saveImageToPhotosAlbum` 的真实返回约定（现在四种都兼容）
   - 是否还需要 `writeTempFile` 这一跳（如果相册 API 直接吃 data:uri，可以省掉一次落盘）
   - 18 张满额时的内存与 data URI 体积上限
2. 如果平台要求额外的清单文件（如 `minitool.json`），需按平台实时规则补上 —— 当前快照只要求
   根目录有 `index.html`。
3. 批量改名（P2）、Logo 水印、更多模板。

## 还没做 / 已知未知

- 18 张满额时 data URI 总量可能到几 MB；目前只提示建议分两次发布，没有自动降质。
- 未在 Chrome 61 真机内核上跑过，只用静态扫描 + 真 Chromium 行为守住基线。
- Logo 水印、图层排序编辑器没有做（MVP 外）。
