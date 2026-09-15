# 2048 Unbounded · 无上限 2048 AI 研究工作台

**Unbounded 2048 (no merge cap) with a high-throughput Expectimax AI, a seeded/paired experiment framework, and 4,100+ real-simulation games of strategy research — including a verified transposition-table collision fix and a structural analysis of why 8192→16384 fails.**

无上限 4×4 2048（合并规则 `value *= 2`，2048 之后继续合成 4096 / 8192 / 16384 / 32768…）
+ 极速 Expectimax AI + 可复现实验框架 + 4,144 局真实模拟的策略研究。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node.js-22%2B-green)
![Games](https://img.shields.io/badge/simulated%20games-4%2C144-blue)

## 🎮 立即体验

| 文件 | 说明 |
|---|---|
| [`2048.html`](2048.html) | 单文件可玩正式版：方向键 / 触摸、动画、计分、**合并无上限**，8192/16384/32768 显示清晰 |
| [`2048-play.html`](2048-play.html) | AI 实时观战版：浏览器内自动对局（指数蛇形策略），速度可调 |
| [`report.html`](report.html) | **完整研究报告**：四代引擎进化、Bug 追因、实验矩阵、16384 瓶颈证据链 |

## 🏆 当前最强配置（配对种子实测）

| 场景 | 引擎与参数 | 实测结果 |
|---|---|---|
| 冲棋力/纪录 | `_engine7_prob.js` `{deepOnMaxExp:13}` · depth=6 · budget=200k | **均分 85,406 · 8192 达成率 30.0% · 早崩 0.0%** |
| 均衡 | `_engine7_incremental.js` · depth=6 · budget=45k | 均分 84,225 · 8192 率 32.1%（240 局最高）· 最高分 177,184 |
| 海量统计 | `_engine7_incremental.js` · depth=5 · budget=45k | 均分 72,741 · **150 局/分**（30 进程） |

## 📊 核心研究发现

1. **转置表键冲突 Bug（已实证并修复）**
   旧 key `depthTerm×2³² + lo×65536 + hi` 存在跨棋盘碰撞（构造示例 + 20 万随机棋盘实证），
   会静默污染搜索。修复方案 = 平坦 `Uint32Array` 精确键 TT（类似 nneonneo/2048-ai 的 C++ 做法），
   棋力持平的同时吞吐 +45%。

2. **depth 是唯一有效棋力杠杆**
   240 局大样本翻案：depth=6 把 8192 达成率从 15.0% 提升到 32.1%、均分 +15.8%。
   而 `limit` 与 `budget` 参数在当前引擎结构下**从不生效**（配对实验逐位一致证明）——
   旧报告的两组对照结论实为同义反复。

3. **16384 结构性不可达（指数蛇形 + depth≤7 框架内）**
   96 局到达 8192 的游戏 100% 呈现同一失败模式：**第二个 8192 出现率 0%**、
   死局 0% 存在大方块相邻对、首个 8192 后平均存活 ~1,800 步仍无法重爬第二条链。
   三个对症实验（评价尺度重整 / 分段评价切换 / 终盘加深）分别给出
   "无效 / 有害 / 有效但非突破"的定量结论——事后干预无法挽回合并瞬间的布局锁死。
   打破需要 **4096→8192 合并前的双链规划 = 价值函数学习**（N-Tuple/TD 方向）。

4. **其它定量结论**：风险敏感 Expectimax 在本游戏结构性失败（下行风险规避与"不押注无法升级"冲突）；
   无重复分层采样优于有放回（−53%）与加权采样（−23%）；
   动作排序 + 叶子 memo 有害（8192 率 15%→3.3%）。

## 🧪 可复现实验框架

```bash
# 种子化并行评估（30 进程 × 8 局，seed 1001..1240）
node experiments/_eval2.js _engine7_incremental.js 30 8 6 6 45000 mytag null 1001

# 跨引擎同种子配对比较（t 统计）
node experiments/_compare.js results/A.games.json results/B.games.json A B

# 34 项差分测试（moveDir/evaluate/种子复现/TT 隔离/死局…）
node experiments/_difftest.js

# 8192→16384 里程碑诊断
node experiments/_analyze_diag.js results/probd6.diag.json
```

特点：mulberry32 种子注入（同参数同种子逐局可复现）；跨引擎同种子配对降低运气方差；
每组实验记录完整元数据（引擎/参数/seed 范围/达成率/早崩率/吞吐）写入 `results/<tag>.json`。

## 📁 目录结构

```
2048.html 2048-play.html   可玩 / AI 观战（纯前端单文件）
report.html                研究报告（推荐从这开始读）
_engine7*.js               引擎家族：baseline / ttfix / risk / phase / incremental / nn / prob
_engine2~6.js              历代引擎（进化史）
experiments/               评估器、配对比较、差分测试、诊断分析、批处理编排
results/                   全部实验结果 JSON（4,144 局逐局数据）
summary（experiments/summary.txt）  实验结论速览
```

## 🙏 参考

- [nneonneo/2048-ai](https://github.com/nneonneo/2048-ai)（C++ BitBoard Expectimax，平坦 TT 与概率阈值剪枝思路来源）
- Expectimax / 蛇形权重启发式等经典 2048 AI 方法论

## 📄 License

[MIT](LICENSE) © yufeiyufei888
