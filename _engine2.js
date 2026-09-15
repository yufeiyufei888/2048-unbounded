/*
 * 2048 高速 AI 引擎 v2
 * 优化点：
 *  1) 64-bit BigInt 打包棋盘（16 格 × 4 bit），移动/合并用查表
 *  2) 行移动预计算表（65536 项），彻底消除循环
 *  3) 转置表 (transposition table) 缓存同层同盘面的评估
 *  4) 权重矩阵 + 单调性 + 平滑度 + 空格，四因子评估
 *  5) 自适应深度：空格多时用浅搜索，盘面紧张时加深
 */
'use strict';

// ---------- 常量 ----------
const ROW_LUT_SIZE = 65536;
const SCORE_LUT = new Float64Array(ROW_LUT_SIZE);  // 行移动后得到的分数
const MOVE_LUT  = new Uint16Array(ROW_LUT_SIZE);   // 行移动后的结果行（左移）
const RIGHT_LUT = new Uint16Array(ROW_LUT_SIZE);   // 右移结果（等价于反转后左移再反转）

// 行：4 个 nibble，nibble i 表示第 i 格的指数（0 表示空格，k 表示 2^k）
// 移动一行（左移）
function slideRowLeft(row) {
  // 取出 4 个 nibble
  const cells = [(row >> 12) & 0xF, (row >> 8) & 0xF, (row >> 4) & 0xF, row & 0xF];
  const t = cells.filter(v => v !== 0);
  const out = [];
  let gained = 0;
  for (let i = 0; i < t.length; i++) {
    if (i + 1 < t.length && t[i] === t[i + 1]) {
      const nv = t[i] + 1;              // 指数 +1（值翻倍）
      out.push(nv);
      gained += 1 << nv;                // 合并后的数值
      i++;
    } else out.push(t[i]);
  }
  while (out.length < 4) out.push(0);
  return {
    row: (out[0] << 12) | (out[1] << 8) | (out[2] << 4) | out[3],
    gained
  };
}

// 预计算所有行的移动结果（两遍：先算左移表，再基于它算右移表）
for (let row = 0; row < ROW_LUT_SIZE; row++) {
  const r = slideRowLeft(row);
  MOVE_LUT[row] = r.row;
  SCORE_LUT[row] = r.gained;
}
// 反转 nibble 顺序的工具（行内 col0 在高位）
function reverseRow(row) {
  return ((row & 0xF) << 12) | ((row & 0xF0) << 4) | ((row & 0xF00) >> 4) | ((row & 0xF000) >> 12);
}
// 第二遍：右移 = 反转 -> 左移 -> 再反转（此时 MOVE_LUT 已完整）
for (let row = 0; row < ROW_LUT_SIZE; row++) {
  RIGHT_LUT[row] = reverseRow(MOVE_LUT[reverseRow(row)]);
}

// ---------- BitBoard ----------
// 布局：4 个 16-bit 行，行 r 占 lo(hi) 的第 16*r..16*r+15 位。
// 行内：高位是左边（col 0 在 bit15..12，col3 在 bit3..0）。
function getRow(lo, hi, r) {
  return r < 2 ? (lo >>> (16 * r)) & 0xFFFF : (hi >>> (16 * (r - 2))) & 0xFFFF;
}
function setRow(r, value) {
  if (r < 2) return { lo: value << (16 * r), hi: 0 };
  return { lo: 0, hi: value << (16 * (r - 2)) };
}

// 整盘移动
function moveBoard(lo, hi, dir) {
  let nlo = 0, nhi = 0, gained = 0, moved = false;
  if (dir === 0 || dir === 1) { // left / right
    for (let r = 0; r < 4; r++) {
      const row = getRow(lo, hi, r);
      const nrow = dir === 0 ? MOVE_LUT[row] : RIGHT_LUT[row];
      if (nrow !== row) moved = true;
      gained += SCORE_LUT[row];
      const s = setRow(r, nrow);
      nlo |= s.lo; nhi |= s.hi;
    }
  } else { // up / down
    for (let c = 0; c < 4; c++) {
      // 组装列：把第 c 列从上到下读成一行（col0 对应最高 nibble）
      let col = 0;
      for (let r = 0; r < 4; r++) {
        const v = (getRow(lo, hi, r) >>> (12 - 4 * c)) & 0xF;
        col = (col << 4) | v;
      }
      const ncol = dir === 2 ? MOVE_LUT[col] : RIGHT_LUT[col];
      if (ncol !== col) moved = true;
      gained += SCORE_LUT[col];
      // 写回第 c 列
      for (let r = 0; r < 4; r++) {
        const v = (ncol >>> (12 - 4 * r)) & 0xF;
        const rowShift = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
        if (r < 2) nlo |= v << rowShift;
        else       nhi |= v << rowShift;
      }
    }
  }
  return { lo: nlo, hi: nhi, gained, moved };
}

