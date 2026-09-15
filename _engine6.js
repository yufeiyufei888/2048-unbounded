/*
 * 2048 引擎 v6 —— 修正的排序式评估（目标：稳定上 8192）
 * ==========================================================================
 * 前面 v3~v5 的共同病根（已定位）：
 *   评估用「数值 × 位置指数权重」（如 2^e × 4^(15-k)），
 *   导致左上角一个大块就占全部得分的 75%，
 *   其余 15 格的取舍差异只有 1e-4 量级 → 搜索对这些差异不敏感 →
 *   除了“保住那个大块”，其它决策近似随机 → 盘面结构崩坏。
 *
 * v6 的修正（关键）：
 *   不再用数值做权重，而是奖励「沿蛇形路径指数单调不增」。
 *   定义：对蛇形路径上相邻两格 (a,b)，若 exp(a) >= exp(b) 则加分，
 *         加分幅度 = 1（等值/递减都算良好），违序则重罚。
 *   这样每个格子的贡献都是 O(1) 量级，结构信息不会被某一个块淹没。
 *
 *   同时保留：
 *     - 空格奖励（按蛇形位次加权，鼓励空位留在蛇尾）
 *     - 平滑度（相邻差，用指数差而非数值差 → 尺度一致）
 *     - 最大块必须贴左上角
 *     - 危险惩罚
 */
'use strict';

const POW2 = new Float64Array(32);
for (let i = 0; i < 32; i++) POW2[i] = Math.pow(2, i);

// ---------- 行 LUT ----------
const ROW_LUT_SIZE = 65536;
const SCORE_LUT = new Float64Array(ROW_LUT_SIZE);
const MOVE_LUT  = new Uint16Array(ROW_LUT_SIZE);
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
for (let r = 0; r < ROW_LUT_SIZE; r++) { RIGHT_LUT[r] = reverseRow(MOVE_LUT[reverseRow(r)]); }

// ---------- 蛇形路径（0 最优）----------
const SNAKE_POS = new Int32Array([
   0,  1,  2,  3,
   7,  6,  5,  4,
   8,  9, 10, 11,
  15, 14, 13, 12
]);
// 蛇形路径的相邻对（沿路径依次相连）
const SNAKE_PATH = [];   // 路径上物理格索引序列
for (let k = 0; k < 16; k++) {
  for (let i = 0; i < 16; i++) if (SNAKE_POS[i] === k) { SNAKE_PATH.push(i); break; }
}

// ---------- 棋盘 ----------
let B_LO = 0, B_HI = 0, G = 0;
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

const CELLS = new Int32Array(16);
function readCells(lo, hi) {
  for (let r = 0; r < 4; r++) {
    const row = r < 2 ? (lo >>> (16 * r)) & 0xFFFF : (hi >>> (16 * (r - 2))) & 0xFFFF;
    CELLS[r*4] = (row >> 12) & 0xF; CELLS[r*4+1] = (row >> 8) & 0xF; CELLS[r*4+2] = (row >> 4) & 0xF; CELLS[r*4+3] = row & 0xF;
  }
  return CELLS;
}

// ---------- 参数 ----------
let P = {
  wSnake: 100,      // 蛇形有序奖励（每对相邻格）
  wDisorder: 700,   // 违序惩罚（每对）
  wEmpty: 700,      // 每空位奖励
  wMono: 10,        // 全局单调性（用指数差）
  wSmooth: 180,     // 平滑度惩罚（指数差）
  wCorner: 600,     // 最大块不贴角惩罚系数
  dEmpty1: 260000,
  dEmpty2: 16000,
  bigBoost: 200     // 大块（>=256）按指数额外加权，鼓励合大块
};
function setParams(np) { P = Object.assign({}, P, np); }

// 预计算：物理格 -> 蛇形位次
const POSOF = SNAKE_POS; // POSOF[i] = 蛇形位次

