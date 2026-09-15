/*
 * 可复现并行评估器（任务2）
 * 用法:
 *   node experiments/_eval2.js <引擎> <进程数> <每进程局数> <depth> <limit> <budget> <标签> [JSON参数] [seedBase]
 * 说明:
 *   - 每局 seed = seedBase + workerIdx*perProc + i → 局数集合与进程布局无关，
 *     相同 seedBase 的两次实验按 seed 一一配对（引擎间对照减少运气方差）。
 *   - seedBase 省略时保持完全随机（不传 seed，行为与旧评估器一致）。
 *   - 输出 results/<tag>.json（汇总+完整元数据）与 results/<tag>.games.json（逐局原始数据）。
 */
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTDIR = path.join(ROOT, 'results');
if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

const engine = process.argv[2] || '_engine7_baseline.js';
const NPROC = parseInt(process.argv[3] || '30', 10);
const PER = parseInt(process.argv[4] || '8', 10);
const DEPTH = parseInt(process.argv[5] || '5', 10);
const LIMIT = parseInt(process.argv[6] || '6', 10);
const BUDGET = parseInt(process.argv[7] || '45000', 10);
const TAG = process.argv[8] || 'exp';
const PARAMS = process.argv[9] && process.argv[9] !== 'null' ? JSON.parse(process.argv[9]) : null;
const SEEDBASE = process.argv[10] !== undefined && process.argv[10] !== 'null' ? parseInt(process.argv[10], 10) : null;
const PARAMS_SRC = JSON.stringify(PARAMS);

const workerFile = path.join(__dirname, `_ew2_${TAG}.js`);
fs.writeFileSync(workerFile, `
const path = require('path');
const E = require(path.resolve(process.cwd(), ${JSON.stringify(engine)}));
const PARAMS = ${PARAMS_SRC};
if (PARAMS) E.setParams(PARAMS);
const PER = ${PER}, DEPTH = ${DEPTH}, LIMIT = ${LIMIT}, BUDGET = ${BUDGET};
const SEEDBASE = ${SEEDBASE === null ? 'null' : SEEDBASE};
const wIdx = parseInt(process.env.WIDX || '0', 10);
const out = [];
for (let i = 0; i < PER; i++) {
  const seed = SEEDBASE === null ? null : (SEEDBASE + wIdx * PER + i);
  const r = E.playGame(DEPTH, LIMIT, BUDGET, seed);
  out.push({ s: r.score, st: r.steps, mx: r.maxExp, seed, diag: r.diag || null });
}
process.send(out);
`);

const all = [];
let done = 0;
const START = Date.now();
const children = [];

function median(arr) { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

function finish() {
  const el = (Date.now() - START) / 1000;
  if (!all.length) { console.log(`[${TAG}] 无数据`); process.exit(1); }
  const scores = all.map(x => x.s).sort((a, b) => b - a);
  const steps = all.map(x => x.st);
  const maxExps = all.map(x => x.mx).sort((a, b) => a - b);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const early = steps.filter(x => x < 800).length / steps.length;
  const targetRates = {};
  for (const t of [11, 12, 13, 14, 15]) targetRates[String(Math.pow(2, t))] = maxExps.filter(x => x >= t).length / maxExps.length;
  const seedMin = SEEDBASE === null ? null : SEEDBASE;
  const seedMax = SEEDBASE === null ? null : SEEDBASE + NPROC * PER - 1;
  const res = {
    tag: TAG, engine, engineTag: null, n: all.length,
    depth: DEPTH, limit: LIMIT, budget: BUDGET,
    params: PARAMS || '(引擎默认)',
    seedBase: SEEDBASE, seedRange: SEEDBASE === null ? null : [seedMin, seedMax],
    avg: Math.round(avg * 10) / 10,
    median: scores[Math.floor(scores.length / 2)],
    p90: scores[Math.floor(scores.length * 0.1)],
    best: scores[0], worst: scores[scores.length - 1], top5: scores.slice(0, 5),
    maxTile: Math.pow(2, maxExps[maxExps.length - 1]),
    medianMaxTile: Math.pow(2, maxExps[Math.floor(maxExps.length / 2)]),
    targetRates,
    earlyRate: Math.round(early * 10000) / 10000,
    avgSteps: Math.round(steps.reduce((a, b) => a + b, 0) / steps.length),
    medianSteps: median(steps),
    elapsedSec: Math.round(el * 10) / 10,
    gamesPerMin: Math.round(all.length / el * 600) / 10,
    procs: NPROC, node: process.version,
    timestamp: new Date().toISOString()
  };
  fs.writeFileSync(path.join(OUTDIR, `${TAG}.json`), JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(OUTDIR, `${TAG}.games.json`), JSON.stringify(all.map(x => ({ seed: x.seed, score: x.s, steps: x.st, maxExp: x.mx }))));
  if (all.some(x => x.diag)) {
    fs.writeFileSync(path.join(OUTDIR, `${TAG}.diag.json`), JSON.stringify(all.map(x => ({ seed: x.seed, score: x.s, steps: x.st, maxExp: x.mx, diag: x.diag }))));
  }
  const rates = Object.entries(targetRates).map(([tile, rate]) => `${tile}:${(rate * 100).toFixed(1)}%`).join(' ');
  console.log(`[${TAG}] n=${res.n} 均分 ${res.avg} 中位 ${res.median} 最高 ${res.best} 最大块 ${res.maxTile} 中位块 ${res.medianMaxTile} 早崩 ${(early * 100).toFixed(1)}% | ${res.elapsedSec}s ${res.gamesPerMin}局/分`);
  console.log(`  达成率: ${rates}`);
  console.log(`  top5: ${res.top5.join(', ')}`);
  children.forEach(c => { try { c.kill(); } catch (e) {} });
  process.exit(0);
}

let launched = 0;
for (let p = 0; p < NPROC; p++) {
  const c = fork(workerFile, [], {
    env: Object.assign({}, process.env, { WIDX: String(p) }),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: ['--max-old-space-size=768']
  });
  children.push(c);
  c.on('message', (arr) => { all.push(...arr); done++; if (done === NPROC) finish(); });
  c.on('exit', (code) => { if (code !== 0 && done < NPROC) console.error(`worker ${p} 退出码 ${code}`); });
  launched++;
}
setTimeout(() => { if (done < NPROC && all.length) { console.log('超时兜底汇总'); finish(); } }, 1000 * 60 * 60);
