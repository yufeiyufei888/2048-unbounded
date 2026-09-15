// 快速并行评估（先写结果再退出，避免僵死）
// 用法: node _eval.js <引擎> <进程数> <每进程局数> <depth> <limit> <budget> [标签] [JSON参数]
const { fork } = require('child_process');
const fs = require('fs');

const engine = process.argv[2] || '_d.js';
const NPROC = parseInt(process.argv[3] || '16', 10);
const PER = parseInt(process.argv[4] || '12', 10);
const DEPTH = parseInt(process.argv[5] || '5', 10);
const LIMIT = parseInt(process.argv[6] || '6', 10);
const BUDGET = parseInt(process.argv[7] || '45000', 10);
const TAG = process.argv[8] || 'base';
const PARAMS = process.argv[9] ? JSON.parse(process.argv[9]) : null;
const PARAMS_SRC = PARAMS ? JSON.stringify(PARAMS) : 'null';

const WORKER_FILE = `_ew_${TAG}.js`;
fs.writeFileSync(WORKER_FILE, `
const E = require('./${engine}');
const PARAMS = ${PARAMS_SRC};
if (PARAMS) E.setParams(PARAMS);
const out = [];
for (let i = 0; i < ${PER}; i++) {
  const r = E.playGame(${DEPTH}, ${LIMIT}, ${BUDGET});
  out.push({ s: r.score, st: r.steps, mx: r.maxExp });
}
process.send(out);
`);

const all = [];
let done = 0, exited = 0;
const START = Date.now();
const children = [];

function finish() {
  const s = all.map(x => x.s).sort((a, b) => b - a);
  if (!s.length) { console.log(TAG, '无数据'); process.exit(1); }
  const steps = all.map(x => x.st);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  const el = (Date.now() - START) / 1000;
  const early = steps.filter(x => x < 800).length / steps.length;
  const maxExps = all.map(x => x.mx).sort((a, b) => a - b);
  const maxTile = maxExps[maxExps.length - 1];
  const targetRates = {};
  for (const target of [11, 12, 13, 14, 15]) {
    targetRates[String(Math.pow(2, target))] = maxExps.filter(x => x >= target).length / maxExps.length;
  }
  const res = {
    tag: TAG, engine, n: all.length, avg, median: s[Math.floor(s.length / 2)],
    best: s[0], top5: s.slice(0, 5), maxTile: Math.pow(2, maxTile),
    medianMaxTile: Math.pow(2, maxExps[Math.floor(maxExps.length / 2)]),
    targetRates, earlyRate: early, elapsedSec: el, depth: DEPTH, limit: LIMIT, budget: BUDGET,
    params: PARAMS || {}
  };
  fs.writeFileSync(`_res_${TAG}.json`, JSON.stringify(res, null, 1));
  const rates = Object.entries(targetRates).map(([tile, rate]) => `${tile}:${(rate * 100).toFixed(0)}%`).join(' ');
  console.log(`[${TAG}] n=${all.length} 均分 ${avg.toFixed(0)} 中位 ${res.median} 最高 ${s[0]} 最大块 ${res.maxTile} 中位块 ${res.medianMaxTile} 早崩率 ${(early * 100).toFixed(0)}% ${el.toFixed(0)}s`);
  console.log(`  达成率: ${rates}`);
  console.log(`  top5: ${s.slice(0, 5).join(', ')}`);
  process.exit(0);
}

for (let p = 0; p < NPROC; p++) {
  const c = fork(WORKER_FILE, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=768'] });
  children.push(c);
  c.on('message', (arr) => { all.push(...arr); done++; if (done === NPROC) finish(); });
  c.on('exit', () => { exited++; if (exited === NPROC && done < NPROC && all.length) finish(); });
}
process.on('SIGTERM', () => { children.forEach(c => c.kill()); if (all.length) finish(); });
