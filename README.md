# 糯籽 · Nuozi Desktop Pet (DSH plugin)

> ### 作者 / Author: **JP-Alan（微电子学院最强大的畜生）**
> **GitHub: <https://github.com/JP-Shi>**
>
> ⚠ 引用本工程或素材时，**必须**注明作者并附上作者 GitHub 主页链接：<https://github.com/JP-Shi>

把成熟的中科大「糯籽」宠物素材接入 DeepSeek Harness Web GUI，并将宠物动作状态与
DSH 工作状态联动。

## 状态联动语义

所有动作统一主形象：直立双足、牛角、耳朵、尾巴、蓝色 `USTC` 围巾、完整四肢。

| DSH 状态 | Agent 状态 | 宠物动作 | 素材 |
|---|---|---|---|
| 无操作（所有 Agent 空闲） | 无任务 | `idle` 站立待机、呼吸起伏、眨眼；偶尔**抬蹄挥手、开心互动、回正**（自发小挥手，9~22s 一次） | atlas row 0 / row 3 |
| 任一 Agent 运行中（含子代理、工作流） | Running | **思考态**：歪头思考/检查循环为常驻底，穿插 16 向**张望**、**小范围来回踱步**（移动切跑动帧，走完踱回锚点），以及每 4.5~9s 一场的 row 7 **工作节拍小剧场**：工作处理中 → 思考 → 疲惫 → 惊醒 → 恢复工作（约 3s 演完，回思考循环） | atlas rows 8, 9-10, 1-2 + row 7 |
| 等待审批 / 等待用户回答问题 | Needs input | `waiting` 站立等待、抬蹄、眨眼、左右观察循环；等得急了会切 16 向**大张望**并**小范围来回踱步**（移动时切跑动帧，踱回原位继续等待） | atlas row 6 + rows 1-2, 9-10 |
| 光标聚焦在输入框（Agent 空闲时） | 输入中 | 复用 `waiting` 循环——站立抬蹄观察地陪你，焦点离开立即恢复 | atlas row 6 |
| 回合完成、输出就绪 | Ready | **直接回到 `idle` 呼吸态**——思考/审阅表情是工作态专属，空闲绝不装思考 | atlas row 0 |
| 用户刚发送消息 / 点击宠物 | — | `waving` 歪头抬蹄、开心挥动 | atlas row 3 |
| 双击宠物 | — | `jumping` 蓄力 → 起跳 → 悬空 → 落地 | atlas row 4 |
| **断网 / 命令执行 error** | Blocked（瞬时） | **「握草」**：瞬时关键帧 1.1s（青草突现双蹄、震惊表情，配“握草！”气泡）→ `failed` 坍塌叙事**播一次**（愣住→泄气→坐下→躺平）停在呆滞末帧至平息，带抖动 | easter-eggs grass + atlas row 5 |
| **空闲随机彩蛋** | — | 一个不剧透的小动作（触发时自然可见；概率与间隔可配） | easter-eggs |

「握草」触发源（宿主半监听）：
- `agent/request-error` — 模型请求失败（断网、超时、5xx）
- `tools/result` — `bash` / `pwsh` 等命令工具 `isError` 或尾部 `[exit code: N≠0]`
- `agent/error` / `api-session/error` — 回合/会话级错误
- 浏览器 `offline` 事件与轮询失败（客户端本地即时检测，无需等轮询）

连续错误风暴会合并为一次「握草」（1.5s 节流），平息后自动恢复原状态。

## 图集动作语义表（最终交付包权威定义）

按交付包 `spritesheet-extended` 与 `pet_request.json`，图集实际包含：

| 状态 | 帧数 | 实际动作 |
|---|---:|---|
| `idle` | 6 | 站立待机、呼吸起伏、眨眼 |
| `running-right` | 8 | 直立双足向右奔跑，前蹄摆臂 |
| `running-left` | 8 | 直立双足向左奔跑，前蹄摆臂 |
| `waving` | 4 | 抬蹄挥手、开心互动、回正 |
| `jumping` | 5 | 蓄力、起跳、空中、落地 |
| `failed` | 8 | 愣住、泄气、坐下、躺平、失意收尾 |
| `waiting` | 6 | 站立等待、抬蹄、眨眼、左右观察 |
| `running` | 6 | 工作处理中、思考、疲惫、惊醒、恢复工作 |
| `review` | 6 | 观察结果、换角度检查、思考、确认 |

