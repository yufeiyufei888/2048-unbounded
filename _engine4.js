/*
 * 2048 引擎 v4 —— 角块锁定 + 单调阶梯（目标：突破 8192）
 *
 * v3 的问题：蛇形权重逐行折返，导致“蛇头”在左上/右上之间摆动，
 *            最大块没有严格锁定在同一个角，结构容易崩。
 * v4 的改进：
 *   1) 权重矩阵单调递减（从左上角出发，行列都不增），
 *      强制最大块永远待在左上角，且全局沿阶梯递减；
 *   2) 显式角块奖励 + 边缘行/列单调性检查；
 *   3) 空格惩罚更强，越接近填满越早规避风险；
 *   4) 保留 v3 的行 LUT / BitBoard / 转置表 基础设施。
 */
'use strict';

process.env.NODE_NO_WARNINGS = '1';

// ============ 行移动预计算表 ============
const ROW_LUT_SIZE = 65536;
const SCORE_LUT = new Float64Array(ROW_LUT_SIZE);
const MOVE_LUT  = new Uint16Array(ROW_LUT_SIZE);
const RIGHT_LUT = new Uint16Array(ROW_LUT_SIZE);

function slideRowLeft(row) {
  const cells = [(row >> 12) & 0xF, (row >> 8) & 0xF, (row >> 4) & 0xF, row & 0xF];
  const t = cells.filter(v => v !== 0);
  const out = [];
  let gained = 0;
  for (let i = 0; i < t.length; i++) {
    if (i + 1 < t.length && t[i] === t[i + 1]) {
      const nv = t[i] + 1;
      out.push(nv);
      gained += Math.pow(2, nv);
      i++;
    } else out.push(t[i]);
  }
  while (out.length < 4) out.push(0);
  return { row: (out[0] << 12) | (out[1] << 8) | (out[2] << 4) | out[3], gained };
}
function reverseRow(row) {
  return ((row & 0xF) << 12) | ((row & 0xF0) << 4) | ((row & 0xF00) >> 4) | ((row & 0xF000) >> 12);
}
// 两遍初始化：先左移表，再右移表（关键，不可合并到同一循环）
for (let row = 0; row < ROW_LUT_SIZE; row++) {
  const r = slideRowLeft(row);
  MOVE_LUT[row] = r.row;
  SCORE_LUT[row] = r.gained;
}
for (let row = 0; row < ROW_LUT_SIZE; row++) {
  RIGHT_LUT[row] = reverseRow(MOVE_LUT[reverseRow(row)]);
}

// ============ BitBoard ============
function getRow(lo, hi, r) {
  return r < 2 ? (lo >>> (16 * r)) & 0xFFFF : (hi >>> (16 * (r - 2))) & 0xFFFF;
}
function setRow(r, value) {
  if (r < 2) return { lo: value << (16 * r), hi: 0 };
  return { lo: 0, hi: value << (16 * (r - 2)) };
}
function moveBoard(lo, hi, dir) {
  let nlo = 0, nhi = 0, gained = 0, moved = false;
  if (dir === 0 || dir === 1) {
    for (let r = 0; r < 4; r++) {
      const row = getRow(lo, hi, r);
      const nrow = dir === 0 ? MOVE_LUT[row] : RIGHT_LUT[row];
      if (nrow !== row) moved = true;
      gained += SCORE_LUT[row];
      const s = setRow(r, nrow);
      nlo |= s.lo; nhi |= s.hi;
    }
  } else {
    for (let c = 0; c < 4; c++) {
      let col = 0;
      for (let r = 0; r < 4; r++) col = (col << 4) | ((getRow(lo, hi, r) >>> (12 - 4 * c)) & 0xF);
      const ncol = dir === 2 ? MOVE_LUT[col] : RIGHT_LUT[col];
      if (ncol !== col) moved = true;
      gained += SCORE_LUT[col];
      for (let r = 0; r < 4; r++) {
        const v = (ncol >>> (12 - 4 * r)) & 0xF;
        const sh = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
        if (r < 2) nlo |= v << sh; else nhi |= v << sh;
      }
    }
  }
  return { lo: nlo, hi: nhi, gained, moved };
}

function emptyCount(lo, hi) {
  let n = 0;
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r);
    if (((row >> 12) & 0xF) === 0) n++;
    if (((row >> 8) & 0xF) === 0) n++;
    if (((row >> 4) & 0xF) === 0) n++;
    if ((row & 0xF) === 0) n++;
  }
  return n;
}
function emptyIndices(lo, hi) {
  const out = [];
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r);
    for (let c = 0; c < 4; c++) if (((row >> (12 - 4 * c)) & 0xF) === 0) out.push(r * 4 + c);
  }
  return out;
}
function setCell(lo, hi, idx, exp) {
  const r = (idx / 4) | 0, c = idx % 4;
  const sh = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
  if (r < 2) return { lo: lo | (exp << sh), hi };
  return { lo, hi: hi | (exp << sh) };
}
function toCells(lo, hi) {
  const a = new Int32Array(16);
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r);
    a[r * 4]     = (row >> 12) & 0xF;
    a[r * 4 + 1] = (row >> 8) & 0xF;
    a[r * 4 + 2] = (row >> 4) & 0xF;
    a[r * 4 + 3] = row & 0xF;
  }
  return a;
}

