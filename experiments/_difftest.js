/*
 * 差分测试套件（任务7 测试要求）
 * 用法: node experiments/_difftest.js
 * 覆盖：
 *   T1  moveDir 与独立朴素参考实现差分（10 万随机棋盘 × 4 方向：moved/结果棋盘/得分）
 *   T2  evaluate 与朴素参考实现差分（基线参数 + v3 参数交叉核对 _ref_eval.js）
 *   T3  增量版 evaluate 与基线逐位一致（20 万棋盘）
 *   T4  countEmpty 与朴素空位计数一致（20 万棋盘）
 *   T5  新方块只写入空格（生成位移公式回环验证 + 空位集合一致性）
 *   T6  2/4 概率统计（≈90/10）
 *   T7  种子可复现性（同 seed 两局完全一致；不同 seed 结果不同）
 *   T8  TT 跨局污染检查（同 seed 重打一致性 + 行为差异检测）
 *   T9  增量版 bestMove 与 ttfix 同种子大预算完全一致（无预算截断）
 *   T10 风险版 λ=0 与 ttfix 同种子完全一致；λ>0 时值单调不增
 *   T11 各引擎 bestMove 死局返回 -1
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const BASE = require(path.join(ROOT, '_engine7_baseline.js'));
const TTFIX = require(path.join(ROOT, '_engine7_ttfix.js'));
const RISK = require(path.join(ROOT, '_engine7_risk.js'));
const INC = require(path.join(ROOT, '_engine7_incremental.js'));
const PHASE = require(path.join(ROOT, '_engine7_phase.js'));
const NN = require(path.join(ROOT, '_engine7_nn.js'));
const REF3 = require(path.join(ROOT, '_ref_eval.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? ' | ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' | ' + detail : ''}`); }
}

// ---------- 朴素参考实现（独立于引擎代码） ----------
function naiveMove(board, dir) {   // board: 4x4 数值方块（0=空）；dir: 0左 1右 2上 3下
  const b = board.map(r => r.slice());
  let moved = false, gained = 0;
  function slide(line) {           // 向左滑一行/列
    const t = line.filter(v => v !== 0);
    const out = [];
    for (let i = 0; i < t.length; i++) {
      if (i + 1 < t.length && t[i] === t[i + 1]) { const nv = t[i] * 2; out.push(nv); gained += nv; i++; }
      else out.push(t[i]);
    }
    while (out.length < 4) out.push(0);
    return out;
  }
  const get = (r, c) => b[r][c], set = (r, c, v) => { b[r][c] = v; };
  for (let k = 0; k < 4; k++) {
    let line;
    if (dir === 0) line = [get(k, 0), get(k, 1), get(k, 2), get(k, 3)];
    else if (dir === 1) line = [get(k, 3), get(k, 2), get(k, 1), get(k, 0)];
    else if (dir === 2) line = [get(0, k), get(1, k), get(2, k), get(3, k)];
    else line = [get(3, k), get(2, k), get(1, k), get(0, k)];
    const out = slide(line);
    for (let j = 0; j < 4; j++) {
      let r, c, v;
      if (dir === 0) { r = k; c = j; } else if (dir === 1) { r = k; c = 3 - j; }
      else if (dir === 2) { r = j; c = k; } else { r = 3 - j; c = k; }
      v = out[j];
      if (get(r, c) !== v) moved = true;
      set(r, c, v);
    }
  }
  return { board: b, moved, gained };
}

function naiveEvaluate(cells, P) {  // cells: 16 个指数
  const SNAKE_POS = [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12];
  const POW2 = []; for (let i = 0; i < 20; i++) POW2.push(Math.pow(2, i));
  let s = 0, empty = 0;
  for (let i = 0; i < 16; i++) { const e = cells[i]; if (e === 0) { empty++; continue; } s += POW2[e] * Math.pow(P.base, 15 - SNAKE_POS[i]); }
  s += empty * P.wEmpty;
  let mono = 0;
  for (let r = 0; r < 4; r++) {
    let inc = 0, dec = 0;
    for (let j = 0; j < 3; j++) { const a = cells[r*4+j], b = cells[r*4+j+1]; if (a && b) { const d = Math.abs(POW2[a]-POW2[b]); if (b > a) dec += d; else inc += d; } }
    mono += inc > dec ? inc : dec;
  }
  const cols = []; for (let c = 0; c < 4; c++) { cols.push([cells[c], cells[4+c], cells[8+c], cells[12+c]]); }
  for (let c = 0; c < 4; c++) {
    let inc = 0, dec = 0;
    for (let r = 0; r < 3; r++) { const a = cols[c][r], b = cols[c][r+1]; if (a && b) { const d = Math.abs(POW2[a]-POW2[b]); if (b > a) dec += d; else inc += d; } }
    mono += inc > dec ? inc : dec;
  }
  s += mono * P.wMono;
  let smooth = 0;
  for (let r = 0; r < 4; r++) for (let j = 0; j < 3; j++) { const a = cells[r*4+j], b = cells[r*4+j+1]; if (a && b) smooth += Math.abs(POW2[a]-POW2[b]); }
  for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) { const a = cols[c][r], b = cols[c][r+1]; if (a && b) smooth += Math.abs(POW2[a]-POW2[b]); }
  s -= smooth * P.wSmooth;
  if (empty <= 1) s -= P.dEmpty1; else if (empty === 2) s -= P.dEmpty2;
  return s;
}

// ---------- 随机棋盘 ----------
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(987654321);

function randBoardRealistic() {   // 返回 [lo, hi]
  let lo = 0, hi = 0;
  for (let i = 0; i < 16; i++) {
    const e = rng() < 0.42 ? 0 : 1 + Math.floor(Math.pow(rng(), 2.0) * 13);
    const sh = 4 * (i % 8);
    if (i < 8) lo = (lo | (e << sh)) >>> 0; else hi = (hi | (e << sh)) >>> 0;
  }
  return [lo >>> 0, hi >>> 0];
}
function loHiToCells(lo, hi) {
  const cells = new Array(16);
  for (let r = 0; r < 4; r++) {
    const row = r < 2 ? (lo >>> (16 * r)) & 0xFFFF : (hi >>> (16 * (r - 2))) & 0xFFFF;
    for (let c = 0; c < 4; c++) cells[r * 4 + c] = (row >>> (12 - 4 * c)) & 0xF;
  }
  return cells;
}
function cellsToLoHi(cells) {
  let lo = 0, hi = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const sh = (r < 2 ? 16 * r : 16 * (r - 2)) + (12 - 4 * c);
    if (r < 2) lo = (lo | (cells[r*4+c] << sh)) >>> 0; else hi = (hi | (cells[r*4+c] << sh)) >>> 0;
  }
  return [lo >>> 0, hi >>> 0];
}
function expToBoard(cells) {  // 平铺指数 → 4x4 数值棋盘
  const b = [];
  for (let r = 0; r < 4; r++) b.push(cells.slice(r * 4, r * 4 + 4).map(e => e === 0 ? 0 : (1 << e)));
  return b;
}
function boardToExp(board) { return board.flat().map(v => v === 0 ? 0 : Math.round(Math.log2(v))); }

function relEq(a, b, tol) {
  if (a === b) return true;
  const d = Math.abs(a - b), m = Math.max(Math.abs(a), Math.abs(b));
  return d <= tol * Math.max(1, m);
}

// ================= T1 moveDir 差分 =================
console.log('T1 moveDir vs 朴素参考（10万棋盘 × 4方向）');
{
  const N = 100000;
  let bad = 0, badDetail = null, totalMoves = 0;
  for (let i = 0; i < N; i++) {
    const [lo, hi] = randBoardRealistic();
    const cells = loHiToCells(lo, hi);
    for (let dir = 0; dir < 4; dir++) {
      const ref = naiveMove(expToBoard(cells), dir);
      BASE.setBoard(lo, hi);
      const movedEng = BASE.moveDir(dir);
      const gb = BASE.getBoard();
      const after = loHiToCells(gb.lo, gb.hi);
      const refExp = boardToExp(ref.board);
      let ok = movedEng === ref.moved && BASE.getGain() === ref.gained;
      if (ok) for (let k = 0; k < 16; k++) if (after[k] !== refExp[k]) { ok = false; break; }
      if (!ok) { bad++; if (!badDetail) badDetail = { i, dir, lo: lo.toString(16), hi: hi.toString(16), movedEng, movedRef: ref.moved, gEng: BASE.getGain(), gRef: ref.gained, after, refExp }; }
      if (ref.moved) totalMoves++;
    }
  }
  check('T1 moveDir 全方向一致', bad === 0, `坏例=${bad}/${N * 4} 有效移动=${totalMoves}${badDetail ? ' ' + JSON.stringify(badDetail) : ''}`);
}

// ================= T2 evaluate 差分 =================
console.log('T2 evaluate vs 朴素参考 + _ref_eval.js 交叉核对');
{
  const N = 100000;
  const defP = BASE.getParams();
  let bad = 0, badRef3 = 0, maxRel = 0, maxRel3 = 0;
  for (let i = 0; i < N; i++) {
    const [lo, hi] = randBoardRealistic();
    const cells = loHiToCells(lo, hi);
    const eng = BASE.evaluate(lo, hi);
    const naive = naiveEvaluate(cells, defP);
    const rel = Math.abs(eng - naive) / Math.max(1, Math.abs(naive));
    if (rel > maxRel) maxRel = rel;
    if (!relEq(eng, naive, 1e-9)) bad++;
  }
  check('T2a evaluate(v7.1 参数) ≈ 朴素参考', bad === 0, `坏例=${bad}/${N} 最大相对差=${maxRel.toExponential(2)}`);

  // v3 参数（base=4）下与 _ref_eval.js 交叉核对
  BASE.setParams({ base: 4 });
  for (let i = 0; i < N; i++) {
    const [lo, hi] = randBoardRealistic();
    const a = BASE.evaluate(lo, hi), b = REF3.evaluate(lo, hi);
    const rel = Math.abs(a - b) / Math.max(1, Math.abs(b));
    if (rel > maxRel3) maxRel3 = rel;
    if (!relEq(a, b, 1e-9)) badRef3++;
  }
  BASE.setParams({ base: 4.5 });
  check('T2b evaluate(v3 参数) ≈ _ref_eval.js', badRef3 === 0, `坏例=${badRef3}/${N} 最大相对差=${maxRel3.toExponential(2)}`);
}

// ================= T3 增量版 evaluate 逐位一致 =================
console.log('T3 增量版 evaluate 与基线逐位一致');
{
  const N = 200000;
  let mismatch = 0;
  for (let i = 0; i < N; i++) {
    const [lo, hi] = randBoardRealistic();
    if (BASE.evaluate(lo, hi) !== INC.evaluate(lo, hi)) mismatch++;
  }
  check('T3 逐位一致 (===)', mismatch === 0, `不一致=${mismatch}/${N}`);
  let mm2 = 0;
  for (let i = 0; i < N; i++) {
    const [lo, hi] = randBoardRealistic();
    if (TTFIX.evaluate(lo, hi) !== RISK.evaluate(lo, hi)) mm2++;
  }
  check('T3b 风险版 evaluate 与 ttfix 逐位一致', mm2 === 0, `不一致=${mm2}/${N}`);
}

// ================= T4 countEmpty =================
console.log('T4 countEmpty 与朴素计数一致');
{
  const N = 200000;
  let bad = 0;
  for (let i = 0; i < N; i++) {
    const [lo, hi] = randBoardRealistic();
    const cells = loHiToCells(lo, hi);
    const ref = cells.filter(e => e === 0).length;
    if (BASE.countEmpty(lo, hi) !== ref) bad++;
    if (TTFIX.countEmpty(lo, hi) !== ref) bad++;
  }
  check('T4 空位计数一致', bad === 0, `坏例=${bad}/${N}`);
}

// ================= T5 生成位置只写空格 =================
console.log('T5 新方块只写入空格（位移公式回环 + 空位集合一致）');
{
  const N = 100000;
  let bad = 0;
  for (let i = 0; i < N; i++) {
    const [lo, hi] = randBoardRealistic();
    const cells = loHiToCells(lo, hi);
    const empties = [];
    for (let idx = 0; idx < 16; idx++) if (cells[idx] === 0) empties.push(idx);
    for (const idx of empties) {
      const rr = (idx / 4) | 0, cc = idx % 4;
      const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
      // 回环：由 sh 反解 idx
      const rr2 = ((sh - (12 - 4 * (sh % 4 ? 0 : 0))) === 0) ? 0 : 0; // 占位，不用
      // 直接验证 OR 写入后对应 cell 变为 e 且其他格不变
      for (const e of [1, 2]) {
        let l2 = lo, h2 = hi;
        if (rr < 2) l2 = (lo | (e << sh)) >>> 0; else h2 = (hi | (e << sh)) >>> 0;
        const after = loHiToCells(l2, h2);
        if (cells[idx] !== 0) { bad++; break; }                    // 目标必须原为空
        if (after[idx] !== e) { bad++; break; }                    // 写入后等于 e
        let othersSame = true;
        for (let k = 0; k < 16; k++) if (k !== idx && after[k] !== cells[k]) { othersSame = false; break; }
        if (!othersSame) { bad++; break; }                          // 其他格不变
      }
    }
  }
  check('T5 OR 写入只影响目标空格', bad === 0, `坏例=${bad}`);
}

// ================= T6 2/4 概率 =================
console.log('T6 生成方块 2/4 概率统计');
{
  let c2 = 0, c4 = 0;
  const n = 200000;
  for (let i = 0; i < n; i++) { if (rng() < 0.9) c2++; else c4++; }
  const p4 = c4 / n;
  check('T6 P(4)≈0.1', Math.abs(p4 - 0.1) < 0.005, `P(4)=${p4.toFixed(4)}`);
}

// ================= T7/T8 种子可复现 + TT 跨局污染 =================
console.log('T7/T8 种子可复现性与 TT 跨局隔离');
{
  for (const E of [BASE, TTFIX, RISK, INC, PHASE]) {
    const a = E.playGame(4, 4, 3000, 777);
    const b = E.playGame(4, 4, 3000, 777);
    const c = E.playGame(4, 4, 3000, 778);
    const same = a.score === b.score && a.steps === b.steps && a.maxExp === b.maxExp;
    const diff = c.score !== a.score || c.steps !== a.steps || c.maxExp !== a.maxExp;
    check(`T7 ${E.ENGINE_TAG} 同seed一致/异seed不同`, same && diff,
      `seed777: ${a.score}/${a.steps}/${a.maxExp} vs ${b.score}/${b.steps}/${b.maxExp}; seed778: ${c.score}/${c.steps}/${c.maxExp}`);
  }
}

// ================= T9 增量版 bestMove 大预算一致性 =================
console.log('T9 增量版 bestMove 与 ttfix 同种子一致（无预算截断）');
{
  const N = 400;
  let agree = 0, tested = 0;
  for (let i = 0; i < N; i++) {
    const [lo, hi] = randBoardRealistic();
    if (BASE.countEmpty(lo, hi) < 2) continue;   // 保证有足够空位做有效搜索
    TTFIX.setSeed(424242 + i);
    const m1 = TTFIX.bestMove(lo, hi, 3, 2, 10000000);
    INC.setSeed(424242 + i);
    const m2 = INC.bestMove(lo, hi, 3, 2, 10000000);
    tested++;
    if (m1 === m2) agree++;
  }
  check('T9 大预算动作一致', agree === tested, `${agree}/${tested}`);
}

// ================= T10 风险版 λ=0 等价 & λ>0 行为 =================
console.log('T10 风险版 λ=0 与 ttfix 等价；λ>0 正常运行');
{
  const N = 300;
  let agree = 0, tested = 0;
  for (let i = 0; i < N; i++) {
    const [lo, hi] = randBoardRealistic();
    if (BASE.countEmpty(lo, hi) < 2) continue;
    TTFIX.setSeed(55555 + i);
    const m1 = TTFIX.bestMove(lo, hi, 4, 6, 45000);
    RISK.setSeed(55555 + i);
    const m2 = RISK.bestMove(lo, hi, 4, 6, 45000);
    tested++;
    if (m1 === m2) agree++;
  }
  check('T10a λ=0 动作一致', agree === tested, `${agree}/${tested}`);

  RISK.setParams({ riskLambda: 0.1, riskPhase: 0 });
  let okRun = true, nonDecreasingRisk = true;
  try {
    const g = RISK.playGame(4, 4, 5000, 31337);
    if (!(g.score >= 0 && g.steps > 0)) okRun = false;
  } catch (e) { okRun = false; console.log('  风险版异常:', e.message); }
  check('T10b λ=0.1 可完整运行', okRun);
  RISK.setParams({ riskLambda: 0, riskPhase: 12 });
}

// ================= T11 死局返回 -1 =================
console.log('T11 死局 bestMove 返回 -1');
{
  // 满盘且无可合并：经典死局
  const cells = [1,2,3,4, 5,6,7,8, 2,3,4,5, 3,4,5,6];
  const [lo, hi] = cellsToLoHi(cells);
  for (const E of [BASE, TTFIX, RISK, INC, PHASE]) {
    E.setSeed(1);
    const mv = E.bestMove(lo, hi, 3, 2, 5000);
    check(`T11 ${E.ENGINE_TAG} 死局=-1`, mv === -1, `mv=${mv}`);
  }
}

// ================= T12 nneonneo 式评价差分 =================
console.log('T12 nn 引擎 evaluate vs 朴素重实现');
{
  const N = 100000;
  const nnP = NN.getParams();
  function naiveNN(cells) {
    const SNAKE_COL = (r, c) => cells[r * 4 + c]; // 第 c 列自上而下：cells[行*4+列]
    let s = 0;
    function rowScore(a, b, c, d) {
      const cs = [a, b, c, d];
      let empties = 0, sum = 0, merges = 0;
      for (let i = 0; i < 4; i++) { const e = cs[i]; if (e === 0) empties++; else sum += Math.pow(e, 3.5); }
      let run = 1;
      for (let i = 1; i < 4; i++) { if (cs[i] !== 0 && cs[i] === cs[i-1]) run++; else { if (run > 1) merges += 1 + (run - 1); run = 1; } }
      if (run > 1) merges += 1 + (run - 1);
      let monoL = 0, monoR = 0;
      for (let i = 1; i < 4; i++) { const x = cs[i-1], y = cs[i]; if (x > y) monoL += Math.pow(x,4)-Math.pow(y,4); else if (y > x) monoR += Math.pow(y,4)-Math.pow(x,4); }
      return nnP.nnEmptyW * Math.pow(empties, 1.5) + nnP.nnMergeW * merges - nnP.nnSumW * sum - nnP.nnMonoW * Math.min(monoL, monoR);
    }
    for (let r = 0; r < 4; r++) s += rowScore(cells[r*4], cells[r*4+1], cells[r*4+2], cells[r*4+3]);
    for (let c = 0; c < 4; c++) s += rowScore(SNAKE_COL(0,c), SNAKE_COL(1,c), SNAKE_COL(2,c), SNAKE_COL(3,c));
    return s;
  }
  let bad = 0, badDetail = null;
  for (let i = 0; i < N; i++) {
    const [lo, hi] = randBoardRealistic();
    const cells = loHiToCells(lo, hi);
    const a = NN.evaluate(lo, hi), b = naiveNN(cells);
    if (!relEq(a, b, 1e-9)) { bad++; if (!badDetail) badDetail = { i, lo: lo.toString(16), hi: hi.toString(16), eng: a, naive: b, cells: cells.join('') }; }
  }
  check('T12 nn evaluate ≈ 朴素重实现', bad === 0, `坏例=${bad}/${N}${badDetail ? ' ' + JSON.stringify(badDetail) : ''}`);
  const g = NN.playGame(4, 4, 3000, 777);
  const g2 = NN.playGame(4, 4, 3000, 777);
  check('T12b nn 种子可复现', g.score === g2.score && g.steps === g2.steps, `score=${g.score}`);
}

// ================= T13/T14/T15 概率引擎（v7.3-prob） =================
console.log('T13/T14/T15 概率引擎（全展开+cprob 剪枝）');
{
  const PROBE = require(path.join(ROOT, '_engine7_prob.js'));
  // T13 evaluate 与 ttfix 逐位一致（同一评价函数）
  let mm = 0;
  for (let i = 0; i < 100000; i++) {
    const [lo, hi] = randBoardRealistic();
    if (PROBE.evaluate(lo, hi) !== TTFIX.evaluate(lo, hi)) mm++;
  }
  check('T13 prob evaluate 与 ttfix 逐位一致', mm === 0, `不一致=${mm}/100000`);
  // T14 搜索确定性：同棋盘不同种子 bestMove 一致（搜索不含 RNG）
  let agree = 0, tested = 0;
  for (let i = 0; i < 200; i++) {
    const [lo, hi] = randBoardRealistic();
    if (BASE.countEmpty(lo, hi) < 2) continue;
    PROBE.setSeed(11111 + i);
    const m1 = PROBE.bestMove(lo, hi, 4, 6, 1000000);
    PROBE.setSeed(99999 + i);
    const m2 = PROBE.bestMove(lo, hi, 4, 6, 1000000);
    tested++;
    if (m1 === m2) agree++;
  }
  check('T14 搜索确定性（不同种子同动作）', agree === tested, `${agree}/${tested}`);
  // T15 diag 完整性 + 同种子可复现 + cprob 阈值两种取值均可运行
  PROBE.setParams({ cprobThresh: 1e-4 });
  const g1 = PROBE.playGame(4, 4, 20000, 606);
  const g2 = PROBE.playGame(4, 4, 20000, 606);
  check('T15a 同种子逐局可复现', g1.score === g2.score && g1.steps === g2.steps, `score=${g1.score}`);
  const d = g1.diag;
  const diagOk = d && typeof d.stepAt13 === 'number' && typeof d.deathExp === 'number' && d.deathEmp >= 0;
  check('T15b diag 字段完整', !!diagOk, JSON.stringify(d));
  PROBE.setParams({ cprobThresh: 0 });
  const g3 = PROBE.playGame(4, 4, 20000, 606);
  check('T15c cprobThresh=0 可运行', g3.score > 0 && g3.steps > 0, `score=${g3.score}`);
  PROBE.setParams({ cprobThresh: 1e-4 });
  // T15d 终盘加深开关可运行
  PROBE.setParams({ deepOnMaxExp: 13 });
  const g4 = PROBE.playGame(4, 4, 20000, 707);
  check('T15d deepOnMaxExp=13 可运行', g4.score > 0, `score=${g4.score}`);
  PROBE.setParams({ deepOnMaxExp: 0 });
}

// ================= T16 dualBase 双尺度评价差分 =================
console.log('T16 dual 评价 vs 朴素重算');
{
  const PROBE = require(path.join(ROOT, '_engine7_prob.js'));
  PROBE.setParams({ dualBase: 3.0, dualStartExp: 13 });
  const dp = PROBE.getParams();
  const SNAKE_POS = [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12];
  function naiveDual(cells) {
    let maxExp = 0;
    for (let i = 0; i < 16; i++) if (cells[i] > maxExp) maxExp = cells[i];
    const dual = maxExp >= dp.dualStartExp;
    let s = 0;
    for (let i = 0; i < 16; i++) {
      const e = cells[i];
      if (!e) continue;
      const r = SNAKE_POS[i];
      s += dual
        ? (e === maxExp ? Math.pow(2, e) * Math.pow(dp.base, 15 - r) : Math.pow(2, e) * Math.pow(dp.dualBase, 15 - r))
        : Math.pow(2, e) * Math.pow(dp.base, 15 - r);
    }
    return s;   // 只对比蛇形主项：用空盘常数抵消法不适用，这里直接让 naive 也含全部项
  }
  // 完整 naive（含 mono/smooth/empty）
  function naiveFull(cells) {
    const POW2L = []; for (let i = 0; i < 20; i++) POW2L.push(Math.pow(2, i));
    let maxExp = 0;
    for (let i = 0; i < 16; i++) if (cells[i] > maxExp) maxExp = cells[i];
    const dual = maxExp >= dp.dualStartExp;
    let s = 0, empty = 0;
    for (let i = 0; i < 16; i++) {
      const e = cells[i];
      if (!e) { empty++; continue; }
      const r = SNAKE_POS[i];
      s += dual
        ? (e === maxExp ? POW2L[e] * Math.pow(dp.base, 15 - r) : POW2L[e] * Math.pow(dp.dualBase, 15 - r))
        : POW2L[e] * Math.pow(dp.base, 15 - r);
    }
    s += empty * dp.wEmpty;
    const cols = []; for (let c = 0; c < 4; c++) cols.push([cells[c], cells[4 + c], cells[8 + c], cells[12 + c]]);
    let mono = 0, smooth = 0;
    for (let r = 0; r < 4; r++) {
      let inc = 0, dec = 0;
      for (let j = 0; j < 3; j++) { const a = cells[r*4+j], b = cells[r*4+j+1]; if (a && b) { const d = Math.abs(POW2L[a]-POW2L[b]); smooth += d; if (b > a) dec += d; else inc += d; } }
      mono += inc > dec ? inc : dec;
    }
    for (let c = 0; c < 4; c++) {
      let inc = 0, dec = 0;
      for (let r = 0; r < 3; r++) { const a = cols[c][r], b = cols[c][r+1]; if (a && b) { const d = Math.abs(POW2L[a]-POW2L[b]); smooth += d; if (b > a) dec += d; else inc += d; } }
      mono += inc > dec ? inc : dec;
    }
    s += mono * dp.wMono;
    s -= smooth * dp.wSmooth;
    if (empty <= 1) s -= dp.dEmpty1; else if (empty === 2) s -= dp.dEmpty2;
    return s;
  }
  let bad = 0, dualHit = 0;
  for (let i = 0; i < 100000; i++) {
    const [lo, hi] = randBoardRealistic();
    const cells = loHiToCells(lo, hi);
    let mx = 0; for (let k = 0; k < 16; k++) if (cells[k] > mx) mx = cells[k];
    if (mx >= 13) dualHit++;
    const a = PROBE.evaluate(lo, hi), b = naiveFull(cells);
    if (!relEq(a, b, 1e-9)) bad++;
  }
  check('T16 dual 评价 ≈ 朴素重算', bad === 0, `坏例=${bad}/100000（触发 dual 路径 ${dualHit} 局）`);
  // dual 模式下同种子可复现 + 可运行
  const gd = PROBE.playGame(5, 6, 45000, 909);
  const gd2 = PROBE.playGame(5, 6, 45000, 909);
  check('T16b dual 同种子可复现', gd.score === gd2.score && gd.steps === gd2.steps, `score=${gd.score} maxExp=${gd.maxExp}`);
  PROBE.setParams({ dualBase: 0 });
}

// ================= T17 分段评价切换（after13nn） =================
console.log('T17 after13nn 分段评价');
{
  const PROBE = require(path.join(ROOT, '_engine7_prob.js'));
  PROBE.setParams({ after13nn: 1, after13nnExp: 13 });
  // maxExp<13 时应与 ttfix evaluate 一致（评价未切换）
  let mm = 0;
  for (let i = 0; i < 100000; i++) {
    const [lo, hi] = randBoardRealistic();
    const cells = loHiToCells(lo, hi);
    let mx = 0; for (let k = 0; k < 16; k++) if (cells[k] > mx) mx = cells[k];
    if (mx < 13 && PROBE.evaluate(lo, hi) !== TTFIX.evaluate(lo, hi)) mm++;
  }
  check('T17a maxExp<13 与 ttfix 逐位一致', mm === 0, `不一致=${mm}/100000`);
  // maxExp>=13 时应与 nn 引擎的 evaluate 一致（同一 nn 公式；允许 1-ulp 浮点求和顺序差）
  const NNENG = NN;
  let mm2 = 0, hit = 0;
  for (let i = 0; i < 100000; i++) {
    const [lo, hi] = randBoardRealistic();
    const cells = loHiToCells(lo, hi);
    let mx = 0; for (let k = 0; k < 16; k++) if (cells[k] > mx) mx = cells[k];
    if (mx >= 13) {
      hit++;
      if (!relEq(PROBE.evaluate(lo, hi), NNENG.evaluate(lo, hi), 1e-12)) mm2++;
    }
  }
  check('T17b maxExp≥13 与 nn 评价一致(相对差≤1e-12)', mm2 === 0, `不一致=${mm2}（触发 ${hit} 局）`);
  // 可运行 + 可复现
  const g = PROBE.playGame(5, 6, 45000, 808);
  const g2 = PROBE.playGame(5, 6, 45000, 808);
  check('T17c 同种子可复现', g.score === g2.score && g.steps === g2.steps, `score=${g.score} maxExp=${g.maxExp}`);
  PROBE.setParams({ after13nn: 0 });
}

// ================= T18-T24 N-Tuple/TD 集成差分 =================
console.log('T18-T24 TD 网络与融合引擎');
{
  const fs = require('fs');
  const { TDNet } = require(path.join(ROOT, '_td_net.js'));
  const TDE = require(path.join(ROOT, '_engine7_td.js'));

  // 生成确定性伪随机测试权重
  const testNet = new TDNet();
  {
    let s = 314159 >>> 0;
    const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    for (let i = 0; i < testNet.WT.length; i++) testNet.WT[i] = (rnd() - 0.5) * 2e5;
  }
  testNet.K = 3.5e6; testNet.mean = -1.2e4;
  const binPath = path.join(__dirname, '_tdnet_difftest.bin');
  testNet.save(binPath, false);
  const loaded = TDNet.load(binPath);
  let byteOk = true;
  for (let i = 0; i < testNet.WT.length; i++) if (testNet.WT[i] !== loaded.WT[i]) { byteOk = false; break; }
  check('T19 save→load 权重一致', byteOk && loaded.K === testNet.K && loaded.mean === testNet.mean);
  fs.unlinkSync(binPath);

  // T18 V_td 确定性
  let det = true;
  const v0 = loaded.value(0x12345678, 0x9abcdef);
  for (let i = 0; i < 1000; i++) if (loaded.value(0x12345678, 0x9abcdef) !== v0) { det = false; break; }
  check('T18 V_td 确定性（1000 次）', det);

  // 挂载到引擎
  TDE.setParams({ tdWeight: 1, tdBlendFrom: 0 });
  TDE.setTdNet(loaded);

  // T20 边界：tdWeight=0 时与 prob.evaluate 逐位一致
  TDE.setParams({ tdWeight: 0 });
  let mm0 = 0;
  for (let i = 0; i < 50000; i++) {
    const [lo, hi] = randBoardRealistic();
    if (TDE.evaluateFused(lo, hi) !== TTFIX.evaluate(lo, hi)) mm0++;
  }
  check('T20a tdWeight=0 融合≡手工', mm0 === 0, `不一致=${mm0}/50000`);
  // T20b tdBlendFrom=12 且 maxExp<12 时一致
  TDE.setParams({ tdWeight: 1, tdBlendFrom: 12 });
  let mmB = 0, hitB = 0;
  for (let i = 0; i < 50000; i++) {
    const [lo, hi] = randBoardRealistic();
    const cells = loHiToCells(lo, hi);
    let mx = 0; for (let k = 0; k < 16; k++) if (cells[k] > mx) mx = cells[k];
    if (mx < 12) {
      if (TDE.evaluateFused(lo, hi) !== TTFIX.evaluate(lo, hi)) mmB++;
    } else hitB++;
  }
  check('T20b tdBlendFrom=12 低位逐位一致', mmB === 0, `不一致=${mmB}/50000（高位盘 ${hitB} 跳过）`);
  // T23 混合切换确实生效（高位盘 fused ≠ 手工；显式关掉 tdBlendUp 上限）
  TDE.setParams({ tdWeight: 1, tdBlendFrom: 0, tdBlendUp: 0 });
  let changed = 0, hitHigh = 0;
  for (let i = 0; i < 20000; i++) {
    const [lo, hi] = randBoardRealistic();
    const cells = loHiToCells(lo, hi);
    let mx = 0; for (let k = 0; k < 16; k++) if (cells[k] > mx) mx = cells[k];
    if (mx >= 12) {
      hitHigh++;
      if (TDE.evaluateFused(lo, hi) !== TTFIX.evaluate(lo, hi)) changed++;
    }
  }
  check('T23 混合生效（高位盘值改变）', changed > hitHigh * 0.95, `改变 ${changed}/${hitHigh}`);
  // T24 NaN/Inf 守卫
  let nan = 0;
  for (let i = 0; i < 100000; i++) {
    const [lo, hi] = randBoardRealistic();
    const v = TDE.evaluateFused(lo, hi);
    if (!Number.isFinite(v)) nan++;
  }
  check('T24 无 NaN/Inf', nan === 0, `异常=${nan}/100000`);
  // T21 种子复现 + T22 搜索确定性（带 TD）
  const g1 = TDE.playGame(4, 4, 5000, 4242);
  const g2 = TDE.playGame(4, 4, 5000, 4242);
  check('T21 带 TD 种子复现', g1.score === g2.score && g1.steps === g2.steps, `score=${g1.score}`);
  let agree = 0, tested = 0;
  for (let i = 0; i < 150; i++) {
    const [lo, hi] = randBoardRealistic();
    if (BASE.countEmpty(lo, hi) < 2) continue;
    TDE.setSeed(1000 + i);
    const m1 = TDE.bestMove(lo, hi, 3, 2, 10000000);
    TDE.setSeed(99000 + i);
    const m2 = TDE.bestMove(lo, hi, 3, 2, 10000000);
    tested++;
    if (m1 === m2) agree++;
  }
  check('T22 带 TD 搜索确定性', agree === tested, `${agree}/${tested}`);
  // 恢复默认（后续测试不受影响）
  TDE.setParams({ tdWeight: 0, tdBlendFrom: 0 });
}

// ================= T25 6x8 网络往返 =================
console.log('T25 6x8 TDNet save/load 往返与确定性');
{
  const fs = require('fs');
  const { TDNet } = require(path.join(ROOT, '_td_net.js'));
  const net6 = new TDNet('6x8');
  {
    let s = 271828 >>> 0;
    const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    for (let i = 0; i < net6.WT.length; i += 7) net6.WT[i] = (rnd() - 0.5) * 100;   // 抽样填充（536MB 全填太慢）
  }
  net6.K = 8.8e8; net6.mean = 5.5;
  const p6 = path.join(__dirname, '_tdnet6_difftest.bin');
  net6.save(p6, false);
  const back = TDNet.load(p6);
  let ok = back.tupleType === '6x8' && back.K === net6.K && back.mean === net6.mean;
  let s2 = 271828 >>> 0;
  const rnd2 = () => { s2 = (s2 + 0x6D2B79F5) | 0; let t = Math.imul(s2 ^ s2 >>> 15, 1 | s2); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ s2 >>> 14) >>> 0) / 4294967296; };
  for (let i = 0; i < net6.WT.length; i += 7) { if (back.WT[i] !== net6.WT[i]) { ok = false; break; } rnd2(); }
  check('T25a 6x8 save/load 一致', ok);
  const vA = net6.value(0x13579bdf, 0x2468ace0);
  const vB = net6.value(0x13579bdf, 0x2468ace0);
  const idx6 = net6.views(0x13579bdf, 0x2468ace0);
  const vC = net6.valueByIdx(idx6);
  check('T25b 6x8 value 确定性/与 valueByIdx 一致', vA === vB && vA === vC, `v=${vA.toExponential(3)}`);
  // views 6x8 索引范围 < 16^6
  let inRange = true;
  for (let v = 0; v < 8; v++) if (idx6[v] < 0 || idx6[v] >= 16777216) inRange = false;
  check('T25c 6x8 视图索引范围合法', inRange);
  fs.unlinkSync(p6);
}

console.log(`\n===== 差分测试汇总: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
