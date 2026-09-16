/*
 * _evolve.js —— A 线：评价参数坐标下降进化（配对种子）
 * ==========================================================================
 * 引擎口径：_engine7_prob.js {deepOnMaxExp:13} depth6/limit6/budget200k
 * 每配置 120 局（种子 1001..1120，与基线 probd6deep 直接配对可比）。
 * 基线：results/probd6deep.json（均分 85,405.8，30.0% 8192）。
 * 接受准则：均分 − 基线 > +3,000（≈1×SE）记为候选改进。
 * 断点续跑：results/evolve_<tag>.json 存在则跳过。
 * 用法: node experiments/_evolve.js [--only tag1,tag2]
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.resolve(__dirname, '..');
const EVAL = path.join(__dirname, '_eval2.js');
const OUTDIR = path.join(ROOT, 'results');

const BASELINE = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'probd6deep.json'), 'utf8'));

// 14 配置：每参数双向单侧扫描 + base 细粒度
const CONFIGS = [
  ['evolve_base_44',   { base: 4.4 }],
  ['evolve_base_46',   { base: 4.6 }],
  ['evolve_base_445',  { base: 4.45 }],
  ['evolve_base_455',  { base: 4.55 }],
  ['evolve_wEmpty_40k', { wEmpty: 40000 }],
  ['evolve_wEmpty_80k', { wEmpty: 80000 }],
  ['evolve_wMono_2',   { wMono: 2.0 }],
  ['evolve_wMono_4',   { wMono: 4.0 }],
  ['evolve_wSmooth_4', { wSmooth: 4.0 }],
  ['evolve_wSmooth_8', { wSmooth: 8.0 }],
  ['evolve_dEmpty1_300k', { dEmpty1: 300000 }],
  ['evolve_dEmpty1_500k', { dEmpty1: 500000 }],
  ['evolve_dEmpty2_45k', { dEmpty2: 45000 }],
  ['evolve_dEmpty2_75k', { dEmpty2: 75000 }],
  // 第 2 轮延伸（基于第 1 轮效应：wEmpty 正向过线+16384 破零、base 负向更优）
  ['evolve_base_435',   { base: 4.35 }],
  ['evolve_base_43',    { base: 4.3 }],
  ['evolve_wEmpty_100k', { wEmpty: 100000 }],
  ['evolve_wEmpty_120k', { wEmpty: 120000 }],
  ['evolve_combo_b44e80',  { base: 4.4, wEmpty: 80000 }],
  ['evolve_combo_b44e100', { base: 4.4, wEmpty: 100000 }],
  // ===== 第 2 轮（背景 wEmpty=80k，重扫全部参数的交互效应）=====
  ['e2_dEmpty2_90k',  { dEmpty2: 90000 }],
  ['e2_dEmpty2_75k',  { dEmpty2: 75000 }],
  ['e2_base_44',      { base: 4.4 }],
  ['e2_base_46',      { base: 4.6 }],
  ['e2_wSmooth_4',    { wSmooth: 4.0 }],
  ['e2_wSmooth_8',    { wSmooth: 8.0 }],
  ['e2_wMono_2',      { wMono: 2.0 }],
  ['e2_wMono_4',      { wMono: 4.0 }],
  ['e2_dEmpty1_500k', { dEmpty1: 500000 }],
  ['e2_dEmpty1_300k', { dEmpty1: 300000 }],
  // ===== 第 3 轮（nneonneo 借鉴项：merges/sum-pow/mono-min/distinct-depth，背景 wEmpty=80k）=====
  ['e3_dd',      { depthDistinct: 1 }],
  ['e3_wM_8',    { wMergePair: 1e8 }],
  ['e3_wM_10',   { wMergePair: 1e10 }],
  ['e3_wS_8',    { wSum2: 1e8 }],
  ['e3_wS_10',   { wSum2: 1e10 }],
  ['e3_mM',      { monoMinMode: 1 }],
  ['e3_dd_ws8',  { depthDistinct: 1, wSmooth: 8.0 }],
  ['e3_ws8_mM',  { wSmooth: 8.0, monoMinMode: 1 }]
];
const bgIdx = process.argv.indexOf('--bgJSON');
const BG = bgIdx > 0 ? JSON.parse(process.argv[bgIdx + 1]) : null;
const baseIdx = process.argv.indexOf('--baseline');
const BASE_AVG = baseIdx > 0 ? parseFloat(process.argv[baseIdx + 1]) : BASELINE.avg;
const COMMON = Object.assign({ deepOnMaxExp: 13 }, BG || {});

const onlyArg = process.argv.find((a, i) => process.argv[i - 1] === '--only');
const onlySet = onlyArg ? new Set(onlyArg.split(',')) : null;
// --bgJSON '{"wEmpty":80000}'：背景参数（合入所有配置的 COMMON）；--baseline N：自定义基线均分
if (BG) console.log('>>> 背景参数:', JSON.stringify(BG), '| 基线均分:', BASE_AVG);

const results = [];
for (const [tag, params] of CONFIGS) {
  if (onlySet && !onlySet.has(tag)) continue;
  const outFile = path.join(OUTDIR, `${tag}.json`);
  if (fs.existsSync(outFile)) {
    console.log(`>>> 跳过 ${tag}（已完成）`);
    const j = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    results.push({ tag, params: Object.assign({}, COMMON, params), avg: j.avg, n: j.n, targetRates: j.targetRates, earlyRate: j.earlyRate, delta: j.avg - BASE_AVG });
    continue;
  }
  const fullParams = Object.assign({}, COMMON, params);
  console.log(`\n>>> ${tag} params=${JSON.stringify(params)} (基线 ${BASE_AVG})`);
  const t0 = Date.now();
  try {
    const out = execFileSync(NODE, [EVAL, '_engine7_prob.js', '30', '4', '6', '6', '200000', tag,
      JSON.stringify(fullParams), '1001'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 1000 * 60 * 30 });
    process.stdout.write(out);
  } catch (e) {
    console.error(`任务 ${tag} 失败:`, e.status, e.stdout || '');
    continue;
  }
  const j = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  results.push({ tag, params: fullParams, avg: j.avg, n: j.n, targetRates: j.targetRates, earlyRate: j.earlyRate, delta: j.avg - BASE_AVG, sec: (Date.now() - t0) / 1000 });
  // 即时汇总（断点安全）
  fs.writeFileSync(path.join(OUTDIR, 'evolve_summary.json'), JSON.stringify({ baseline: { tag: 'probd6deep', avg: BASE_AVG, params: BASELINE.params }, results }, null, 1));
}

// 最终汇总
console.log('\n===== 参数进化效应表（基线均分 ' + BASE_AVG + '）=====');
results.sort((a, b) => b.delta - a.delta);
for (const r of results) {
  const acc = r.delta > 3000 ? '✓候选改进' : (r.delta > -1000 ? '≈噪声' : '✗更差');
  console.log(`  ${r.tag.padEnd(22)} 均分 ${String(r.avg).padStart(7)} | Δ ${String(r.delta >= 0 ? '+' : '') + r.delta.toFixed(0).padStart(6)} | ${acc} | 8192 ${(r.targetRates['8192'] * 100).toFixed(1)}%`);
}
const winners = results.filter(r => r.delta > 3000);
fs.writeFileSync(path.join(OUTDIR, 'evolve_summary.json'), JSON.stringify({
  baseline: { tag: 'probd6deep', avg: BASE_AVG, params: BASELINE.params },
  acceptRule: 'Δavg > +3000 (≈1×SE@120局)',
  results,
  winners: winners.map(w => ({ tag: w.tag, params: w.params, delta: w.delta }))
}, null, 1));
console.log(`\n完成：${results.length}/${CONFIGS.length} 配置 | 候选改进 ${winners.length} 个 → 组合复验需将 winners 参数合并后用种子段 2001 复跑`);
