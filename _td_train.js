/*
 * _td_train.js —— afterstate TD(λ) 自博弈训练器（N-Tuple 4×8 / 6×8）
 * ==========================================================================
 * 【状态定义】V 定义在 afterstate（移动后、生成前）—— 文献标准（Jaśkowski 2012）。
 *   选动作 = argmax_a V(after(s,a))：无生成噪声，V 弱时也能自举策略。
 * 【更新】δ = R_t + γ·V(sA_{t+1}) − V(sA_t)（γ=1；死局 δ = R + B(s_dead) − V(sA_last)）
 *   标准 TD(λ) 资格迹：每步全部活跃迹衰减 e←λe，新访问槽 e+=1，
 *   然后对所有活跃槽 w += α_w·δ·e（α_w = α0/(1+visits·5e-4)，Robbins-Monro）。
 * 【终局奖励】B = (maxExp≥14 ? 10 : 0) + (maxExp≥13 ? 0.5 : 0)；
 *   单步奖励 R = 合并得分/1000（归一化，防权重爆炸）。
 * 【迹存储】4x8 用平铺数组（快）；6x8 用 Map（值 {e,v}，省 1.8GB 内存）。
 *
 * 用法:
 *   node _td_train.js --minutes 120 --seed 1 --out td_net_latest.bin [--resume] [--tuple 4x8|6x8]
 */
'use strict';

const { TDNet } = require('./_td_net.js');
const fs = require('fs');

// ---------- 自建 LUT ----------
const POW2 = new Float64Array(20);
for (let i = 0; i < 20; i++) POW2[i] = Math.pow(2, i);
const ROW_LUT_SIZE = 65536;
const SCORE_LUT = new Float64Array(ROW_LUT_SIZE);
const MOVE_LUT = new Uint16Array(ROW_LUT_SIZE);
const RIGHT_LUT = new Uint16Array(ROW_LUT_SIZE);
function slideRowLeft(row) {
  const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
  const t = []; if (c0) t.push(c0); if (c1) t.push(c1); if (c2) t.push(c2); if (c3) t.push(c3);
  const out = []; let gained = 0;
  for (let i = 0; i < t.length; i++) {
    if (i + 1 < t.length && t[i] === t[i + 1]) { const nv = t[i] + 1; out.push(nv); gained += POW2[nv]; i++; }
    else out.push(t[i]);
  }
  while (out.length < 4) out.push(0);
  return { row: (out[0] << 12) | (out[1] << 8) | (out[2] << 4) | out[3], gained };
}
function reverseRow(row) { return ((row & 0xF) << 12) | ((row & 0xF0) << 4) | ((row & 0xF00) >> 4) | ((row & 0xF000) >> 12); }
for (let r = 0; r < ROW_LUT_SIZE; r++) { const x = slideRowLeft(r); MOVE_LUT[r] = x.row; SCORE_LUT[r] = x.gained; }
for (let r = 0; r < ROW_LUT_SIZE; r++) RIGHT_LUT[r] = reverseRow(MOVE_LUT[reverseRow(r)]);

function moveBoard(lo, hi, dir) {
  let nlo = 0, nhi = 0, gained = 0, moved = false;
  if (dir === 0 || dir === 1) {
    for (let r = 0; r < 4; r++) {
      const row = r < 2 ? (lo >>> (16 * r)) & 0xFFFF : (hi >>> (16 * (r - 2))) & 0xFFFF;
      const nrow = dir === 0 ? MOVE_LUT[row] : RIGHT_LUT[row];
      if (nrow !== row) moved = true;
      gained += SCORE_LUT[row];
      if (r < 2) nlo |= nrow << (16 * r); else nhi |= nrow << (16 * (r - 2));
    }
  } else {
    for (let c = 0; c < 4; c++) {
      const sh = 12 - 4 * c;
      const col = (((lo >>> sh) & 0xF) << 12) | (((lo >>> (16 + sh)) & 0xF) << 8)
                | (((hi >>> sh) & 0xF) << 4)  | ((hi >>> (16 + sh)) & 0xF);
      const ncol = dir === 2 ? MOVE_LUT[col] : RIGHT_LUT[col];
      if (ncol !== col) moved = true;
      gained += SCORE_LUT[col];
      nlo |= ((ncol >>> 12) & 0xF) << sh;
      nlo |= ((ncol >>> 8) & 0xF) << (16 + sh);
      nhi |= ((ncol >>> 4) & 0xF) << sh;
      nhi |= (ncol & 0xF) << (16 + sh);
    }
  }
  return { lo: nlo >>> 0, hi: nhi >>> 0, gained, moved };
}

