// 生成 _engine7_phase.js：ttfix + 高阶阶段化评估参数默认开启（复刻 phaseD96 参数）
const fs = require('fs');
let src = fs.readFileSync('_engine7_ttfix.js', 'utf8');

const patches = [
  ["const ENGINE_TAG = 'v7.2-ttfix';", "const ENGINE_TAG = 'v7.2-phase';"],
  ["  phaseExp: 12,\n  wMobility: 0,\n  wMerge: 0,\n  wCorner: 0,\n  wDeadEnd: 0,",
   "  phaseExp: 14,\n  wMobility: 200000,\n  wMerge: 5,\n  wCorner: 100000,\n  wDeadEnd: 100000,"],
  ["/*\n * 2048 引擎 v7.2tt —— v7.1 基线 + 转置表键冲突修复（平坦类型数组 TT）",
   "/*\n * 2048 引擎 v7.2phase —— ttfix + 高阶阶段化评估默认开启（实验分支）\n * 参数复刻此前 phaseD96 实验：phaseExp=14, wMobility=200000, wMerge=5,\n * wCorner=100000, wDeadEnd=100000。此前 96 局结果弱于基线（65,471 vs 79,514），\n * 本分支仅作为实验保留并复测。"]
];
for (const [from, to] of patches) {
  if (!src.includes(from)) { console.error('未找到替换目标:', JSON.stringify(from.slice(0, 60))); process.exit(1); }
  src = src.split(from).join(to);
}
fs.writeFileSync('_engine7_phase.js', src);
console.log('已生成 _engine7_phase.js');
