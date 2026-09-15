// 生成 _engine7_td.js：从 _engine7_prob.js 分叉，叶子评估加性融合 V_td（M2）
// 替换点：exitimax 内 depth=0 叶子 / 预算耗尽回退 / cprob 剪枝分支 的 evaluate → evaluateFused
const fs = require('fs');
let src = fs.readFileSync('_engine7_prob.js', 'utf8');

const patches = [
  ["const ENGINE_TAG = 'v7.3-prob';", "const ENGINE_TAG = 'v7.4-td';"],
  ["/*\n * 2048 引擎 v7.3prob —— 全展开 + 概率阈值剪枝 + 终盘加深 + 里程碑诊断",
   "/*\n * 2048 引擎 v7.4td —— prob 引擎 + N-Tuple/TD 价值函数加性融合（第Ⅲ轮研究）\n * 叶子评估变为 evaluateFused = V_hand + tdWeight·K·(V_td − mean)。\n * tdWeight=0 时与 v7.3prob 逐位等价（差分 T20 验证）。权重由 _td_net.js 提供。\n *\n * —— 以下为 v7.3prob 原始说明 ——"],

  // 1) depth=0 叶子
  ["function exitimax(lo, hi, depth, player, limit, cprob) {\n  if (depth === 0) return evaluate(lo, hi);\n  if (++NODE_COUNT > NODE_BUDGET) return evaluate(lo, hi);",
   "function exitimax(lo, hi, depth, player, limit, cprob) {\n  if (depth === 0) return evaluateFused(lo, hi);\n  if (++NODE_COUNT > NODE_BUDGET) return evaluateFused(lo, hi);"],

  // 2) cprob 剪枝分支
  ["        if (cut2) sum += p2 * evaluate(l2, h2);\n        else sum += p2 * exitimax(l2, h2, depth - 1, true, limit, cp2);\n        // 4 方块（10%）\n        if (cut4) sum += p4 * evaluate(l4, h4);\n        else sum += p4 * exitimax(l4, h4, depth - 1, true, limit, cp4);",
   "        if (cut2) sum += p2 * evaluateFused(l2, h2);\n        else sum += p2 * exitimax(l2, h2, depth - 1, true, limit, cp2);\n        // 4 方块（10%）\n        if (cut4) sum += p4 * evaluateFused(l4, h4);\n        else sum += p4 * exitimax(l4, h4, depth - 1, true, limit, cp4);"],

  // 3) 在 exitimax 定义之前注入 TD 集成块（evaluateFused 需在首次调用前定义；function 声明会提升，但依赖的 maxExpQuick/boardStats 亦需可用）
  ["// 全展开 + 概率阈值剪枝的随机节点；cprob = 到达本节点的累计概率\nfunction exitimax(",
   "// ---------- N-Tuple/TD 加性融合（_td_net.js 权重） ----------\nlet TD_NET = null;\nlet maxExpQuickBuf = null;\nfunction maxExpQuick(lo, hi) {\n  // 轻量 16 nibble 扫描\n  let m = 0, r;\n  r = lo & 0xFFFF;      { let v=(r>>>12)&0xF; if(v>m)m=v; v=(r>>>8)&0xF; if(v>m)m=v; v=(r>>>4)&0xF; if(v>m)m=v; v=r&0xF; if(v>m)m=v; }\n  r = (lo>>>16)&0xFFFF; { let v=(r>>>12)&0xF; if(v>m)m=v; v=(r>>>8)&0xF; if(v>m)m=v; v=(r>>>4)&0xF; if(v>m)m=v; v=r&0xF; if(v>m)m=v; }\n  r = hi & 0xFFFF;      { let v=(r>>>12)&0xF; if(v>m)m=v; v=(r>>>8)&0xF; if(v>m)m=v; v=(r>>>4)&0xF; if(v>m)m=v; v=r&0xF; if(v>m)m=v; }\n  r = (hi>>>16)&0xFFFF; { let v=(r>>>12)&0xF; if(v>m)m=v; v=(r>>>8)&0xF; if(v>m)m=v; v=(r>>>4)&0xF; if(v>m)m=v; v=r&0xF; if(v>m)m=v; }\n  return m;\n}\nfunction evaluateFused(lo, hi) {\n  const h = evaluate(lo, hi);\n  if (!TD_NET || P.tdWeight <= 0) return h;\n  if (P.tdBlendFrom > 0 && maxExpQuick(lo, hi) < P.tdBlendFrom) return h;\n  return TD_NET.fused(lo, hi, h);\n}\nfunction setTdNet(net) {\n  TD_NET = net;\n  if (TD_NET && !(TD_NET.K > 0)) {\n    // 无预存 K/mean（如未训练的零权重）时用随机盘校准兜底\n    TD_NET.calibrate(randomBoardsForCalibration, evaluate, 3000);\n  }\n}\n// 校准用随机棋盘提供器（与差分测试同款 realistic 分布）\nfunction randomBoardsForCalibration(cb) {\n  let s = 20260915 >>> 0;\n  const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };\n  for (let i = 0; i < 3000; i++) {\n    let lo = 0, hi = 0;\n    for (let c = 0; c < 16; c++) {\n      const e = rnd() < 0.42 ? 0 : 1 + Math.floor(Math.pow(rnd(), 2.0) * 13);\n      const sh = 4 * (c % 8);\n      if (c < 8) lo = (lo | (e << sh)) >>> 0; else hi = (hi | (e << sh)) >>> 0;\n    }\n    cb(lo >>> 0, hi >>> 0);\n  }\n}\n\n// 全展开 + 概率阈值剪枝的随机节点；cprob = 到达本节点的累计概率\nfunction exitimax("],

  // 4) 参数
  ["  wChain2: 0,\n  wChain2From: 12\n};",
   "  wChain2: 0,\n  wChain2From: 12,\n  // N-Tuple/TD 融合参数\n  tdWeight: 0,       // 总开关（0 = 纯手工 ≡ v7.3prob；1 = 用校准 K）\n  tdBlendFrom: 0,    // 仅 maxExp ≥ 该值时加 TD 项（0 = 全程混合）\n  tdNetPath: ''      // 权重文件路径（eval2 的 params JSON 注入用）\n};"],

  // 5) 导出
  ["module.exports = { playGame, setParams, getParams: () => P, evaluate, readCells, CELLS, bestMove, moveDir, setBoard: (l,h)=>{B_LO=l>>>0;B_HI=h>>>0;}, getBoard: ()=>({lo:B_LO,hi:B_HI}), countEmpty, getGain: () => G, setSeed, clearSeed, ENGINE_TAG };",
   "module.exports = { playGame, setParams, getParams: () => P, evaluate, evaluateFused, setTdNet, getTdNet: () => TD_NET, readCells, CELLS, bestMove, moveDir, setBoard: (l,h)=>{B_LO=l>>>0;B_HI=h>>>0;}, getBoard: ()=>({lo:B_LO,hi:B_HI}), countEmpty, getGain: () => G, setSeed, clearSeed, ENGINE_TAG };"]
];

for (const [from, to] of patches) {
  if (!src.includes(from)) { console.error('未找到替换目标:', JSON.stringify(from.slice(0, 80))); process.exit(1); }
  src = src.split(from).join(to);
}

// 头部 require _td_net 由调用方（eval2 worker）负责加载并 setTdNet 注入；引擎自身不 require，保持解耦
fs.writeFileSync('_engine7_td.js', src);
console.log('已生成 _engine7_td.js（', src.length, '字节）');