function hasMove(lo, hi) {
  for (let r = 0; r < 4; r++) {
    const row = r < 2 ? (lo >>> (16 * r)) & 0xFFFF : (hi >>> (16 * (r - 2))) & 0xFFFF;
    if (MOVE_LUT[row] !== row || RIGHT_LUT[row] !== row) return true;
  }
  for (let c = 0; c < 4; c++) {
    const sh = 12 - 4 * c;
    const col = (((lo >>> sh) & 0xF) << 12) | (((lo >>> (16 + sh)) & 0xF) << 8)
              | (((hi >>> sh) & 0xF) << 4)  | ((hi >>> (16 + sh)) & 0xF);
    if (MOVE_LUT[col] !== col || RIGHT_LUT[col] !== col) return true;
  }
  return false;
}

function maxExpOf(lo, hi) {
  let m = 0, r;
  r = lo & 0xFFFF;      { let v=(r>>>12)&0xF; if(v>m)m=v; v=(r>>>8)&0xF; if(v>m)m=v; v=(r>>>4)&0xF; if(v>m)m=v; v=r&0xF; if(v>m)m=v; }
  r = (lo>>>16)&0xFFFF; { let v=(r>>>12)&0xF; if(v>m)m=v; v=(r>>>8)&0xF; if(v>m)m=v; v=(r>>>4)&0xF; if(v>m)m=v; v=r&0xF; if(v>m)m=v; }
  r = hi & 0xFFFF;      { let v=(r>>>12)&0xF; if(v>m)m=v; v=(r>>>8)&0xF; if(v>m)m=v; v=(r>>>4)&0xF; if(v>m)m=v; v=r&0xF; if(v>m)m=v; }
  r = (hi>>>16)&0xFFFF; { let v=(r>>>12)&0xF; if(v>m)m=v; v=(r>>>8)&0xF; if(v>m)m=v; v=(r>>>4)&0xF; if(v>m)m=v; v=r&0xF; if(v>m)m=v; }
  return m;
}

function terminalBonus(lo, hi) {
  const mx = maxExpOf(lo, hi);
  return (mx >= 14 ? 10 : 0) + (mx >= 13 ? 0.5 : 0);
}

