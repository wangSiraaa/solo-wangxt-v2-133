# 纸样工程工具 · Pattern Studio

纯浏览器运行的纸样（服装样板）工程工具。围绕「**一次省道转移是一次事务命令**」构建：
轮廓、缝线、裁剪线、缝份、记号在同一次提交里一起变换；任何闭合 / 自交 / 长度 /
记号方向校验失败都**不替换当前版本**。

## 技术栈

- **React 18 + TypeScript**：命令、选择、撤销/重做、单位、导入导出状态。
- **Paper.js**：屏幕曲线渲染与命中（纯派生层，不回写几何源）。
- **Clipper2 WASM（Web Worker）**：缝份外偏 `InflatePaths64`、自交权威判定
  `UnionSelf64`、面积核算。WASM 加载失败时回退纯 TS 后端并如实标注 `fallback-ts`。
- **IndexedDB**：带版本的本地工程（工程头 + 每个已提交版本的完整快照）。

## 核心架构取舍：稳定身份 vs 可重建派生

```
源模型（source of truth，存版本库）
  Piece.vertices / edges(三次贝塞尔，绝对控制点) / darts / marks
  特征只持有稳定身份：顶点 id、边 id、(edgeId, arcFraction 弧长分数)、省尖 id
        │  任意时刻可完全重建
        ▼
派生层（derive / worker 产物，缓存进版本但绝不回写）
  seamLoop 离散缝合环 · cutPaths 裁剪轮廓(缝份外偏) · resolvedMarks 世界坐标
        │
        ▼
Paper.js 屏幕路径（显示/命中，不是几何依据）
```

重新离散（改 tessellation、缩放、重建场景）时，省尖、剪切交点、记号只通过
`edgeId + arcFraction`（Gauss–Legendre 弧长参数化）解析，**不会二次改绑**。

## 省道转移（枢轴法）

缝合环拓扑：`B1 →leg1→ P(省尖) →leg2→ B2 →外边链→ … → B1`。

转移时把新省口 `Q` 到 `B1` 一段绕省尖旋转 θ（θ 取使 `R(B1)=B2` 的有向角，代码
强制校验重合），旧省闭合、在 `Q` 与旋转像 `Q′` 间张开新省，省尖身份不变。曲线用
精确 **de Casteljau** 切分，旋转是刚体全等，故新省两腿严格等长。

## 事务与并发防护

- 同步解析预检 → Worker Clipper 权威校验 → 才生成新版本（失败只报退化原因）。
- Worker 请求携带 `requestId` 与工程代次 `gen`；返回时双重核对。计算期间继续编辑、
  连续撤销或取消任务，迟到结果一律丢弃，**绝不覆盖新几何**。
- 撤销 / 重做恢复的是整次操作的完整快照（版本栈截断 redo 分叉）。
- `refresh` 模式只重算当前版本派生（初始打开/导入后填缝份与裁剪轮廓），不产生新版本。

## 单位与迁移

- 内部几何恒为 **毫米**；英寸仅在显示层换算（1in=25.4mm）。
- 导入旧工程走显式迁移链（当前支持 v1→v2）。无法迁移的对象进入**只读隔离区**
  （`readonlyQuarantine`），保留原始副本、可见、不参与运算与导出。

## SVG 导出

- 只能从**当前已提交且校验通过**的版本导出；缝合环、裁剪轮廓、记号、比例尺全部
  来自该版本冻结的 `derived` / worker 产物，而非“画面看起来的样子”。
- 1 user unit = 1mm，含真实 50mm 比例尺；`<metadata>` 写入版本号、容差、
  闭合缺口、省腿长度差、失败项。

## 校验（数值可见，不以视觉闭合为准）

| 代码 | 含义 |
|---|---|
| `NOT_CLOSED` | 拓扑断裂 / 离散环闭合缺口超阈值 |
| `SELF_INTERSECT` | 解析 O(n²) 检测 + Clipper UnionSelf 权威判定 |
| `LEG_LENGTH_MISMATCH` | 省两腿等长差（带实测/阈值） |
| `MARK_DIRECTION_OUTWARD` | 剪口刃口朝向裁片外侧 |
| `DEGENERATE_EDGE` | 零长度边 / 端点省口 |
| `CUT_OFFSET_FAILED` | 缝份外偏失败或裁剪轮廓分裂 |
| `CUT_HITS_MARK` | 剪线（省尖→新省口）穿过旧记号，需显式提升或改道 |

## 开发

```bash
npm install
npm run dev        # 开发
npm run build      # 类型检查 + 产物（含 worker、wasm 资源）
npm test           # 30 个测试（几何/转移/迁移/历史/代次/SVG/WASM/E2E）
```

## 验收场景对应测试

- 直线省转移：`src/__tests__/pivot.test.ts` 场景1
- 曲边省转移（曲线精确切分 + 刚体全等）：场景2
- 剪线命中旧记号（拒绝 / 提升）：场景3
- 连续快速撤销/重做 + Worker 迟到代次防护：`history.test.ts`
- 旧版工程恢复 + 只读隔离：`migrate.test.ts`
- 同一已提交版本 SVG 与比例尺、退化原因可见：`export.test.ts`
- Clipper2 WASM 真实布尔与端到端提交链：`clipper-wasm.test.ts`、`e2e-worker.test.ts`