function evaluate(lo, hi) {
  readCells(lo, hi);
  const c = CELLS;
  let s = 0, empty = 0, maxExp = 0, maxPos = 0;

  // 1) 蛇形有序性：沿路径相邻，(前) >= (后) 得奖励，否则惩罚
  for (let k = 0; k < 15; k++) {
    const ia = SNAKE_PATH[k], ib = SNAKE_PATH[k + 1];
    const ea = c[ia], eb = c[ib];
    if (ea === 0 && eb === 0) continue;
    if (ea >= eb) s += P.wSnake;
    else s -= P.wDisorder * (eb - ea);   // 违序越严重罚越多
  }

  // 2) 空格 + 大块统计
  for (let i = 0; i < 16; i++) {
    const e = c[i];
    if (e === 0) { empty++; continue; }
    if (e > maxExp) { maxExp = e; maxPos = i; }
    if (e >= 8) s += e * P.bigBoost;      // 256 以上额外奖励，推动合大块
  }
  s += empty * P.wEmpty;

  // 3) 单调性（行 + 列），用指数差
  let mono = 0;
  for (let r = 0; r < 4; r++) {
    let inc = 0, dec = 0;
    for (let j = 0; j < 3; j++) { const a = c[r*4+j], b = c[r*4+j+1]; if (a && b) { const d = Math.abs(a - b); if (b > a) dec += d; else inc += d; } }
    mono += inc > dec ? inc : dec;
  }
  for (let col = 0; col < 4; col++) {
    let inc = 0, dec = 0;
    for (let r = 0; r < 3; r++) { const a = c[r*4+col], b = c[(r+1)*4+col]; if (a && b) { const d = Math.abs(a - b); if (b > a) dec += d; else inc += d; } }
    mono += inc > dec ? inc : dec;
  }
  s += mono * P.wMono;

  // 4) 平滑度（指数差）
  let smooth = 0;
  for (let r = 0; r < 4; r++) for (let j = 0; j < 3; j++) { const a = c[r*4+j], b = c[r*4+j+1]; if (a && b) smooth += Math.abs(a - b); }
  for (let col = 0; col < 4; col++) for (let r = 0; r < 3; r++) { const a = c[r*4+col], b = c[(r+1)*4+col]; if (a && b) smooth += Math.abs(a - b); }
  s -= smooth * P.wSmooth;

  // 5) 最大块贴角
  if (maxPos !== 0) {
    const dist = ((maxPos / 4) | 0) + (maxPos % 4);
    s -= P.wCorner * (maxExp - 6) * dist;   // 只在 maxExp>=7 时明显
  }

  // 6) 危险
  if (empty <= 1) s -= P.dEmpty1;
  else if (empty === 2) s -= P.dEmpty2;

  return s;
}

// ---------- Expectimax ----------
const DIRS = [0, 1, 2, 3];
let TT = new Map();
let NODE_BUDGET = 0, NODE_COUNT = 0;
const EMPTY_IDX = new Int32Array(16); let EMPTY_N = 0;
function collectEmpty(lo, hi) {
  EMPTY_N = 0;
  let r;
  r = lo & 0xFFFF;        if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 0;  if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 1;  if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 2;  if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 3;
  r = (lo >>> 16) & 0xFFFF; if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 4;  if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 5;  if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 6;  if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 7;
  r = hi & 0xFFFF;        if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 8;  if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 9;  if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 10; if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 11;
  r = (hi >>> 16) & 0xFFFF; if (!(r & 0xF000)) EMPTY_IDX[EMPTY_N++] = 12; if (!(r & 0x0F00)) EMPTY_IDX[EMPTY_N++] = 13; if (!(r & 0x00F0)) EMPTY_IDX[EMPTY_N++] = 14; if (!(r & 0x000F)) EMPTY_IDX[EMPTY_N++] = 15;
  return EMPTY_N;
}
function countEmpty(lo, hi) {
  let n = 0, r;
  r = lo & 0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = (lo>>>16)&0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = hi & 0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = (hi>>>16)&0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  return n;
}

function exitimax(lo, hi, depth, player, limit) {
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
      const cl = B_LO, ch = B_HI;
      const v = exitimax(cl, ch, depth - 1, false, limit);
      if (v > best) best = v;
    }
    result = best === -Infinity ? evaluate(lo, hi) - 1e9 : best;
  } else {
    const nEmp = collectEmpty(lo, hi);
    if (!nEmp) result = exitimax(lo, hi, depth - 1, true, limit);
    else {
      const cap = depth >= 5 ? limit : (limit > 10 ? limit : 10);
      const n = nEmp > cap ? cap : nEmp;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const idx = EMPTY_IDX[(Math.random() * nEmp) | 0];
        const rr = (idx / 4) | 0, cc = idx % 4;
        const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
        let l2 = lo, h2 = hi, l4 = lo, h4 = hi;
        if (rr < 2) { l2 = (lo | (1 << sh)) >>> 0; l4 = (lo | (2 << sh)) >>> 0; }
        else { h2 = (hi | (1 << sh)) >>> 0; h4 = (hi | (2 << sh)) >>> 0; }
        sum += 0.9 * exitimax(l2, h2, depth - 1, true, limit);
        sum += 0.1 * exitimax(l4, h4, depth - 1, true, limit);
      }
      result = sum / n;
    }
  }
  if (TT.size < 300000) TT.set(key, result);
  return result;
}