// ---------- RNG（状态可持久化） ----------
let RNG_STATE = 0;
function mulberryFrom(state) {
  RNG_STATE = state | 0;
  return function () {
    RNG_STATE = (RNG_STATE + 0x6D2B79F5) | 0;
    let t = Math.imul(RNG_STATE ^ (RNG_STATE >>> 15), 1 | RNG_STATE);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngStateOf() { return RNG_STATE >>> 0; }

// ---------- 资格迹（双实现） ----------
function makeArrayTrace(net) {   // 4x8：平铺数组，最快
  const N = net.nViews * net.viewSize;
  const ETRACE = new Float32Array(N);
  const ACTIVE = new Int32Array(N);
  const IN_ACTIVE = new Uint8Array(N);
  const VISITS = new Float64Array(N);
  let n = 0;
  return {
    decay() { for (let i = 0; i < n; i++) ETRACE[ACTIVE[i]] *= LAMBDA; },
    acc(idx8) {
      for (let v = 0; v < 8; v++) {
        const w = v * net.viewSize + idx8[v];
        ETRACE[w] += 1;
        if (!IN_ACTIVE[w]) { IN_ACTIVE[w] = 1; ACTIVE[n++] = w; }
      }
    },
    updateAll(delta, alphaEff) {
      for (let i = 0; i < n; i++) {
        const w = ACTIVE[i];
        VISITS[w] += 1;
        const aw = Math.min(alphaEff, alpha0Static) / (1 + VISITS[w] * 5e-4);
        let nw = net.WT[w] + aw * delta * ETRACE[w];
        if (nw > 30) nw = 30; else if (nw < -30) nw = -30;
        net.WT[w] = nw;
      }
    },
    reset() {
      for (let i = 0; i < n; i++) { ETRACE[ACTIVE[i]] = 0; IN_ACTIVE[ACTIVE[i]] = 0; }
      n = 0;
    }
  };
}
function makeMapTrace(net) {     // 6x8：Map（值 {e,v}），省内存
  const m = new Map();
  const S = net.viewSize;
  return {
    decay() { for (const it of m.values()) it.e *= LAMBDA; },
    acc(idx8) {
      for (let v = 0; v < 8; v++) {
        const w = v * S + idx8[v];
        const it = m.get(w);
        if (it) it.e += 1; else m.set(w, { e: 1, v: 0 });
      }
    },
    updateAll(delta, alphaEff) {
      for (const [w, it] of m) {
        it.v += 1;
        const aw = Math.min(alphaEff, alpha0Static) / (1 + it.v * 5e-4);
        let nw = net.WT[w] + aw * delta * it.e;
        if (nw > 30) nw = 30; else if (nw < -30) nw = -30;
        net.WT[w] = nw;
      }
    },
    reset() { m.clear(); }
  };
}

let LAMBDA = 0.9;
let alpha0Static = 0.01;
const IDX8 = new Int32Array(8);

// ---------- afterstate TD(λ) 单局 ----------
function playEpisode(net, cfg, rng, trace) {
  const gamma = cfg.gamma, alpha = cfg.alpha;
  let lo = 0, hi = 0;
  for (let k = 0; k < 2; k++) {
    let nEmp = 0; const emp = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
      const r = (i / 4) | 0, c = i % 4;
      const sh = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
      const w = r < 2 ? ((lo >>> sh) & 0xF) : ((hi >>> sh) & 0xF);
      if (w === 0) emp[nEmp++] = i;
    }
    const idx = emp[(rng() * nEmp) | 0];
    const rr = (idx / 4) | 0, cc = idx % 4;
    const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
    const e = rng() < 0.9 ? 1 : 2;
    if (rr < 2) lo = (lo | (e << sh)) >>> 0; else hi = (hi | (e << sh)) >>> 0;
  }
  trace.reset();
  let score = 0, steps = 0, absDeltaSum = 0, absDeltaN = 0;
  let prevIdx = null, prevR = 0;
  // SARSA 化（on-policy TD）：先选好本步动作（ε-greedy on V(afterstate)），target 用
  // 实际执行动作的 afterstate —— 无 max 算子、无过估计偏差
  let pendA = -1;                     // 本步待执行动作
  function greedyA(l, h) {
    let ba = -1, bv = -Infinity; const legal = [];
    for (let a = 0; a < 4; a++) {
      const mm = moveBoard(l, h, a);
      if (!mm.moved) continue;
      legal.push(a);
      const idx = net.views(mm.lo, mm.hi, IDX8);
      const v = net.valueByIdx(idx);
      if (v > bv) { bv = v; ba = a; }
    }
    if (ba < 0) return -1;
    if (rng() < cfg.eps) return legal[(rng() * legal.length) | 0];
    return ba;
  }
  pendA = greedyA(lo, hi);
  while (true) {
    if (pendA < 0) {
      // 死局（无合法动作）：上一个 afterstate 的 target = R_prev + B(死局盘)
      if (prevIdx) {
        const delta = prevR + gamma * terminalBonus(lo, hi) - net.valueByIdx(prevIdx);
        absDeltaSum += Math.abs(delta); absDeltaN++;
        trace.updateAll(delta, cfg.alphaEff);
      }
      break;
    }
    const m = moveBoard(lo, hi, pendA);
    const R = m.gained / 1000;
    score += m.gained; steps++;
    // 生成 → 下一个决策局面
    let nlo = m.lo, nhi = m.hi;
    let nEmp = 0; const empIdx = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
      const r = (i / 4) | 0, c = i % 4;
      const sh = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
      const w = r < 2 ? ((nlo >>> sh) & 0xF) : ((nhi >>> sh) & 0xF);
      if (w === 0) empIdx[nEmp++] = i;
    }
    if (nEmp > 0) {
      const i = empIdx[(rng() * nEmp) | 0];
      const rr = (i / 4) | 0, cc = i % 4;
      const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
      const e = rng() < 0.9 ? 1 : 2;
      if (rr < 2) nlo = (nlo | (e << sh)) >>> 0; else nhi = (nhi | (e << sh)) >>> 0;
    }
    lo = nlo; hi = nhi;
    // 全部活跃迹衰减，然后本步 afterstate 迹 +1
    trace.decay();
    const idxA = net.views(m.lo, m.hi, IDX8);
    trace.acc(idxA);
    const VA = net.valueByIdx(idxA);   // 更新前取值
    if (prevIdx) {
      // SARSA: δ_prev = R_prev + γ·V(sA_actual; w) − V(sA_prev; w)
      const delta = prevR + gamma * VA - net.valueByIdx(prevIdx);
      absDeltaSum += Math.abs(delta); absDeltaN++;
      trace.updateAll(delta, cfg.alphaEff);
    }
    prevIdx = Int32Array.from(idxA);
    prevR = R;
    if (!hasMove(lo, hi)) {
      // 生成后死局：终局更新
      const delta = prevR + gamma * terminalBonus(lo, hi) - net.valueByIdx(prevIdx);
      absDeltaSum += Math.abs(delta); absDeltaN++;
      trace.updateAll(delta, cfg.alphaEff);
      break;
    }
    pendA = greedyA(lo, hi);
  }
  trace.reset();
  return { score, steps, maxExp: maxExpOf(lo, hi), absDeltaSum, absDeltaN };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const cfg = { minutes: 120, seed: 1, alpha0: 0.01, alphaMin: 0.002, eps0: 0.10, epsMin: 0.02, lambda: 0.9, gamma: 1.0, out: 'td_net_latest.bin', resume: false, ckptSec: 1800, snapSec: 3600, tuple: '4x8' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--minutes') cfg.minutes = parseFloat(argv[++i]);
    else if (k === '--seed') cfg.seed = parseInt(argv[++i], 10);
    else if (k === '--alpha0') cfg.alpha0 = parseFloat(argv[++i]);
    else if (k === '--alphaMin') cfg.alphaMin = parseFloat(argv[++i]);
    else if (k === '--eps0') cfg.eps0 = parseFloat(argv[++i]);
    else if (k === '--epsMin') cfg.epsMin = parseFloat(argv[++i]);
    else if (k === '--lambda') cfg.lambda = parseFloat(argv[++i]);
    else if (k === '--gamma') cfg.gamma = parseFloat(argv[++i]);
    else if (k === '--out') cfg.out = argv[++i];
    else if (k === '--ckptSec') cfg.ckptSec = parseFloat(argv[++i]);
    else if (k === '--snapSec') cfg.snapSec = parseFloat(argv[++i]);
    else if (k === '--tuple') cfg.tuple = argv[++i];
    else if (k === '--resume') cfg.resume = true;
  }
  return cfg;
}

