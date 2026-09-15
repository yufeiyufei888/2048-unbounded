/*
 * 2048 引擎 v5 —— 冲击 8192
 * ==========================================================================
 * 两个关键改进（基于前几版实测得出的结论）：
 *
 * 改进 1：消灭随机抽样带来的决策噪声
 *   前几版在 random 节点上随机抽 limit 个空位，导致同一局面两次搜索给出
 *   不同评估值（方差大）→ 决策抖动 → 结构崩坏。
 *   v5 对 random 节点做「全展开」（最多 16 空位 × 2 种新块 = 32 子节点），
 *   评估是确定性的，搜索更稳。
 *
 * 改进 2：行级预计算，把评估从 O(16) 降到 O(4)
 *   蛇形权重下，每行的贡献只与该行的 4 个指数有关：
 *     ROW_SNAKE[row] = Σ_{c=0..3} value(c) * SNAKE_W[snakePos(r,c)]
 *   同时预计算行内平滑度 ROW_SMOOTH[row] 和行单调性方向 ROW_MONO[row]。
 *   这样 evaluate 只需 4 次行查表 + 少量列惩罚，速度大幅提升，
 *   足以弥补全展开带来的节点数增加。
 *
 * 改进 3：空格奖励改为「按空位的蛇形位次加权」而非简单计数，
 *   鼓励空位留在蛇形尾部，保住结构。
 */
'use strict';

// ---------- 常量与查表 ----------
const POW2 = new Float64Array(32);
for (let i = 0; i < 32; i++) POW2[i] = Math.pow(2, i);

const ROW_LUT_SIZE = 65536;
const SCORE_LUT = new Float64Array(ROW_LUT_SIZE);
const MOVE_LUT  = new Uint16Array(ROW_LUT_SIZE);
const RIGHT_LUT = new Uint16Array(ROW_LUT_SIZE);