// ============ v4 权重矩阵：单调阶梯（主项必须绝对主导）============
// 从左上角出发，权重严格沿行列单调递减。
// 关键：指数衰减要足够陡，使“最大块在左上角”这一条压倒其它所有项。
const W = new Float64Array(16);
for (let r = 0; r < 4; r++) {
  for (let c = 0; c < 4; c++) {
    W[r * 4 + c] = Math.pow(0.25, r + c); // 0.25 衰减 = 每远离一格权重降 4 倍
  }
}
// 预计算：格子 i 上指数 e 的贡献（e=0 记 0）
const VW = [];
for (let i = 0; i < 16; i++) {
  const row = new Float64Array(16);
  for (let e = 0; e < 16; e++) row[e] = e === 0 ? 0 : Math.pow(2, e) * W[i];
  VW.push(row);
}
// 差值 / 平滑度查表
const DIFF = new Float64Array(16 * 16);
for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
  DIFF[a * 16 + b] = (a && b) ? Math.abs(Math.pow(2, a) - Math.pow(2, b)) : 0;
}

function evaluate(lo, hi) {
  const c = toCells(lo, hi);
  let s = 0, empty = 0;

  // 1) 角块/阶梯权重（绝对主项）
  for (let i = 0; i < 16; i++) {
    const e = c[i];
    if (e === 0) { empty++; continue; }
    s += VW[i][e];
  }

  // 2) 空格奖励：与主项同一量级（主项里最大块约 2^12 级别，这里用平方鼓励留空）
  s += empty * empty * 3000;

  // 3) 单调性（行 + 列）：系数要小，只做结构引导，不喧宾夺主
  let mono = 0;
  for (let r = 0; r < 4; r++) {
    let inc = 0, dec = 0;
    for (let j = 0; j < 3; j++) {
      const a = c[r * 4 + j], b = c[r * 4 + j + 1];
      if (a && b) { const d = DIFF[a * 16 + b]; if (b > a) dec += d; else inc += d; }
    }
    mono += inc > dec ? inc : dec;
  }
  for (let col = 0; col < 4; col++) {
    let inc = 0, dec = 0;
    for (let r = 0; r < 3; r++) {
      const a = c[r * 4 + col], b = c[(r + 1) * 4 + col];
      if (a && b) { const d = DIFF[a * 16 + b]; if (b > a) dec += d; else inc += d; }
    }
    mono += inc > dec ? inc : dec;
  }
  s += mono * 1.0;

  // 4) 平滑度惩罚（相邻差值）：系数小
  for (let r = 0; r < 4; r++) {
    for (let j = 0; j < 3; j++) s -= DIFF[c[r * 4 + j] * 16 + c[r * 4 + j + 1]] * 1.5;
  }
  for (let col = 0; col < 4; col++) {
    for (let r = 0; r < 3; r++) s -= DIFF[c[r * 4 + col] * 16 + c[(r + 1) * 4 + col]] * 1.5;
  }

  // 5) 危险惩罚：最大块离左上角越远越惨（与主项同量级，才能真正“拉”回来）
  const maxExp = Math.max(...c);
  let maxPos = 0;
  for (let i = 0; i < 16; i++) if (c[i] === maxExp) { maxPos = i; break; }
  if (maxPos !== 0) {
    const dist = ((maxPos / 4) | 0) + (maxPos % 4);
    s -= Math.pow(2, maxExp) * W[0] * dist; // 量与主项同阶
  }
  if (empty <= 1) s -= 400000;
  else if (empty === 2) s -= 40000;

  return s;
}

// ============ Expectimax ============
const DIRS = [0, 1, 2, 3];
let TT = new Map();
let NODE_BUDGET = 0, NODE_COUNT = 0;

function expectimax(lo, hi, depth, player, limit) {
  if (depth === 0) return evaluate(lo, hi);
  if (++NODE_COUNT > NODE_BUDGET) return evaluate(lo, hi);
  const key = (player ? depth * 2 + 1 : depth * 2) * 4294967296 + lo * 65536 + hi;
  const cached = TT.get(key);
  if (cached !== undefined) return cached;

  let result;
  if (player) {
    let best = -Infinity;
    for (let i = 0; i < 4; i++) {
      const m = moveBoard(lo, hi, DIRS[i]);
      if (!m.moved) continue;
      const v = expectimax(m.lo, m.hi, depth - 1, false, limit);
      if (v > best) best = v;
    }
    result = best === -Infinity ? evaluate(lo, hi) - 1e12 : best;
  } else {
    const cells = emptyIndices(lo, hi);
    if (!cells.length) {
      result = expectimax(lo, hi, depth - 1, true, limit);
    } else {
      const cap = depth >= 5 ? limit : Math.max(limit, 10);
      const n = cells.length > cap ? cap : cells.length;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const idx = cells[(Math.random() * cells.length) | 0];
        const s2 = setCell(lo, hi, idx, 1);
        const s4 = setCell(lo, hi, idx, 2);
        sum += 0.9 * expectimax(s2.lo, s2.hi, depth - 1, true, limit);
        sum += 0.1 * expectimax(s4.lo, s4.hi, depth - 1, true, limit);
      }
      result = sum / n;
    }
  }
  if (TT.size < 200000) TT.set(key, result);
  return result;
}

