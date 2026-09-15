// 实验批处理编排器：顺序运行各配置（每个配置内部 30 进程并行）
// 用法: node experiments/_run_batch.js <批次名>
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.resolve(__dirname, '..');
const BATCH = process.argv[2] || 'A';
const EVAL = path.join(__dirname, '_eval2.js');

const SEED_A = 1001;   // 主种子段：240 局 = 1001..1240
const SEED_B = 1001;   // 对照种子段：96 局 = 1001..1096（与主段前 96 局配对）

// [tag, engine, nproc, per, depth, limit, budget, params, seedBase]
const JOBS = {
  A: [
    ['base240',  '_engine7_baseline.js', 30, 8, 5, 6, 45000, null, SEED_A],
    ['ttfix240', '_engine7_ttfix.js',    30, 8, 5, 6, 45000, null, SEED_A]
  ],
  B: [
    ['risk005', '_engine7_risk.js', 30, 4, 5, 6, 45000, { riskLambda: 0.05, riskMode: 1, riskPhase: 12 }, SEED_B],
    ['risk010', '_engine7_risk.js', 30, 4, 5, 6, 45000, { riskLambda: 0.10, riskMode: 1, riskPhase: 12 }, SEED_B],
    ['risk020', '_engine7_risk.js', 30, 4, 5, 6, 45000, { riskLambda: 0.20, riskMode: 1, riskPhase: 12 }, SEED_B],
    ['sample1', '_engine7_ttfix.js', 30, 4, 5, 6, 45000, { sampleMode: 1 }, SEED_B],
    ['sample2', '_engine7_ttfix.js', 30, 4, 5, 6, 45000, { sampleMode: 2 }, SEED_B],
    ['phase96', '_engine7_phase.js', 30, 4, 5, 6, 45000, null, SEED_B]
  ],
  C: [
    ['inc240', '_engine7_incremental.js', 30, 8, 5, 6, 45000, null, SEED_A],
    ['inc_bench', '_engine7_incremental.js', 30, 2, 5, 6, 45000, { useMoveOrder: 0, useEvalMemo: 0 }, SEED_B]
  ],
  D: [
    ['nn240', '_engine7_nn.js', 30, 8, 5, 6, 45000, null, SEED_A],
    ['risk0005', '_engine7_risk.js', 30, 4, 5, 6, 45000, { riskLambda: 0.005, riskMode: 1, riskPhase: 12 }, SEED_B],
    ['risk001', '_engine7_risk.js', 30, 4, 5, 6, 45000, { riskLambda: 0.01, riskMode: 1, riskPhase: 12 }, SEED_B],
    ['incfold240', '_engine7_incremental.js', 30, 8, 5, 6, 45000, { useMoveOrder: 0, useEvalMemo: 0 }, SEED_A]
  ],
  E: [
    ['incfold_d6', '_engine7_incremental.js', 30, 8, 6, 6, 45000, { useMoveOrder: 0, useEvalMemo: 0 }, SEED_A],
    ['incfold_b65', '_engine7_incremental.js', 30, 8, 5, 6, 65000, { useMoveOrder: 0, useEvalMemo: 0 }, SEED_A],
    ['incfold_l8', '_engine7_incremental.js', 30, 8, 5, 8, 45000, { useMoveOrder: 0, useEvalMemo: 0 }, SEED_A]
  ],
  F: [
    ['probd5', '_engine7_prob.js', 30, 8, 5, 6, 200000, null, SEED_A],
    ['probd6', '_engine7_prob.js', 30, 8, 6, 6, 200000, null, SEED_A],
    ['probd6deep', '_engine7_prob.js', 30, 4, 6, 6, 200000, { deepOnMaxExp: 13 }, SEED_B]
  ],
  G: [
    ['dual30deep', '_engine7_prob.js', 30, 4, 6, 6, 200000, { dualBase: 3.0, deepOnMaxExp: 13 }, SEED_B],
    ['dual22deep', '_engine7_prob.js', 30, 4, 6, 6, 200000, { dualBase: 2.2, deepOnMaxExp: 13 }, SEED_B],
    ['dual30', '_engine7_prob.js', 30, 4, 6, 6, 200000, { dualBase: 3.0 }, SEED_B]
  ]
};

const jobs = JOBS[BATCH];
if (!jobs) { console.error('未知批次', BATCH); process.exit(1); }
const log = [];
for (const [tag, engine, nproc, per, depth, limit, budget, params, seedBase] of jobs) {
  const args = [EVAL, engine, String(nproc), String(per), String(depth), String(limit), String(budget), tag,
    params ? JSON.stringify(params) : 'null', seedBase === null ? 'null' : String(seedBase)];
  console.log(`\n>>> ${tag} (${engine} params=${JSON.stringify(params)})`);
  const t0 = Date.now();
  try {
    const out = execFileSync(NODE, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 1000 * 60 * 40 });
    console.log(out);
  } catch (e) {
    console.error(`任务 ${tag} 失败:`, e.status, e.stdout || '', e.stderr && e.stderr.slice ? String(e.stderr).slice(-800) : '');
  }
  log.push({ tag, engine, params, seedBase, sec: (Date.now() - t0) / 1000 });
}
fs.writeFileSync(path.join(__dirname, `_batch_${BATCH}_done.json`), JSON.stringify({ batch: BATCH, jobs: log, finished: new Date().toISOString() }, null, 1));
console.log(`\n批次 ${BATCH} 全部完成`);
