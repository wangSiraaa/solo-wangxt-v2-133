# 纸样工程 · 纯浏览器 Pattern CAD

一次省道转移会同时改变**轮廓、缝线、裁剪线、缝份和记号**——任何一层只改成功一半，后续放码就会失去依据。
本工具把一次转移实现为**事务命令**：源模型（稳定特征身份）+ 派生层（屏幕路径、缝份、裁剪轮廓、记号），
React/TypeScript 管理命令与选择状态，Paper.js 维护曲线，Clipper2 WASM 在 Web Worker 中完成布尔运算，
IndexedDB 保存带版本的本地工程。

## 架构分层

```
model/types.ts            源模型（单位恒为 mm）：Point/Edge(line|cubic)/Loop/Dart/Notch/Slash/Piece
model/idgen.ts            单调特征 id（随版本保存，撤销/重做不回收）
geometry/
  bezier.ts               自适应离散、de Casteljau 切分、弧长
  intersection.ts         射线与直线/三次贝塞尔精确求交
  rebuild.ts              派生层重建：环折线、记号世界位置/法向、面积/包围盒、几何指纹
  validation.ts           纯 TS 数值校验：闭合/自交/零边/省腿长度/记号与剪线方向（全部带容差+实测值）
commands/transferDart.ts  省道转移事务（深拷贝执行 → 全量校验通过才提交新版本）
worker/
  clipper.worker.ts       Web Worker（Clipper2 WASM 初始化、取消、代次回包）
  clipperCore.ts          缝份 offset / 布尔运算（y 轴翻转、外轮廓/内孔分类），可被 Node 测试复用
  client.ts               主线程客户端：gen+fingerprint 代次核对、取消、缓存
paper-canvas/
  buildPath.ts            源模型 → 精确三次曲线路径规格（不经过离散）
  PatternCanvas.tsx       Paper scope，每次版本变化完全重建派生场景
  svgExport.ts            SVG 导出（同一已提交版本 + 比例尺 + 容差/校验 metadata）
state/editor.tsx          事务提交、撤销/重做（整次操作）、选择状态、单位、gen
state/useAllowances.ts    派生缝份请求（版本前进取消在途任务）
storage/idb.ts            IndexedDB
storage/migrate.ts        显式链式迁移 v1→v2→v3，无法迁移对象保留只读副本
```

### 源模型 → 派生层

- 省尖、剪切交点、省口是**带稳定 id 的源特征点**；记号以 `(edgeId, t, normalSide, pointId?)` 绑定。
- 曲线切分用 de Casteljau 在精确 `t0` 处分裂；记号按 `t/t0`、`(t-t0)/(1-t0)` 精确改绑，
  因此省尖、交点、曲线方向不会因重新离散而漂移。
- 刚体旋转旋转侧时，三次贝塞尔的绝对控制点绕省尖同步旋转（形状保持，无需重新拟合）。
- 屏幕路径、缝份、裁剪轮廓在任意时刻都可由当前已提交版本完整重建（`rebuildPiece` / `buildScreenPath`）。

### 事务与撤销/重做

- `transferDart` 在源数据的**深拷贝**上执行；任一校验失败（闭合、自交、省腿长度、记号方向）抛 `TransferError`，
  当前版本保持不变，错误带容差阈值与实测值。
- 成功才追加不可变 `VersionSnapshot`；撤销/重做按**整次操作**恢复；redo 支线在新提交时截断。

### Worker 代次保护

- 每个请求携带 `gen`（版本代次）与 `fingerprint`（几何+缝份哈希）。
- 回包若 `gen` 落后于已提交的最新代次、指纹不符或任务已取消，一律拒绝（`STALE_RESULT`），
  用户在计算期间继续编辑或取消任务，迟到结果都不会覆盖当前几何。

### 单位与迁移

- 模型永远以毫米存储；毫米/英寸切换只改显示与输入解析。
- 导入任意旧版 JSON 走显式迁移链；没有迁移路径的格式整体拒绝，
  个别无法识别的对象（坏边/记号/剪线）原样保留在 `readonlyObjects` 中只读可见。

## 验证

```bash
npm test         # 39 个测试（vitest + Testing Library + 真实 Clipper2 WASM）
npm run build    # tsc 严格类型检查 + Vite 构建（worker 与 .wasm 作为独立资源产出）
```

覆盖的关键场景：

- **直线省转移**：闭合、无自交、省腿等长、面积守恒、闭合间隙为 0
- **曲边省/曲边命中**：射线精确命中三次贝塞尔侧缝，de Casteljau 分裂，记号零漂移
- **剪线命中旧记号**：吸附并在新省双腿生成端点记号（方向朝外）
- **连续转移 + 快速撤销**：省尖 id 链稳定，连撤 3 次逐版本恢复，无半截环
- **事务失败保护**：射线落空、省腿不等长时不产生新版本
- **旧版工程恢复**：v1/v2 夹具迁移到 v3 后可立即继续转移
- **Worker 代次**：继续编辑/取消后迟到回包被拒绝
- **SVG**：来自同一已提交版本，含 50mm 比例尺、容差值、校验结论（含失败原因与实测值）
- **真实 WASM**：100mm 方外扩 10mm 缝份 → 120×120mm；布尔差集正确

## 使用

```bash
npm install
npm run dev      # http://localhost:5173
```

- 左侧设置剪切角度，选择未闭合省后"提交一次转移"；
- 右侧查看校验结论（容差与实测值）、版本历史、只读迁移对象、操作审计；
- 顶部毫米/英寸仅切换显示；"导出 SVG"只导出当前已提交版本；
- "导入旧工程"可加载 v1/v2 JSON 验证迁移。