function bestMove(lo, hi, depth, limit, budget) {
  NODE_COUNT = 0; NODE_BUDGET = budget;
  let best = -Infinity, pick = [];
  const order = [0, 2, 1, 3];
  for (let k = 0; k < 4; k++) {
    const i = order[k];
    B_LO = lo; B_HI = hi;
    if (!moveDir(i)) continue;
    const cl = B_LO, ch = B_HI;
    const v = exitimax(cl, ch, depth - 1, false, limit);
    if (v > best + 1e-7) { best = v; pick = [i]; }
    else if (Math.abs(v - best) <= 1e-7) pick.push(i);
  }
  return pick.length ? pick[(Math.random() * pick.length) | 0] : -1;
}

function playGame(depth, limit, budget) {
  TT.clear();
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
    const d = depth + (empty <= 3 ? 1 : 0);
    const mv = bestMove(lo, hi, d, limit, budget);
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
    let can = false; const sl = B_LO, shh = B_HI;
    for (let i = 0; i < 4; i++) { B_LO = sl; B_HI = shh; if (moveDir(i)) { can = true; break; } }
    B_LO = sl; B_HI = shh;
    if (!can) break;
  }
  readCells(B_LO, B_HI);
  for (let i = 0; i < 16; i++) if (CELLS[i] > maxExp) maxExp = CELLS[i];
  return { score, steps, maxExp };
}

module.exports = { playGame, setParams, getParams: () => P, evaluate, readCells, CELLS, bestMove, moveDir, setBoard: (l,h)=>{B_LO=l>>>0;B_HI=h>>>0;}, getBoard: ()=>({lo:B_LO,hi:B_HI}), collectEmpty, getEmptyN:()=>EMPTY_N, countEmpty };

if (require.main === module) {
  const MAX_GAMES = parseInt(process.env.MAX_GAMES || '30', 10);
  const DEPTH = parseInt(process.env.DEPTH || '5', 10);
  const LIMIT = parseInt(process.env.LIMIT || '6', 10);
  const BUDGET = parseInt(process.env.BUDGET || '45000', 10);
  console.log(`引擎 v6 | 排序式评估 | depth=${DEPTH} limit=${LIMIT} budget=${BUDGET}`);
  console.log('参数', JSON.stringify(module.exports.getParams()));
  const START = Date.now();
  let bestScore = -1, bestMax = 0, sum = 0, hist = [];
  for (let g = 1; g <= MAX_GAMES; g++) {
    const r = playGame(DEPTH, LIMIT, BUDGET);
    sum += r.score; hist.push(r.score);
    if (r.score > bestScore) { bestScore = r.score; bestMax = r.maxExp; console.log(`[新纪录] 第 ${g} 局 | ${r.score} 分 | 最大块 ${POW2[r.maxExp]} | ${r.steps} 步 | ${((Date.now()-START)/1000).toFixed(0)}s`); }
    if (g % 5 === 0) { const el = (Date.now()-START)/1000; console.log(`  …${g} 局 | 均分 ${(sum/g).toFixed(0)} | 最高 ${bestScore} | ${(g/el*60).toFixed(1)} 局/分`); }
  }
  const el = (Date.now()-START)/1000;
  console.log(`\n===== v6 结果 =====`);
  console.log(`局数 ${MAX_GAMES} | 耗时 ${el.toFixed(0)}s | 速率 ${(MAX_GAMES/el*60).toFixed(1)} 局/分`);
  console.log(`平均 ${(sum/MAX_GAMES).toFixed(0)} | 最高 ${bestScore} (最大块 ${POW2[bestMax]})`);
  hist.sort((a,b)=>b-a);
  console.log(`中位 ${hist[Math.floor(hist.length/2)]} | 前5 ${hist.slice(0,5).join(', ')}`);
}