function main() {
  const cfg = parseArgs(process.argv);
  LAMBDA = cfg.lambda;
  alpha0Static = cfg.alpha0;
  let net = new TDNet(cfg.tuple);
  if (cfg.resume) {
    try {
      net = TDNet.load(cfg.out);
      if (!net.hasTrainingState) throw new Error('无训练状态块');
      if (net.tupleType !== cfg.tuple) throw new Error(`tupleType 不匹配: 文件 ${net.tupleType} vs 参数 ${cfg.tuple}`);
      console.log(`[resume] step=${net.step} games=${net.gamesDone} alpha=${net.alpha} rng=${net.rngState >>> 0}`);
    } catch (e) {
      console.log('[resume] 读取失败，从头训练:', e.message);
      net = new TDNet(cfg.tuple);
    }
  }
  const trace = net.tupleType === '6x8' ? makeMapTrace(net) : makeArrayTrace(net);
  const rng = mulberryFrom(net.rngState || cfg.seed);
  const t0 = Date.now();
  const END = t0 + cfg.minutes * 60000;
  let lastCkpt = t0, lastSnap = t0, lastLog = t0;
  let win = { n: 0, score: 0, maxExpCnt: {}, delta: 0, dn: 0, steps: 0 };
  let games = net.gamesDone, totalSteps = net.step;
  let benchGames = 0, benchT0 = Date.now(), benchMode = true;
  console.log(`[start] tuple=${net.tupleType} 权重内存 ${(net.WT.byteLength / 1048576).toFixed(0)}MB | 分钟=${cfg.minutes} out=${cfg.out}`);
  while (Date.now() < END) {
    if (benchMode && Date.now() - benchT0 >= 10000) {
      console.log(`[bench] 10 秒实测 ${(benchGames / 10).toFixed(1)} 局/秒（单进程）→ ${(cfg.minutes * 60 * benchGames / 10).toFixed(0)} 局/${cfg.minutes}分钟`);
      benchMode = false;
    }
    cfg.alpha = Math.max(cfg.alphaMin, cfg.alpha0 * Math.max(0, 1 - totalSteps / 3e9));
    cfg.eps = Math.max(cfg.epsMin, cfg.eps0 * Math.max(0, 1 - games / 3e6));
    cfg.alphaEff = Math.max(cfg.alphaMin, cfg.alpha0 / (1 + totalSteps / 1e7));   // 时间衰减兜底（稀疏槽场景防 max-bias 发散）
    const r = playEpisode(net, cfg, rng, trace);
    games++; totalSteps += r.steps;
    if (benchMode) benchGames++;
    win.n++; win.score += r.score; win.steps += r.steps;
    win.maxExpCnt[r.maxExp] = (win.maxExpCnt[r.maxExp] || 0) + 1;
    win.delta += r.absDeltaSum; win.dn += r.absDeltaN;
    const now = Date.now();
    if (now - lastLog >= 60000) {
      lastLog = now;
      const me = Object.entries(win.maxExpCnt).sort((a, b) => b[0] - a[0]).map(([k, v]) => `${Math.pow(2, k)}:${(v / win.n * 100).toFixed(1)}%`).join(' ');
      console.log(`[train] games=${games} steps=${totalSteps} | 窗口均分 ${(win.score / win.n).toFixed(0)} | 平均步 ${(win.steps / win.n).toFixed(0)} | 平均|δ| ${(win.delta / win.dn).toFixed(3)} | max|w| ${net.maxAbsW().toFixed(1)} | ${me} | ${((now - t0) / 60000).toFixed(1)}min`);
      win = { n: 0, score: 0, maxExpCnt: {}, delta: 0, dn: 0, steps: 0 };
    }
    if (now - lastCkpt >= cfg.ckptSec * 1000) {
      lastCkpt = now;
      net.step = totalSteps; net.gamesDone = games; net.rngState = rngStateOf(); net.alpha = cfg.alpha;
      net.save(cfg.out, true);
      console.log(`[ckpt] 已写 ${cfg.out} @ games=${games}`);
    }
    if (now - lastSnap >= cfg.snapSec * 1000) {
      lastSnap = now;
      net.step = totalSteps; net.gamesDone = games; net.rngState = rngStateOf();
      const p = `td6_net_ckpt_${games}.bin`;
      net.save(p, false);
      console.log(`[snap] 已写 ${p}`);
    }
  }
  net.step = totalSteps; net.gamesDone = games; net.rngState = rngStateOf(); net.alpha = cfg.alpha;
  net.save(cfg.out, true);
  console.log(`[done] 总局数 ${games} | 总步数 ${totalSteps} | 用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟 | 权重 ${cfg.out}`);
}

main();