另有两行不是普通动作，而是 **16 个观察方向**：`look-row-9`（8 向，0°–157.5°）、
`look-row-10`（8 向，180°–337.5°）。

独立彩蛋素材：**「握草」瞬时关键帧**；以及隐藏彩蛋的**站立到趴下三帧参考**。

> **勘误**：交付包里的 `waiting` 是**站立等待动作**；早期设计文档所述“坐着晃脚”
> **未进入**最终 Pet 图集（行号映射已经 rows-final 审批帧逐帧比对，IoU 1.00，无误）。

## 交互

- 拖动移动：糯籽会随拖动方向左右奔跑，反向拖动即时换向，松手后回到当前工作状态
  （位置存 localStorage）；点击 = 摸头挥手；双击 = 跳跃
- **光标聚焦在输入框时**（Agent 空闲前提下）：糯籽切换为站立抬蹄观察陪你，
  焦点离开输入框（含切换窗口）立即恢复；发送成功会先挥手迎接
- `prefers-reduced-motion` 时关闭散步/抖动

## 配置（profile `cordis.patch.yml` 中 `nuozi-pet` 条目的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `scale` | `0.55` | 精灵显示比例（atlas 单元 192×208） |
| `dadChance` | `0.15` | 空闲随机彩蛋的每次检查触发概率 |
| `dadCheckIntervalMs` | `30000` | 空闲彩蛋检查间隔（毫秒） |
| `errorHoldMs` | `3200` | 「握草」持续时间（毫秒） |

## 结构

- `index.js` — 宿主半：监听 Cordis 事件维护工作状态机；注册
  `GET /nuozi-pet/state`（no-store 快照）与 `/nuozi-pet/assets/*`
  （白名单、ETag、immutable 缓存）。
- `client.js` — 客户端半：注册 `shell.overlay` Slot，精灵动画（rAF 直写
  background-position）、状态机节拍（140ms）、拖拽与彩蛋逻辑；每秒轮询宿主快照。
- `assets/` — `atlas.png`（1536×2288, 8×11）＋ `grass.png`（握草关键帧）＋
  `dad-0..5.png`（空闲彩蛋 6 帧，已底对齐归一化画布）。
- `cordis.patch.yml` — bundle 注册片段：把该 `- insert` 条目并入你 profile 的
  `cordis.patch.yml`（并在 `dsh.profile.bundles` 中启用 `@local/nuozi-pet`）。

## 素材来源

官方交付包（sprite v2）中的 `final/spritesheet-extended-despilled.png` 与
`easter-eggs/` 两张彩蛋参考图（经切帧/降采样归一化）。

## 许可 / License

**Visual assets**（`assets/` 内全部素材，含图集与彩蛋图）— **CC BY-NC-ND 4.0 International**：

> You may share the original, unmodified assets for non-commercial purposes
> with proper attribution.
>
> You may not distribute modified, cropped, recolored, redrawn, rigged,
> animated, or otherwise derivative versions.
>
> Commercial use requires prior written permission.
>
> License: <https://creativecommons.org/licenses/by-nc-nd/4.0/>

**引用要求 / Attribution requirement**：任何形式的引用、转载、演示提及本工程或
其素材，都必须署名作者 **JP-Alan** 并附作者 GitHub 主页链接
**<https://github.com/JP-Shi>**（即 CC BY-NC-ND 中 “proper attribution” 的最低标准）。

**Source code** — © [JP-Alan](https://github.com/JP-Shi)，保留所有权利（All rights reserved）。

**特别许可 / Named exception** 🎓：作者明确允许 **中国科学技术大学 · 词元工坊（USTC TokenWorks）**
将该宠物（素材与代码）作为其产品与服务的内置形象使用并随附分发。本例外仅授予词元工坊，
不适用于其他任何第三方。

完整条款见 [LICENSE](LICENSE)。