// ---------- 状态工具 ----------
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
    for (let c = 0; c < 4; c++) {
      if (((row >> (12 - 4 * c)) & 0xF) === 0) out.push(r * 4 + c);
    }
  }
  return out;
}
function setCell(lo, hi, idx, exp) {
  const r = (idx / 4) | 0, c = idx % 4;
  const shift = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
  if (r < 2) { lo = lo | (exp << shift); } else { hi = hi | (exp << shift); }
  return { lo, hi };
}
function maxExp(lo, hi) {
  let m = 0;
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r);
    m = Math.max(m, (row >> 12) & 0xF, (row >> 8) & 0xF, (row >> 4) & 0xF, row & 0xF);
  }
  return m;
}

// ---------- 评估函数 ----------
// 权重矩阵（蛇形/角落优先）
const W = new Float64Array([
  65536, 32768, 16384, 8192,
  512,   1024,  2048,  4096,
  256,   128,   64,    32,
  2,     4,     8,     16
]);
const LOG2 = new Float64Array(65536);
for (let i = 1; i < 65536; i++) LOG2[i] = Math.log2(i);

function evaluate(lo, hi) {
  let score = 0, empty = 0;
  // 权重 + 空格 + 平滑度
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r);
    for (let c = 0; c < 4; c++) {
      const e = (row >> (12 - 4 * c)) & 0xF;
      if (e === 0) { empty++; continue; }
      const v = (1 << e) >>> 0;
      score += v * W[r * 4 + c];
    }
  }
  score += empty * 20000;

  // 单调性
  let mono = 0;
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r);
    let inc = 0, dec = 0;
    for (let c = 0; c < 3; c++) {
      const a = (row >> (12 - 4 * c)) & 0xF, b = (row >> (8 - 4 * c)) & 0xF;
      if (a && b) { if (b > a) dec += (1 << b) - (1 << a); else inc += (1 << a) - (1 << b); }
    }
    mono += Math.max(inc, dec);
  }
  for (let c = 0; c < 4; c++) {
    let inc = 0, dec = 0;
    for (let r = 0; r < 3; r++) {
      const a = (getRow(lo, hi, r) >> (12 - 4 * c)) & 0xF;
      const b = (getRow(lo, hi, r + 1) >> (12 - 4 * c)) & 0xF;
      if (a && b) { if (b > a) dec += (1 << b) - (1 << a); else inc += (1 << a) - (1 << b); }
    }
    mono += Math.max(inc, dec);
  }
  score += mono * 2.0;

  // 平滑度惩罚
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r);
    for (let c = 0; c < 3; c++) {
      const a = (row >> (12 - 4 * c)) & 0xF, b = (row >> (8 - 4 * c)) & 0xF;
      if (a && b) score -= Math.abs((1 << a) - (1 << b)) * 4;
    }
  }
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 3; r++) {
      const a = (getRow(lo, hi, r) >> (12 - 4 * c)) & 0xF;
      const b = (getRow(lo, hi, r + 1) >> (12 - 4 * c)) & 0xF;
      if (a && b) score -= Math.abs((1 << a) - (1 << b)) * 4;
    }
  }
  return score;
}

// ---------- Expectimax + 转置表 ----------
let TT = new Map();
const DIRS = [0, 1, 2, 3];
// 节点预算：单次 bestMove 最多访问的搜索节点数，超预算立即返回当前最优（保证单步耗时有上界）
let NODE_BUDGET = 0;
let NODE_COUNT = 0;

function expectimax(lo, hi, depth, player, limit) {
  if (depth === 0) return evaluate(lo, hi);
  if (++NODE_COUNT > NODE_BUDGET) return evaluate(lo, hi);   // 超预算，退化为静态评估
  const key = player ? `${depth}|p|${lo}|${hi}` : `${depth}|r|${lo}|${hi}`;
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
    result = best === -Infinity ? evaluate(lo, hi) - 1e9 : best;
  } else {
    const cells = emptyIndices(lo, hi);
    if (!cells.length) {
      result = expectimax(lo, hi, depth - 1, true, limit);
    } else {
      // 抽样上限随深度自适应：深搜时少抽样，浅搜时多抽样
      const cap = depth >= 4 ? limit : Math.max(limit, 8);
      const n = cells.length > cap ? cap : cells.length;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const idx = cells[(Math.random() * cells.length) | 0];
        const s2 = setCell(lo, hi, idx, 1);  // 指数1 = 值2
        const s4 = setCell(lo, hi, idx, 2);  // 指数2 = 值4
        sum += 0.9 * expectimax(s2.lo, s2.hi, depth - 1, true, limit);
        sum += 0.1 * expectimax(s4.lo, s4.hi, depth - 1, true, limit);
      }
      result = sum / n;
    }
  }
  if (TT.size < 300000) TT.set(key, result);
  return result;
}