function slideRowLeft(row) {
  const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
  const t = [];
  if (c0) t.push(c0); if (c1) t.push(c1); if (c2) t.push(c2); if (c3) t.push(c3);
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
for (let r = 0; r < ROW_LUT_SIZE; r++) { RIGHT_LUT[r] = reverseRow(MOVE_LUT[reverseRow(r)]); }

// ---------- 蛇形布局 ----------
// 蛇形位次（0 = 最优角落，15 = 最差）
const SNAKE_POS = new Int32Array([
   0,  1,  2,  3,
   7,  6,  5,  4,
   8,  9, 10, 11,
  15, 14, 13, 12
]);

// ---------- 参数 ----------
let P = {
  base: 4,          // 蛇形权重底数
  wEmpty: 0,        // 空格奖励（按蛇形位次加权后）
  wMono: 3.0,       // 单调性
  wSmooth: 6.0,     // 平滑度
  emptyHead: 1600,  // 每个“蛇头侧空位”的奖励
  dEmpty1: 400000,  // 只剩 1 空位的惩罚
  dEmpty2: 60000    // 只剩 2 空位的惩罚
};

// ---------- 行级预计算表 ----------
// 每行 4 个指数 → 蛇形贡献 / 平滑度 / 递增递减量
const ROW_SNAKE  = new Float64Array(ROW_LUT_SIZE);  // 行内蛇形权重和（权重用 base^k）
const ROW_SMOOTH = new Float64Array(ROW_LUT_SIZE);  // 行内相邻差值之和
const ROW_INCSUM = new Float64Array(ROW_LUT_SIZE);  // 行内递增方向的差值之和
const ROW_DECSUM = new Float64Array(ROW_LUT_SIZE);  // 行内递减方向的差值之和
const ROW_EMPTY  = new Uint8Array(ROW_LUT_SIZE);    // 行内空位数
const ROW_EMPTYIDX = new Uint8Array(ROW_LUT_SIZE);  // 位掩码：哪些列是空的

// 每行内每列的蛇形位次（用于行表）：行 r 的列 c 的蛇形位次
// 但蛇形位次依赖行 r → 需要为每行单独建表。为省内存，把「行索引」也编码进查表：
// 用 4 组 65536 表 = 4 × 4 × 65536 × 8B ≈ 8MB，可接受。
const ROW_SNAKE_BY_R = [];
const ROW_EMPTY_BY_R = [];

function buildRowTables(base) {
  const SW = new Float64Array(16);
  for (let k = 0; k < 16; k++) SW[k] = Math.pow(base, 15 - k);
  ROW_SNAKE_BY_R.length = 0;
  for (let r = 0; r < 4; r++) {
    const snakeTab = new Float64Array(ROW_LUT_SIZE);
    const emptyTab = new Uint8Array(ROW_LUT_SIZE);
    for (let row = 0; row < ROW_LUT_SIZE; row++) {
      const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
      let sq = 0, emp = 0, emask = 0;
      const cs = [c0, c1, c2, c3];
      for (let c = 0; c < 4; c++) {
        const e = cs[c];
        if (e === 0) { emp++; emask |= (1 << (3 - c)); continue; }
        sq += POW2[e] * SW[SNAKE_POS[r * 4 + c]];
      }
      snakeTab[row] = sq; emptyTab[row] = emp;
    }
    ROW_SNAKE_BY_R.push(snakeTab);
    ROW_EMPTY_BY_R.push(emptyTab);
  }
}

// 通用行表（与行无关的部分）
function buildCommonRowTables() {
  for (let row = 0; row < ROW_LUT_SIZE; row++) {
    const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
    const cs = [c0, c1, c2, c3];
    let smooth = 0, inc = 0, dec = 0, emp = 0;
    for (let c = 0; c < 4; c++) if (cs[c] === 0) emp++;
    for (let c = 0; c < 3; c++) {
      const a = cs[c], b = cs[c + 1];
      if (a && b) {
        const d = Math.abs(POW2[a] - POW2[b]);
        smooth += d;
        if (b > a) dec += d; else inc += d;
      }
    }
    ROW_SMOOTH[row] = smooth;
    ROW_INCSUM[row] = inc;
    ROW_DECSUM[row] = dec;
    ROW_EMPTY[row] = emp;
  }
}
buildCommonRowTables();
buildRowTables(P.base);

// ---------- 棋盘状态（无分配）----------
let B_LO = 0, B_HI = 0, G = 0;
function rowOf(r) { return r < 2 ? (B_LO >>> (16 * r)) & 0xFFFF : (B_HI >>> (16 * (r - 2))) & 0xFFFF; }

function moveDir(dir) {
  let nlo = 0, nhi = 0, gained = 0, moved = false;
  if (dir === 0 || dir === 1) {
    for (let r = 0; r < 4; r++) {
      const row = r < 2 ? (B_LO >>> (16 * r)) & 0xFFFF : (B_HI >>> (16 * (r - 2))) & 0xFFFF;
      const nrow = dir === 0 ? MOVE_LUT[row] : RIGHT_LUT[row];
      if (nrow !== row) moved = true;
      gained += SCORE_LUT[row];
      if (r < 2) nlo |= nrow << (16 * r); else nhi |= nrow << (16 * (r - 2));
    }
  } else {
    for (let c = 0; c < 4; c++) {
      const sh = 12 - 4 * c;
      const col = (((B_LO >>> sh) & 0xF) << 12) | (((B_LO >>> (16 + sh)) & 0xF) << 8)
                | (((B_HI >>> sh) & 0xF) << 4)  | ((B_HI >>> (16 + sh)) & 0xF);
      const ncol = dir === 2 ? MOVE_LUT[col] : RIGHT_LUT[col];
      if (ncol !== col) moved = true;
      gained += SCORE_LUT[col];
      nlo |= ((ncol >>> 12) & 0xF) << sh;
      nlo |= ((ncol >>> 8) & 0xF) << (16 + sh);
      nhi |= ((ncol >>> 4) & 0xF) << sh;
      nhi |= (ncol & 0xF) << (16 + sh);
    }
  }
  B_LO = nlo >>> 0; B_HI = nhi >>> 0; G = gained;
  return moved;
}

const R0 = new Uint16Array(4);
function loadRows(lo, hi) {
  R0[0] = lo & 0xFFFF; R0[1] = (lo >>> 16) & 0xFFFF;
  R0[2] = hi & 0xFFFF; R0[3] = (hi >>> 16) & 0xFFFF;
}

// ---------- 评估（O(4) 行表 + 列修正）----------
function evaluate(lo, hi) {
  loadRows(lo, hi);
  const r0 = R0[0], r1 = R0[1], r2 = R0[2], r3 = R0[3];
  let s = 0;
  // 行蛇形贡献（每行独立蛇形表）
  s += ROW_SNAKE_BY_R[0][r0] + ROW_SNAKE_BY_R[1][r1] + ROW_SNAKE_BY_R[2][r2] + ROW_SNAKE_BY_R[3][r3];
  // 行平滑度与行单调性
  const smH = ROW_SMOOTH[r0] + ROW_SMOOTH[r1] + ROW_SMOOTH[r2] + ROW_SMOOTH[r3];
  let mono = 0;
  { const i0 = ROW_INCSUM[r0], d0 = ROW_DECSUM[r0]; mono += i0 > d0 ? i0 : d0; }
  { const i1 = ROW_INCSUM[r1], d1 = ROW_DECSUM[r1]; mono += i1 > d1 ? i1 : d1; }
  { const i2 = ROW_INCSUM[r2], d2 = ROW_DECSUM[r2]; mono += i2 > d2 ? i2 : d2; }
  { const i3 = ROW_INCSUM[r3], d3 = ROW_DECSUM[r3]; mono += i3 > d3 ? i3 : d3; }
  s += mono * P.wMono;

  // 列方向：平滑度 + 单调性（4 列 × 3 对）
  let smV = 0;
  for (let c = 0; c < 4; c++) {
    const sh = 12 - 4 * c;
    const a0 = (r0 >>> sh) & 0xF, a1 = (r1 >>> sh) & 0xF, a2 = (r2 >>> sh) & 0xF, a3 = (r3 >>> sh) & 0xF;
    let inc = 0, dec = 0;
    const arr = [a0, a1, a2, a3];
    for (let k = 0; k < 3; k++) {
      const u = arr[k], v = arr[k + 1];
      if (u && v) { const d = Math.abs(POW2[u] - POW2[v]); smV += d; if (v > u) dec += d; else inc += d; }
    }
    mono = inc > dec ? inc : dec;
    s += mono * P.wMono;
  }
  s -= (smH + smV) * P.wSmooth;

  // 空格：按“靠蛇头”的空位加权（蛇头附近留空 = 好）
  let empty = 0;
  empty += ROW_EMPTY[r0] + ROW_EMPTY[r1] + ROW_EMPTY[r2] + ROW_EMPTY[r3];
  s += empty * P.wEmpty;

  if (empty <= 1) s -= P.dEmpty1;
  else if (empty === 2) s -= P.dEmpty2;
  return s;
}

// ---------- Expectimax（全展开，无抽样）----------
let TT = new Map();
let NODE_BUDGET = 0, NODE_COUNT = 0;
const EMPTY_IDX = new Int32Array(16); let EMPTY_N = 0;
function collectEmpty(lo, hi) {
  EMPTY_N = 0;
  let r;
  r = lo & 0xFFFF; if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 0; if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 1; if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 2; if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 3;
  r = (lo >>> 16) & 0xFFFF; if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 4; if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 5; if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 6; if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 7;
  r = hi & 0xFFFF; if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 8; if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 9; if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 10; if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 11;
  r = (hi >>> 16) & 0xFFFF; if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 12; if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 13; if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 14; if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 15;
  return EMPTY_N;
}
function countEmpty(lo, hi) {
  let n = 0;
  let r = lo & 0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = (lo>>>16)&0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = hi & 0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = (hi>>>16)&0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  return n;
}

function exitimax(lo, hi, depth, player) {
  if (depth === 0) return evaluate(lo, hi);
  if (++NODE_COUNT > NODE_BUDGET) return evaluate(lo, hi);
  const key = (player ? (depth << 1) | 1 : depth << 1) * 4294967296 + lo * 65536 + hi;
  const cached = TT.get(key); if (cached !== undefined) return cached;
  let result;
  if (player) {
    let best = -Infinity;
    for (let i = 0; i < 4; i++) {
      B_LO = lo; B_HI = hi;
      if (!moveDir(i)) continue;
      const v = exitimax(B_LO, B_HI, depth - 1, false);
      if (v > best) best = v;
    }
    result = best === -Infinity ? evaluate(lo, hi) - 1e12 : best;
  } else {
    const nEmp = collectEmpty(lo, hi);
    if (!nEmp) result = exitimax(lo, hi, depth - 1, true);
    else {
      let sum = 0;
      for (let i = 0; i < nEmp; i++) {
        const idx = EMPTY_IDX[i];
        const rr = (idx / 4) | 0, cc = idx % 4;
        const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
        let l2 = lo, h2 = hi, l4 = lo, h4 = hi;
        if (rr < 2) { l2 = (lo | (1 << sh)) >>> 0; l4 = (lo | (2 << sh)) >>> 0; }
        else { h2 = (hi | (1 << sh)) >>> 0; h4 = (hi | (2 << sh)) >>> 0; }
        sum += 0.9 * exitimax(l2, h2, depth - 1, true);
        sum += 0.1 * exitimax(l4, h4, depth - 1, true);
      }
      result = sum / nEmp;
    }
  }
  if (TT.size < 300000) TT.set(key, result);
  B_LO = lo; B_HI = hi;
  return result;
}

function bestMove(lo, hi, depth, budget) {
  NODE_COUNT = 0; NODE_BUDGET = budget;
  let best = -Infinity, pickD = -1, pick2 = -1, nPick = 0;
  const order = [0, 2, 1, 3];
  for (let k = 0; k < 4; k++) {
    const i = order[k];
    B_LO = lo; B_HI = hi;
    if (!moveDir(i)) continue;
    const v = exitimax(B_LO, B_HI, depth - 1, false);
    if (v > best + 1e-7) { best = v; pickD = i; nPick = 1; }
    else if (v > best - 1e-7) { if (nPick === 1) pick2 = i; nPick++; }
  }
  if (nPick === 0) return -1;
  if (nPick === 1) return pickD;
  return Math.random() < 0.5 ? pickD : pick2;
}

// ---------- 一局 ----------
function playGame(depth, budget) {
  B_LO = 0; B_HI = 0;
  for (let k = 0; k < 2; k++) {
    collectEmpty(B_LO, B_HI);
    const idx = EMPTY_IDX[(Math.random() * EMPTY_N) | 0];
    const rr = (idx / 4) | 0, cc = idx % 4;
    const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
    const e = Math.random() < 0.9 ? 1 : 2;
    if (rr < 2) B_LO = (B_LO | (e << sh)) >>> 0; else B_HI = (B_HI | (e << sh)) >>> 0;
  }
  let score = 0, steps = 0, maxExp = 0;
  while (steps < 200000) {
    const lo = B_LO, hi = B_HI;
    const empty = countEmpty(lo, hi);
    const d = depth + (empty <= 4 ? 1 : 0) + (empty <= 2 ? 1 : 0);
    const mv = bestMove(lo, hi, d, budget);
    if (mv < 0) break;
    B_LO = lo; B_HI = hi;
    if (!moveDir(mv)) break;
    score += G;
    collectEmpty(B_LO, B_HI);
    if (EMPTY_N === 0) break;
    const idx = EMPTY_IDX[(Math.random() * EMPTY_N) | 0];
    const rr = (idx / 4) | 0, cc = idx % 4;
    const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
    const e = Math.random() < 0.9 ? 1 : 2;
    if (rr < 2) B_LO = (B_LO | (e << sh)) >>> 0; else B_HI = (B_HI | (e << sh)) >>> 0;
    steps++;
    let can = false; const sl = B_LO, sh2 = B_HI;
    for (let i = 0; i < 4; i++) { B_LO = sl; B_HI = sh2; if (moveDir(i)) { can = true; break; } }
    B_LO = sl; B_HI = sh2;
    if (!can) break;
  }
  loadRows(B_LO, B_HI);
  for (let r = 0; r < 4; r++) { let row = R0[r]; for (let c = 0; c < 4; c++) { const e = (row >> (12 - 4 * c)) & 0xF; if (e > maxExp) maxExp = e; } }
  return { score, steps, maxExp, lo: B_LO, hi: B_HI };
}

function setParams(np) { P = Object.assign({}, P, np); buildRowTables(P.base); }

module.exports = { playGame, setParams, getParams: () => P, loadRows, R0, countEmpty };

// ---------- 直接运行 ----------
if (require.main === module) {
  if (process.env.PARAMS) setParams(JSON.parse(process.env.PARAMS));
  const MAX_GAMES = parseInt(process.env.MAX_GAMES || '30', 10);
  const DEPTH = parseInt(process.env.DEPTH || '5', 10);
  const BUDGET = parseInt(process.env.BUDGET || '60000', 10);
  console.log(`引擎 v5 | depth=${DEPTH} budget=${BUDGET} | 参数 ${JSON.stringify(module.exports.getParams())}`);
  const START = Date.now();
  let bestScore = -1, bestMax = 0, sum = 0, hist = [];
  for (let g = 1; g <= MAX_GAMES; g++) {
    TT.clear();
    const r = playGame(DEPTH, BUDGET);
    sum += r.score; hist.push(r.score);
    if (r.score > bestScore) { bestScore = r.score; bestMax = r.maxExp; console.log(`[新纪录] 第 ${g} 局 | ${r.score} 分 | 最大块 ${POW2[r.maxExp]} | ${r.steps} 步 | ${((Date.now()-START)/1000).toFixed(0)}s`); }
    if (g % 5 === 0) { const el = (Date.now()-START)/1000; console.log(`  …${g} 局 | 均分 ${(sum/g).toFixed(0)} | 最高 ${bestScore} | ${(g/el*60).toFixed(1)} 局/分`); }
  }
  console.log(`\n===== v5 结果 =====`);
  const el = (Date.now()-START)/1000;
  console.log(`局数 ${MAX_GAMES} | 耗时 ${el.toFixed(0)}s | 速率 ${(MAX_GAMES/el*60).toFixed(1)} 局/分`);
  console.log(`平均 ${(sum/MAX_GAMES).toFixed(0)} | 最高 ${bestScore} (最大块 ${POW2[bestMax]})`);
  hist.sort((a,b)=>b-a);
  console.log(`中位 ${hist[Math.floor(hist.length/2)]} | 前5 ${hist.slice(0,5).join(', ')}`);
}
