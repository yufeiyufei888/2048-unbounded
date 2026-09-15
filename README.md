# 2048 Unbounded · 无上限 2048 AI 研究工作台

**Unbounded 2048 (no merge cap) with a high-throughput Expectimax AI, a seeded/paired experiment framework, and 5,000+ real-simulation games of strategy research — a verified transposition-table collision fix, coordinate-descent parameter evolution that broke the 16384 barrier, and an N-Tuple/TD learning pipeline.**

无上限 4×4 2048（合并规则 `value *= 2`，2048 之后继续合成 4096 / 8192 / 16384 / 32768…）
+ 极速 Expectimax AI + 可复现实验框架 + 5,000+ 局真实模拟的四轮策略研究。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node.js-22%2B-green)
![Games](https://img.shields.io/badge/simulated%20games-5%2C000%2B-blue)
![16384](https://img.shields.io/badge/16384-achieved%20%E2%9C%93-success)

## 🎮 立即体验

| 文件 | 说明 |
|---|---|
| [`2048.html`](2048.html) | 单文件可玩正式版：方向键 / 触摸、动画、计分、**合并无上限**，8192/16384/32768 显示清晰 |
| [`2048-play.html`](2048-play.html) | AI 实时观战版：浏览器内自动对局（指数蛇形策略），速度可调 |
| [`report.html`](report.html) | **完整研究报告**：四代引擎进化、Bug 追因、16384 破零历程、TD 学习管线 |

## 🏆 当前最强配置（v7.4 · 配对种子实测）

| 指标 | 基线 | **v7.4（wEmpty=80000）** |
|---|---|---|
| 平均分 | 85,406 | **89,923**（独立种子段复验） |
| **16384 达成** | 0%（5,000+ 局从未出现） | **1.7% 破零**（两段 240 局共 3 局） |
| 最高分 | 169,160 | **266,748**（三破纪录） |
| 8192 达成率 | 30.0% | 33.3% |

```bash
node experiments/_eval2.js _engine7_prob.js 30 4 6 6 200000 myrun "{\"deepOnMaxExp\":13,\"wEmpty\":80000}" 1001
```

## 📊 核心研究发现（四轮）

1. **转置表键冲突 Bug（已实证并修复）**
   旧 key `depthTerm×2³² + lo×65536 + hi` 存在跨棋盘碰撞（构造示例 + 20 万随机棋盘实证），
   会静默污染搜索。修复 = 平坦 `Uint32Array` 精确键 TT，棋力持平、吞吐 +45%。

2. **depth 是唯一有效的搜索杠杆**
   240 局大样本：depth=6 把 8192 率从 15% 提到 32%；d7/d8 与 limit/budget 参数在当前结构下**从不生效**（配对实验逐位一致证明）。

3. **参数进化破零 16384（第Ⅳ轮里程碑）**
   对 6 个评价参数做坐标下降（20 配置 × 120 局配对种子）：**`wEmpty` 60000→80000 使 16384 从「5,000+ 局结构性不可达」变为 1.7% 达成**，最高分三破纪录（266,748）。
   完整效应表证明手工加性修正项在此评价尺度下结构性无效——**改变权重 = 改变策略本身**（印证 nneonneo 的 CMA-ES 路线）。

4. **N-Tuple/TD 价值函数学习管线（已建成）**
   afterstate TD(λ) + 每权重自适应步长 + 4-tuple/6-tuple 双网络（512MB 6×16⁶ 视图）；
   训练调参完整记录（奖励归一化 / 状态定义 / max 算子过估计 / γ=1 自引用无界值四连教训）。
   4-tuple 权重与全部 checkpoint 已留档，6-tuple 长训练框架就绪。

5. **理论极限分析**
   4×4 无上限 2048 数学最大方块 = **131072 (2¹⁷)**（15 格完美塔 + 1 格生成恰好凑满 16 格；2¹⁸ 需 17 格不可达）；
   本引擎 4-bit 编码实现上限 = 32768。

## 🧪 可复现实验框架

```bash
# 种子化并行评估（30 进程，逐局记录 seed）
node experiments/_eval2.js _engine7_prob.js 30 4 6 6 200000 mytag "{\"deepOnMaxExp\":13,\"wEmpty\":80000}" 1001

# 跨引擎同种子配对比较（t 统计）
node experiments/_compare.js results/A.games.json results/B.games.json A B

# 45 项差分测试（moveDir/evaluate/种子复现/TT 隔离/TD 网络…）
node experiments/_difftest.js

# 参数坐标下降进化（第Ⅳ轮 16384 破零的工具）
node experiments/_evolve.js

# 8192→16384 里程碑诊断
node experiments/_analyze_diag.js results/probd6.diag.json
```

特点：mulberry32 种子注入（同参数同种子逐局可复现）；跨引擎同种子配对降低运气方差；
每组实验记录完整元数据写入 `results/<tag>.json`；TD 权重二进制 checkpoint 支持续训。

## 📁 目录结构

```
2048.html 2048-play.html   可玩 / AI 观战（纯前端单文件）
report.html                研究报告（推荐从这开始读）
_engine7*.js               引擎家族：baseline / ttfix / risk / phase / incremental / nn / prob / td
_td_net.js _td_train.js    N-Tuple/TD 学习管线（4x8 与 6x8 网络）
experiments/               评估器、配对比较、差分测试（45 项）、参数进化、诊断分析
results/                   全部实验结果 JSON（5,000+ 局逐局数据）
experiments/summary.txt    实验结论速览
```

## 🙏 参考

- [nneonneo/2048-ai](https://github.com/nneonneo/2048-ai)（C++ BitBoard Expectimax，平坦 TT、概率剪枝与权重元优化思路来源）
- Expectimax / 蛇形权重启发式 / afterstate TD(λ) 等经典方法论

## 📄 License

[MIT](LICENSE) © yufeiyufei888
