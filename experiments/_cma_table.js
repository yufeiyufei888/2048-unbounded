/*
 * _cma_table.js —— 查表权重 sep-CMA-ES 进化器（第Ⅵ轮核心）
 * ==========================================================================
 * 进化对象：5 张表（R0-R3 行表 + T 列表）× 65536 = 327,680 维 Float64
 * 策略：(μ, λ)-ES + 表级乘性扰动 + 1/5 成功规则自适应
 *   - 每代表 e 一个 σ_rel（乘性扰动 w' = w × (1 + σ_e·N(0,1))，保号、保量级结构）
 *   - 适应度 = _engine8_es.js（查表引擎，≡v7.4 起点已验证）× 60 局种子化均分
 *   - 同代 λ 个体同种子（配对），跨代换种子（防过拟合单段）
 *   - μ ← top-4 逐元素均值；σ_e ← 1/5 规则（进步 ×1.15 / 停滞 ×0.88，夹 [0.01,0.15]）
 *   - 基准个体 μ 每代评估一次（观测代际进步）
 * 用法: node experiments/_cma_table.js --generations 15 --lambda 12 --sigma0 0.04 [--resume]
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const ROOT = path.resolve(__dirname, '..');
const EVAL = path.join(__dirname, '_eval2.js');
const TDIR = path.join(ROOT, 'evolve_tables');
const LOGF = path.join(ROOT, 'cma_evolve.txt');
function LOG(msg) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
  try { process.stdout.write(line + '\n'); } catch (e) {}
  try { fs.appendFileSync(LOGF, line + '\n'); } catch (e) {}
}
const N = 5 * 65536;

function parseArgs(argv) {
  const cfg = { generations: 15, lambda: 12, elite: 4, gamesPer: 2, nproc: 30, sigma0: 30000, resume: false, seed0: 20001 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--generations') cfg.generations = parseInt(argv[++i], 10);
    else if (k === '--lambda') cfg.lambda = parseInt(argv[++i], 10);
    else if (k === '--elite') cfg.elite = parseInt(argv[++i], 10);
    else if (k === '--gamesPer') cfg.gamesPer = parseInt(argv[++i], 10);
    else if (k === '--nproc') cfg.nproc = parseInt(argv[++i], 10);
    else if (k === '--sigma0') cfg.sigma0 = parseFloat(argv[++i]);
    else if (k === '--seed0') cfg.seed0 = parseInt(argv[++i], 10);
    else if (k === '--resume') cfg.resume = true;
  }
  return cfg;
}

function loadState() {
  const mu = new Float64Array(N);
  const sig = new Float64Array(5).fill(0);
  if (fs.existsSync(path.join(TDIR, 'current.bin'))) {
    const buf = fs.readFileSync(path.join(TDIR, 'current.bin'));
    mu.set(new Float64Array(buf.buffer, buf.byteOffset, N));
  } else throw new Error('缺少初始表 evolve_tables/current.bin');
  if (fs.existsSync(path.join(TDIR, 'es_state.json'))) {
    const st = JSON.parse(fs.readFileSync(path.join(TDIR, 'es_state.json'), 'utf8'));
    sig.set(st.sig);
    return { mu, sig, gen: st.gen, history: st.history || [] };
  }
  return { mu, sig, gen: 0, history: [] };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function evalTable(muArr, tag, seedBase, gamesPer, nproc) {
  // 写 current.bin + meta → execFileSync eval2 → 读结果
  const full = new Float64Array(10 * 65536);
  full.set(muArr, 5 * 65536);   // 后 5 槽 = Δ 表
  fs.writeFileSync(path.join(TDIR, 'current.bin'), Buffer.from(full.buffer));
  fs.writeFileSync(path.join(TDIR, 'current.bin.meta.json'), JSON.stringify({ dEmpty1: 400000, dEmpty2: 60000 }));
  try {
    execFileSync(NODE, [EVAL, '_engine8_es.js', String(nproc), String(gamesPer), '6', '6', '45000', tag, 'null', String(seedBase)],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 1000 * 60 * 25 });
  } catch (e) {
    LOG(`评估 ${tag} 失败:`, (e.stdout || '').slice(-200));
    return null;
  }
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'results', tag + '.json'), 'utf8'));
}

function main() {
  const cfg = parseArgs(process.argv);
  const { mu, sig, gen: startGen, history } = loadState();
  if (startGen === 0 && sig[0] === 0) {
    sig.fill(cfg.sigma0);
    LOG(`[init] σ_rel 初始化 = ${cfg.sigma0}`);
  }
  if (cfg.resume && startGen > 0) LOG(`[resume] 从第 ${startGen} 代继续`);
  const rng = mulberry32(cfg.seed0);
  let bestEver = history.length ? history[history.length - 1].bestEver : -Infinity;
  const muCopy = mu.slice();
  // 基准评估（μ 起点）
  const baseRes = evalTable(mu, 'es_gen0_mu', cfg.seed0, cfg.gamesPer, cfg.nproc);
  if (baseRes) {
    bestEver = Math.max(bestEver, baseRes.avg);
    LOG(`[gen0-mu] 基准均分 ${baseRes.avg} | 16384 ${(baseRes.targetRates['16384'] * 100).toFixed(1)}%`);
    history.push({ gen: 0, muAvg: baseRes.avg, best: baseRes.avg, bestEver, sig: sig.slice().slice(0, 5).join(',') });
  }
  for (let gen = startGen; gen < cfg.generations; gen++) {
    const seed = cfg.seed0 + 137 + gen * 991;
    const fits = [];
    for (let k = 0; k < cfg.lambda; k++) {
      // 采样个体：逐表乘性扰动（Box-Muller 高斯）
      const ind = mu.slice();
      for (let t = 0; t < 5; t++) {
        const se = sig[t];
        const off = t * 65536;
        for (let i = 0; i < 65536; i++) {
          const u1 = Math.max(rng(), 1e-12), u2 = rng();
          const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          ind[off + i] = mu[off + i] + se * gauss;   // 加性扰动（Δ 量级 1e4-1e6，与决策粒度同阶）
        }
      }
      const r = evalTable(ind, `es_g${gen}_i${k}`, seed, cfg.gamesPer, cfg.nproc);
      if (r) fits.push({ ind, avg: r.avg });
      LOG(`[gen${gen} i${k}] 均分 ${r ? r.avg : 'FAIL'}`);
    }
    if (fits.length < 2) { LOG('[abort] 本代有效个体不足'); break; }
    fits.sort((a, b) => b.avg - a.avg);
    // ★ μ 更新（正确 CMA-ES 语义）：μ ← μ + lr × Σ wk·(ind_k − μ)
    //   【第Ⅵ轮教训】直接 top-4 均值 = μ 每代随机游走 σ/2 量级——蛇形主项 1e14
    //   的随机位移（±5e12）会累积破坏评价结构（gen1-3 崩到 8,000 的根因）。
    //   lr 加权位移让 μ 沿「精英一致方向」保守移动。
    const eliteN = Math.min(cfg.elite, fits.length);
    const wts = [0.4, 0.3, 0.2, 0.1].slice(0, eliteN);
    const wsum = wts.reduce((a, b) => a + b, 0);
    const lr = 0.25;   // 学习率（保守位移步长）
    for (let i = 0; i < N; i++) {
      let shift = 0;
      for (let k = 0; k < eliteN; k++) shift += wts[k] * (fits[k].ind[i] - mu[i]);
      mu[i] = mu[i] + lr * (shift / wsum);
    }
    // σ 自适应（1/5 规则，按表）
    const genBest = fits[0].avg;
    const improved = genBest > bestEver;
    for (let t = 0; t < 5; t++) {
      sig[t] = improved ? Math.min(300000, sig[t] * 1.15) : Math.max(5000, sig[t] * 0.88);
    }
    bestEver = Math.max(bestEver, genBest);
    LOG(`[gen${gen}] best=${genBest.toFixed(0)} muPrev=${baseRes ? baseRes.avg : '?'} bestEver=${bestEver.toFixed(0)} sig=${sig.slice(0, 5).map(v => v.toFixed(3)).join('/')} ${improved ? '↑' : '→'}`);
    history.push({ gen: gen + 1, best: genBest, bestEver, sig: sig.join(','), improved });
    // checkpoint
    fs.writeFileSync(path.join(TDIR, 'es_state.json'), JSON.stringify({ gen: gen + 1, sig: Array.from(sig), history }, null, 1));
    fs.writeFileSync(path.join(TDIR, `gen_${gen + 1}.bin`), Buffer.from(mu.buffer, mu.byteOffset, mu.byteLength));
    // 下一代的基准评估（μ 已更新）
    const baseNext = evalTable(mu, `es_gen${gen + 1}_mu`, seed, cfg.gamesPer, cfg.nproc);
    if (baseNext) {
      bestEver = Math.max(bestEver, baseNext.avg);
      LOG(`[gen${gen + 1}-mu] 新 μ 基准均分 ${baseNext.avg} | 16384 ${(baseNext.targetRates['16384'] * 100).toFixed(1)}%`);
      history.push({ gen: gen + 1, muAvg: baseNext.avg, bestEver });
    }
  }
  LOG(`[done] 进化完成 | bestEver=${bestEver.toFixed(0)}`);
}

main();
