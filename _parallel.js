// 并行长跑器：多进程各跑独立局数，主进程汇总
// 用法: node _parallel.js <引擎文件> <进程数> <每进程局数> <depth> <limit> <budget>
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const engine = process.argv[2] || '_e7fix.js';
const NPROC = parseInt(process.argv[3] || '16', 10);
const PER = parseInt(process.argv[4] || '50', 10);
const DEPTH = parseInt(process.argv[5] || '5', 10);
const LIMIT = parseInt(process.argv[6] || '6', 10);
const BUDGET = parseInt(process.argv[7] || '45000', 10);
const TAG = process.argv[8] || 'v7';

const workerSrc = `
const E = require('./${engine}');
const per = ${PER}, depth = ${DEPTH}, limit = ${LIMIT}, budget = ${BUDGET};
const out = [];
for (let i = 0; i < per; i++) {
  const r = E.playGame(depth, limit, budget);
  out.push({ score: r.score, steps: r.steps, maxExp: r.maxExp });
}
process.send(out);
`;
fs.writeFileSync('_worker.js', workerSrc);

const all = [];
let done = 0;
const START = Date.now();
const OUT = `_parallel_${TAG}.json`;

function dump() {
  const scores = all.map(x => x.score).sort((a, b) => b - a);
  const bestRec = all.slice().sort((a, b) => b.score - a.score)[0] || {};
  fs.writeFileSync(OUT, JSON.stringify({
    engine, tag: TAG, depth: DEPTH, limit: LIMIT, budget: BUDGET,
    games: all.length, procs: NPROC,
    avg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
    median: scores[Math.floor(scores.length / 2)] || 0,
    best: scores[0] || 0,
    bestSteps: bestRec.steps || 0,
    bestMax: bestRec.maxExp ? Math.pow(2, bestRec.maxExp) : 0,
    top10: scores.slice(0, 10),
    elapsedSec: (Date.now() - START) / 1000,
    finished: done === NPROC,
    perGame: all.map(x => x.score)
  }, null, 1));
}

for (let p = 0; p < NPROC; p++) {
  const child = fork('_worker.js', [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=1024'] });
  child.on('message', (arr) => {
    all.push(...arr);
    done++;
    dump();
    const scores = all.map(x => x.score).sort((a, b) => b - a);
    const el = (Date.now() - START) / 1000;
    console.log(`[${done}/${NPROC}] 累计 ${all.length} 局 | 均分 ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(0)} | 最高 ${scores[0]} | ${el.toFixed(0)}s | ${(all.length / el * 60).toFixed(0)} 局/分`);
    if (done === NPROC) { child.kill(); process.exit(0); }
  });
  child.on('exit', (code) => { if (code !== 0 && done < NPROC) console.log('worker 退出码', code); });
}