function bestMove(lo, hi, depth, limit) {
  NODE_COUNT = 0;
  NODE_BUDGET = 35000;   // 单步搜索节点上限（调小以提升吞吐）
  let best = -Infinity, pick = [];
  for (let i = 0; i < 4; i++) {
    const m = moveBoard(lo, hi, DIRS[i]);
    if (!m.moved) continue;
    const v = expectimax(m.lo, m.hi, depth - 1, false, limit);
    if (v > best + 1e-9) { best = v; pick = [i]; }
    else if (Math.abs(v - best) < 1e-9) pick.push(i);
  }
  return pick.length ? pick[(Math.random() * pick.length) | 0] : null;
}

// ---------- 一整局 ----------
function playOneGame(depth, limit) {
  let lo = 0, hi = 0, score = 0, steps = 0;
  // 开局两块
  for (let k = 0; k < 2; k++) {
    const cells = emptyIndices(lo, hi);
    const idx = cells[(Math.random() * cells.length) | 0];
    const s = setCell(lo, hi, idx, Math.random() < 0.9 ? 1 : 2);
    lo = s.lo; hi = s.hi;
  }
  while (steps < 200000) {
    // 自适应深度
    const empty = emptyCount(lo, hi);
    const d = depth + (empty <= 2 ? 1 : 0);
    const mv = bestMove(lo, hi, d, limit);
    if (mv === null) break;
    const m = moveBoard(lo, hi, mv);
    lo = m.lo; hi = m.hi;
    score += m.gained;
    const cells = emptyIndices(lo, hi);
    if (!cells.length) break;
    const idx = cells[(Math.random() * cells.length) | 0];
    const s = setCell(lo, hi, idx, Math.random() < 0.9 ? 1 : 2);
    lo = s.lo; hi = s.hi;
    steps++;
    // 无步可走
    let canMove = false;
    for (let i = 0; i < 4; i++) { if (moveBoard(lo, hi, i).moved) { canMove = true; break; } }
    if (!canMove) break;
  }
  // 还原棋盘为数值二维数组
  const board = [];
  for (let r = 0; r < 4; r++) {
    const row = getRow(lo, hi, r), arr = [];
    for (let c = 0; c < 4; c++) {
      const e = (row >> (12 - 4 * c)) & 0xF;
      arr.push(e === 0 ? 0 : (1 << e) >>> 0);
    }
    board.push(arr);
  }
  return { board, score, steps, maxTile: Math.max(...board.flat()) };
}

// ---------- 主循环 ----------
const DEPTH = 5;
const LIMIT = 5;
const MAX_GAMES = 400;
const TIME_LIMIT_MS = 1000 * 60 * 35;
const START = Date.now();

let best = { score: -1 };
let games = 0;
let totalSteps = 0;

const t0 = Date.now();
console.log('引擎 v2 启动：BitBoard + 转置表 + 自适应深度');
console.log('参数：基础深度', DEPTH, '| 抽样上限', LIMIT);

for (let g = 1; g <= MAX_GAMES; g++) {
  TT.clear();   // 每局清空转置表，避免内存膨胀
  const r = playOneGame(DEPTH, LIMIT);
  games++;
  totalSteps += r.steps;
  if (r.score > best.score) {
    best = r;
    const el = ((Date.now() - START) / 1000).toFixed(0);
    console.log(`[新纪录] 第 ${g} 局 | 得分 ${r.score} | 最大块 ${r.maxTile} | 步数 ${r.steps} | ${el}s | 平均 ${(totalSteps/games).toFixed(0)} 步/局`);
    r.board.forEach(row => console.log('   ' + row.map(v => String(v || '.').padStart(6)).join('')));
  }
  if (g % 25 === 0) {
    const el = (Date.now() - START) / 1000;
    console.log(`  …已跑 ${g} 局 | 均分/局 ${(totalSteps/games).toFixed(0)} 步 | 速率 ${(g/el*60).toFixed(1)} 局/分`);
  }
  if (Date.now() - START > TIME_LIMIT_MS) { console.log('达到时间预算'); break; }
  if (process.memoryUsage && process.memoryUsage().heapUsed > 1.2 * 1024 ** 3) {
    console.log('内存保护触发，安全停止'); break;
  }
}

console.log('\n===== 汇总 =====');
console.log('模拟局数 :', games);
console.log('总耗时   :', ((Date.now() - START) / 1000).toFixed(0) + 's');
console.log('速率     :', (games / ((Date.now() - START) / 1000) * 60).toFixed(1), '局/分');
console.log('最高得分 :', best.score);
console.log('最大方块 :', best.maxTile);
console.log('终盘 :');
best.board.forEach(row => console.log('  ' + row.map(v => String(v || '.').padStart(6)).join('')));