function bestMove(lo, hi, depth, limit, budget) {
  NODE_COUNT = 0;
  NODE_BUDGET = budget;
  let best = -Infinity, pick = [];
  const order = [0, 2, 1, 3]; // left, up, right, down —— 维持左上角结构
  for (let k = 0; k < 4; k++) {
    const i = order[k];
    const m = moveBoard(lo, hi, DIRS[i]);
    if (!m.moved) continue;
    const v = expectimax(m.lo, m.hi, depth - 1, false, limit);
    if (v > best + 1e-7) { best = v; pick = [i]; }
    else if (Math.abs(v - best) <= 1e-7) pick.push(i);
  }
  return pick.length ? pick[(Math.random() * pick.length) | 0] : null;
}

// ============ 一整局 ============
function playOneGame(depth, limit, budget) {
  let lo = 0, hi = 0, score = 0, steps = 0;
  for (let k = 0; k < 2; k++) {
    const cells = emptyIndices(lo, hi);
    const s = setCell(lo, hi, cells[(Math.random() * cells.length) | 0], Math.random() < 0.9 ? 1 : 2);
    lo = s.lo; hi = s.hi;
  }
  while (steps < 200000) {
    const empty = emptyCount(lo, hi);
    const d = depth + (empty <= 3 ? 1 : 0);
    const mv = bestMove(lo, hi, d, limit, budget);
    if (mv === null) break;
    const m = moveBoard(lo, hi, mv);
    lo = m.lo; hi = m.hi;
    score += m.gained;
    const cells = emptyIndices(lo, hi);
    if (!cells.length) break;
    const s = setCell(lo, hi, cells[(Math.random() * cells.length) | 0], Math.random() < 0.9 ? 1 : 2);
    lo = s.lo; hi = s.hi;
    steps++;
    let canMove = false;
    for (let i = 0; i < 4; i++) if (moveBoard(lo, hi, i).moved) { canMove = true; break; }
    if (!canMove) break;
  }
  const board = [];
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r), arr = [];
    for (let c = 0; c < 4; c++) {
      const e = (row >> (12 - 4 * c)) & 0xF;
      arr.push(e === 0 ? 0 : Math.pow(2, e));
    }
    board.push(arr);
  }
  return { board, score, steps, maxTile: Math.max(...board.flat()) };
}

// ============ 主循环 ============
const DEPTH = 5, LIMIT = 6, BUDGET = 45000;
const MAX_GAMES = parseInt(process.env.MAX_GAMES || '500', 10);
const TIME_LIMIT_MS = 1000 * 60 * 40;
const START = Date.now();
let best = { score: -1 }, games = 0;
const hist = [];

console.log('引擎 v4 启动：角块锁定 + 单调阶梯 + 危险惩罚（目标 8192）');
for (let g = 1; g <= MAX_GAMES; g++) {
  TT.clear();
  const r = playOneGame(DEPTH, LIMIT, BUDGET);
  games++;
  hist.push(r.score);
  if (r.score > best.score) {
    best = r;
    const el = ((Date.now() - START) / 1000).toFixed(0);
    console.log(`[新纪录] 第 ${g} 局 | 得分 ${r.score} | 最大块 ${r.maxTile} | 步数 ${r.steps} | ${el}s`);
    r.board.forEach(row => console.log('   ' + row.map(v => String(v || '.').padStart(6)).join('')));
  }
  if (g % 25 === 0) {
    const el = (Date.now() - START) / 1000;
    const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
    const max = Math.max(...hist);
    console.log(`  …${g} 局 | 均分 ${avg.toFixed(0)} | 最高 ${max} | ${(g / el * 60).toFixed(1)} 局/分`);
  }
  if (Date.now() - START > TIME_LIMIT_MS) { console.log('时间到'); break; }
  if (process.memoryUsage && process.memoryUsage().heapUsed > 1.2 * 1024 ** 3) { console.log('内存保护停止'); break; }
}

hist.sort((a, b) => b - a);
console.log('\n===== v4 汇总 =====');
console.log('局数 :', games, '| 耗时', ((Date.now() - START) / 1000).toFixed(0) + 's');
console.log('最高 :', best.score, '（最大块', best.maxTile + '）');
console.log('中位 :', hist[Math.floor(hist.length / 2)]);
console.log('平均 :', (hist.reduce((a, b) => a + b, 0) / hist.length).toFixed(0));
console.log('前5名:', hist.slice(0, 5).join(', '));
console.log('终盘 :');
best.board.forEach(row => console.log('  ' + row.map(v => String(v || '.').padStart(6)).join('')));
