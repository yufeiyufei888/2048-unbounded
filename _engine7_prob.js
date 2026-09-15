/*
 * 2048 引擎 v7.3prob —— 全展开 + 概率阈值剪枝 + 终盘加深 + 里程碑诊断
 * ==========================================================================
 * 在 v7.2-inc（平坦精确键 TT + 折叠表）基础上的三项研究升级：
 *
 * 1)【nneonneo 式随机节点处理】全展开 + 累计概率阈值剪枝
 *    旧引擎在空位 9~14 时均匀采样 10 个；本引擎展开**全部空位 × {2(0.9),4(0.1)}**，
 *    并沿搜索树传递累计概率 cprob；当 cprob×分支概率 < cprobThresh(默认 1e-4)
 *    时不再递归、直接用静态 evaluate 代替（与 nneonneo CPROB_THRESH 同思路）。
 *    效果：① 搜索去随机化（同种子下搜索完全确定）；② 期望值无抽样噪声；
 *          ③ 深层低概率分支（尤其 4 方块分支）自动剪枝，为 depth7+ 打开可行域。
 *    注：TT 键不含 cprob（nneonneo 同样处理），同棋盘不同 cprob 命中同一表项，
 *        属可接受近似。
 *
 * 2)【终盘加深】deepOnMaxExp（默认 0=关）：当棋盘最大方块 ≥ 2^deepOnMaxExp
 *    （如 13=8192）时搜索深度 +1——把算力集中到 16384 冲刺阶段。
 *
 * 3)【里程碑诊断】playGame 返回 diag：4096/8192/16384 首次达成步数、
 *    达成时剩余空位、第二个 8192 出现步数、死局时最大块/空位/是否存在
 *    exp≥12 的相邻同值对（检验「对齐失败」假设）。
 *
 * 评价函数与 v7.1 完全一致（指数蛇形 base=4.5 + 空位/单调/平滑/危险项）。
 */
'use strict';

const ENGINE_TAG = 'v7.3-prob';

const POW2 = new Float64Array(40);
for (let i = 0; i < 40; i++) POW2[i] = Math.pow(2, i);

let rng = Math.random;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function setSeed(seed) { rng = mulberry32(seed >>> 0); }
function clearSeed() { rng = Math.random; }

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

const SNAKE_POS = new Int32Array([
   0,  1,  2,  3,
   7,  6,  5,  4,
   8,  9, 10, 11,
  15, 14, 13, 12
]);

let P = {
  base: 4.5,
  wEmpty: 60000,
  wMono: 3.0,
  wSmooth: 6.0,
  dEmpty1: 400000,
  dEmpty2: 60000,
  phaseExp: 12,
  wMobility: 0,
  wMerge: 0,
  wCorner: 0,
  wDeadEnd: 0,
  cprobThresh: 1e-4,     // 概率阈值剪枝（0 = 关闭，全展开不剪）
  deepOnMaxExp: 0,       // 最大方块 ≥ 2^该值 时深度 +1（0 = 关闭）
  // 双尺度评价（针对 8192→16384 瓶颈的诊断修复）：
  // 诊断显示首个 8192 出现后 0% 能再造第二个 8192——8192 主项(~2.8e14)淹没
  // 第二链 4096 项(仅主项 0.02%)。dualBase>0 时，当棋盘 maxExp ≥ dualStartExp，
  // 蛇形项切换到低底数 dualBase 的行表（第二链权重放大约 (base/dualBase)^k 倍），
  // 并对最大块做补偿项使其仍为主项，但不再淹没其余方块。
  dualBase: 0,
  dualStartExp: 13,
  // 分段评价切换（第二轮对症实验）：maxExp ≥ after13nnExp 后整体切换到
  // nneonneo 式有界评价（空位^1.5×270 + 合并×700 − rank^3.5×11 − rank⁴单调×47），
  // 其 merges 高权重直接激励 4096+4096 相邻合并（第二链的关键动作）。
  after13nn: 0,
  after13nnExp: 13
};

const ROW_SNAKE_BY_R = [];
const ROW_SUM_BY_R = [];
const ROW_EMPTY_CNT = new Uint8Array(ROW_LUT_SIZE);
const ROW_INC = new Float64Array(ROW_LUT_SIZE);
const ROW_DEC = new Float64Array(ROW_LUT_SIZE);
const ROW_SMOOTH = new Float64Array(ROW_LUT_SIZE);
const COL_INC = new Float64Array(ROW_LUT_SIZE);
const COL_DEC = new Float64Array(ROW_LUT_SIZE);
const COL_SMOOTH = new Float64Array(ROW_LUT_SIZE);
const ROW_MONO_MAX = new Float64Array(ROW_LUT_SIZE);
const COL_MONO_MAX = new Float64Array(ROW_LUT_SIZE);

function buildTables(base) {
  const SW = new Float64Array(16);
  for (let k = 0; k < 16; k++) SW[k] = Math.pow(base, 15 - k);
  ROW_SNAKE_BY_R.length = 0; ROW_SUM_BY_R.length = 0;
  for (let r = 0; r < 4; r++) {
    const snakeTab = new Float64Array(ROW_LUT_SIZE);
    const sumTab = new Float64Array(ROW_LUT_SIZE);
    for (let row = 0; row < ROW_LUT_SIZE; row++) {
      const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
      const cs = [c0, c1, c2, c3];
      let sq = 0, sm = 0;
      for (let c = 0; c < 4; c++) {
        const e = cs[c];
        if (e === 0) continue;
        sq += POW2[e] * SW[SNAKE_POS[r * 4 + c]];
        sm += POW2[e];
      }
      snakeTab[row] = sq; sumTab[row] = sm;
    }
    ROW_SNAKE_BY_R.push(snakeTab); ROW_SUM_BY_R.push(sumTab);
  }
}
function buildCommonTables() {
  for (let row = 0; row < ROW_LUT_SIZE; row++) {
    const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
    const cs = [c0, c1, c2, c3];
    let emp = 0, smooth = 0, inc = 0, dec = 0;
    for (let c = 0; c < 4; c++) if (cs[c] === 0) emp++;
    for (let c = 0; c < 3; c++) {
      const a = cs[c], b = cs[c + 1];
      if (a && b) { const d = Math.abs(POW2[a] - POW2[b]); smooth += d; if (b > a) dec += d; else inc += d; }
    }
    ROW_EMPTY_CNT[row] = emp; ROW_SMOOTH[row] = smooth; ROW_INC[row] = inc; ROW_DEC[row] = dec;
    COL_SMOOTH[row] = smooth; COL_INC[row] = inc; COL_DEC[row] = dec;
    ROW_MONO_MAX[row] = inc > dec ? inc : dec;
    COL_MONO_MAX[row] = inc > dec ? inc : dec;
  }
}
buildCommonTables();
buildTables(P.base);
// 低底数行表（双尺度评价用）
const ROW_SNAKE_LOW_BY_R = [];
function buildLowTables(lowBase) {
  ROW_SNAKE_LOW_BY_R.length = 0;
  if (!lowBase || lowBase <= 0) return;
  const SWL = new Float64Array(16);
  for (let k = 0; k < 16; k++) SWL[k] = Math.pow(lowBase, 15 - k);
  for (let r = 0; r < 4; r++) {
    const tab = new Float64Array(ROW_LUT_SIZE);
    for (let row = 0; row < ROW_LUT_SIZE; row++) {
      const c0 = (row >> 12) & 0xF, c1 = (row >> 8) & 0xF, c2 = (row >> 4) & 0xF, c3 = row & 0xF;
      const cs = [c0, c1, c2, c3];
      let sq = 0;
      for (let c = 0; c < 4; c++) {
        const e = cs[c];
        if (e === 0) continue;
        sq += POW2[e] * SWL[SNAKE_POS[r * 4 + c]];
      }
      tab[row] = sq;
    }
    ROW_SNAKE_LOW_BY_R.push(tab);
  }
}
let COMP_HIGH = 0, COMP_LOW = 0;   // 主块补偿量：base^15 与 dualBase^15
const BR_W = new Float64Array(16), LR_W = new Float64Array(16);
// nneonneo 式每行启发表（分段评价切换用）
const NN_HEUR = new Float64Array(ROW_LUT_SIZE);
function nnScoreRow(row) {
  const r0 = (row >> 12) & 0xF, r1 = (row >> 8) & 0xF, r2 = (row >> 4) & 0xF, r3 = row & 0xF;
  const cs = [r0, r1, r2, r3];
  let empties = 0, sum = 0, merges = 0;
  for (let i = 0; i < 4; i++) { const e = cs[i]; if (e === 0) empties++; else sum += Math.pow(e, 3.5); }
  let run = 1;
  for (let i = 1; i < 4; i++) { if (cs[i] !== 0 && cs[i] === cs[i - 1]) run++; else { if (run > 1) merges += 1 + (run - 1); run = 1; } }
  if (run > 1) merges += 1 + (run - 1);
  let monoL = 0, monoR = 0;
  for (let i = 1; i < 4; i++) { const a = cs[i - 1], b = cs[i]; if (a > b) monoL += Math.pow(a, 4) - Math.pow(b, 4); else if (b > a) monoR += Math.pow(b, 4) - Math.pow(a, 4); }
  return 270 * Math.pow(empties, 1.5) + 700 * merges - 11 * sum - 47 * Math.min(monoL, monoR);
}
function buildNNTables() { for (let row = 0; row < ROW_LUT_SIZE; row++) NN_HEUR[row] = nnScoreRow(row); }
buildNNTables();
function setParams(np) {
  P = Object.assign({}, P, np);
  buildTables(P.base);
  buildLowTables(P.dualBase);
  COMP_HIGH = Math.pow(P.base, 15);
  COMP_LOW = P.dualBase > 0 ? Math.pow(P.dualBase, 15) : 0;
  for (let k = 0; k < 16; k++) {
    BR_W[k] = Math.pow(P.base, 15 - k);
    LR_W[k] = P.dualBase > 0 ? Math.pow(P.dualBase, 15 - k) : 0;
  }
}

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

// ---------- 评估（折叠查表 + 可选双尺度）----------
function evaluate(lo, hi) {
  const r0 = lo & 0xFFFF, r1 = (lo >>> 16) & 0xFFFF, r2 = hi & 0xFFFF, r3 = (hi >>> 16) & 0xFFFF;
  const dualOn = P.dualBase > 0;
  const nnOn = P.after13nn > 0;
  const needMax = dualOn || nnOn || P.wMobility || P.wMerge || P.wCorner || P.wDeadEnd;
  let maxExp = 0, bestRank = 15, comp = 0;
  if (needMax) {
    for (let r = 0; r < 4; r++) {
      const row = r === 0 ? r0 : r === 1 ? r1 : r === 2 ? r2 : r3;
      for (let c = 0; c < 4; c++) {
        const e = (row >>> (12 - 4 * c)) & 0xF;
        if (e === 0) continue;
        const rank = SNAKE_POS[r * 4 + c];
        if (e > maxExp) {
          maxExp = e; bestRank = rank;
          comp = (dualOn && e >= P.dualStartExp) ? POW2[e] * (BR_W[rank] - LR_W[rank]) : 0;
        } else if (e === maxExp) {
          if (rank < bestRank) bestRank = rank;
          if (dualOn && e >= P.dualStartExp) comp += POW2[e] * (BR_W[rank] - LR_W[rank]);
        }
      }
    }
  }
  // 分段切换：8192 后整体换 nn 有界评价（表内含空位/合并/单调项）
  if (nnOn && maxExp >= P.after13nnExp) {
    const c0n = ((r0 & 0xF000)) | ((r1 & 0xF000) >>> 4) | ((r2 & 0xF000) >>> 8) | ((r3 & 0xF000) >>> 12);
    const c1n = ((r0 & 0x0F00) << 4) | (r1 & 0x0F00) | ((r2 & 0x0F00) >>> 4) | ((r3 & 0x0F00) >>> 8);
    const c2n = ((r0 & 0x00F0) << 8) | ((r1 & 0x00F0) << 4) | (r2 & 0x00F0) | ((r3 & 0x00F0) >>> 4);
    const c3n = ((r0 & 0x000F) << 12) | ((r1 & 0x000F) << 8) | ((r2 & 0x000F) << 4) | (r3 & 0x000F);
    return NN_HEUR[r0] + NN_HEUR[r1] + NN_HEUR[r2] + NN_HEUR[r3]
         + NN_HEUR[c0n] + NN_HEUR[c1n] + NN_HEUR[c2n] + NN_HEUR[c3n];
  }
  let s;
  if (dualOn && maxExp >= P.dualStartExp) {
    // 双尺度：其余方块用低底数表（第二链可见），最大块按原尺度补偿
    s = ROW_SNAKE_LOW_BY_R[0][r0] + ROW_SNAKE_LOW_BY_R[1][r1] + ROW_SNAKE_LOW_BY_R[2][r2] + ROW_SNAKE_LOW_BY_R[3][r3] + comp;
  } else {
    s = ROW_SNAKE_BY_R[0][r0] + ROW_SNAKE_BY_R[1][r1] + ROW_SNAKE_BY_R[2][r2] + ROW_SNAKE_BY_R[3][r3];
  }
  let mono = ROW_MONO_MAX[r0] + ROW_MONO_MAX[r1] + ROW_MONO_MAX[r2] + ROW_MONO_MAX[r3];
  const c0 = ((r0 & 0xF000)) | ((r1 & 0xF000) >>> 4) | ((r2 & 0xF000) >>> 8) | ((r3 & 0xF000) >>> 12);
  const c1 = ((r0 & 0x0F00) << 4) | (r1 & 0x0F00) | ((r2 & 0x0F00) >>> 4) | ((r3 & 0x0F00) >>> 8);
  const c2 = ((r0 & 0x00F0) << 8) | ((r1 & 0x00F0) << 4) | (r2 & 0x00F0) | ((r3 & 0x00F0) >>> 4);
  const c3 = ((r0 & 0x000F) << 12) | ((r1 & 0x000F) << 8) | ((r2 & 0x000F) << 4) | (r3 & 0x000F);
  mono += COL_MONO_MAX[c0] + COL_MONO_MAX[c1] + COL_MONO_MAX[c2] + COL_MONO_MAX[c3];
  let smooth = ROW_SMOOTH[r0] + ROW_SMOOTH[r1] + ROW_SMOOTH[r2] + ROW_SMOOTH[r3]
             + COL_SMOOTH[c0] + COL_SMOOTH[c1] + COL_SMOOTH[c2] + COL_SMOOTH[c3];
  const empty = ROW_EMPTY_CNT[r0] + ROW_EMPTY_CNT[r1] + ROW_EMPTY_CNT[r2] + ROW_EMPTY_CNT[r3];
  s += mono * P.wMono;
  s -= smooth * P.wSmooth;
  s += empty * P.wEmpty;
  if (empty <= 1) s -= P.dEmpty1;
  else if (empty === 2) s -= P.dEmpty2;

  if (P.wMobility || P.wMerge || P.wCorner || P.wDeadEnd) {
    const phase = maxExp >= P.phaseExp ? 1 : (maxExp + 1 === P.phaseExp ? 0.35 : 0);
    if (phase) {
      const movable =
        (MOVE_LUT[r0] !== r0 || RIGHT_LUT[r0] !== r0 ? 1 : 0) +
        (MOVE_LUT[r1] !== r1 || RIGHT_LUT[r1] !== r1 ? 1 : 0) +
        (MOVE_LUT[r2] !== r2 || RIGHT_LUT[r2] !== r2 ? 1 : 0) +
        (MOVE_LUT[r3] !== r3 || RIGHT_LUT[r3] !== r3 ? 1 : 0) +
        (MOVE_LUT[c0] !== c0 || RIGHT_LUT[c0] !== c0 ? 1 : 0) +
        (MOVE_LUT[c1] !== c1 || RIGHT_LUT[c1] !== c1 ? 1 : 0) +
        (MOVE_LUT[c2] !== c2 || RIGHT_LUT[c2] !== c2 ? 1 : 0) +
        (MOVE_LUT[c3] !== c3 || RIGHT_LUT[c3] !== c3 ? 1 : 0);
      const merge = SCORE_LUT[r0] + SCORE_LUT[r1] + SCORE_LUT[r2] + SCORE_LUT[r3]
        + SCORE_LUT[c0] + SCORE_LUT[c1] + SCORE_LUT[c2] + SCORE_LUT[c3];
      const scale = POW2[maxExp];
      s += phase * (P.wMobility * movable * scale + P.wMerge * merge + P.wCorner * (15 - bestRank) * scale);
      if (movable <= 1) s -= phase * P.wDeadEnd * scale;
    }
  }
  return s;
}

// ---------- 平坦类型数组 TT（精确键）----------
const TT_BITS = 21;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const TT_KLO = new Uint32Array(TT_SIZE);
const TT_KHI = new Uint32Array(TT_SIZE);
const TT_TAG = new Uint8Array(TT_SIZE);
const TT_VAL = new Float64Array(TT_SIZE);
const TT_PROBE = 8;

// ---------- Expectimax ----------
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
const SNAP = []; for (let i = 0; i < 12; i++) SNAP.push(new Int32Array(16));
function countEmpty(lo, hi) {
  let n = 0, r;
  r = lo & 0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = (lo>>>16)&0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = hi & 0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  r = (hi>>>16)&0xFFFF; if (!(r&0xF000))n++; if(!(r&0x0F00))n++; if(!(r&0x00F0))n++; if(!(r&0x000F))n++;
  return n;
}

// 全展开 + 概率阈值剪枝的随机节点；cprob = 到达本节点的累计概率
function exitimax(lo, hi, depth, player, limit, cprob) {
  if (depth === 0) return evaluate(lo, hi);
  if (++NODE_COUNT > NODE_BUDGET) return evaluate(lo, hi);
  const tag = (depth << 1) | player;
  let idx = (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77) ^ Math.imul(tag, 0xC2B2AE3D)) >>> 0 & TT_MASK;
  for (let p = 0; p < TT_PROBE; p++) {
    const t = TT_TAG[idx];
    if (t === 0) break;
    if (t === tag && TT_KLO[idx] === lo && TT_KHI[idx] === hi) return TT_VAL[idx];
    idx = (idx + 1) & TT_MASK;
  }
  let result;
  if (player) {
    let best = -Infinity;
    for (let i = 0; i < 4; i++) {
      B_LO = lo; B_HI = hi;
      if (!moveDir(i)) continue;
      const cl = B_LO, ch = B_HI;
      const v = exitimax(cl, ch, depth - 1, false, limit, cprob);
      if (v > best) best = v;
    }
    result = best === -Infinity ? evaluate(lo, hi) - 1e12 : best;
  } else {
    const nEmp = collectEmpty(lo, hi);
    if (!nEmp) result = exitimax(lo, hi, depth - 1, true, limit, cprob);
    else {
      const snap = SNAP[depth < 12 ? depth : 11];
      for (let k = 0; k < nEmp; k++) snap[k] = EMPTY_IDX[k];
      let sum = 0;
      const p2 = 0.9 / nEmp, p4 = 0.1 / nEmp;
      const cp2 = cprob * p2, cp4 = cprob * p4;
      const cut2 = P.cprobThresh > 0 && cp2 < P.cprobThresh;
      const cut4 = P.cprobThresh > 0 && cp4 < P.cprobThresh;
      for (let k = 0; k < nEmp; k++) {
        const cell = snap[k];
        const rr = (cell / 4) | 0, cc = cell % 4;
        const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
        let l2 = lo, h2 = hi, l4 = lo, h4 = hi;
        if (rr < 2) { l2 = (lo | (1 << sh)) >>> 0; l4 = (lo | (2 << sh)) >>> 0; }
        else { h2 = (hi | (1 << sh)) >>> 0; h4 = (hi | (2 << sh)) >>> 0; }
        // 2 方块（90%）
        if (cut2) sum += p2 * evaluate(l2, h2);
        else sum += p2 * exitimax(l2, h2, depth - 1, true, limit, cp2);
        // 4 方块（10%）
        if (cut4) sum += p4 * evaluate(l4, h4);
        else sum += p4 * exitimax(l4, h4, depth - 1, true, limit, cp4);
      }
      result = sum;   // 概率加权，无需再除
    }
  }
  let j = (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77) ^ Math.imul(tag, 0xC2B2AE3D)) >>> 0 & TT_MASK;
  let stored = false;
  for (let p = 0; p < TT_PROBE; p++) {
    const t = TT_TAG[j];
    if (t === 0 || (t === tag && TT_KLO[j] === lo && TT_KHI[j] === hi)) {
      TT_TAG[j] = tag; TT_KLO[j] = lo; TT_KHI[j] = hi; TT_VAL[j] = result; stored = true; break;
    }
    j = (j + 1) & TT_MASK;
  }
  if (!stored) { TT_TAG[j] = tag; TT_KLO[j] = lo; TT_KHI[j] = hi; TT_VAL[j] = result; }
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
    const v = exitimax(cl, ch, depth - 1, false, limit, 1);
    if (v > best + 1e-7) { best = v; pick = [i]; }
    else if (Math.abs(v - best) <= 1e-7) pick.push(i);
  }
  return pick.length ? pick[(rng() * pick.length) | 0] : -1;
}

// ---------- 诊断：棋盘统计 ----------
// 返回 {maxExp, big13Count, bigPair}；bigPair = 是否存在 exp≥12 的相邻同值对
function boardStats(lo, hi) {
  const r0 = lo & 0xFFFF, r1 = (lo >>> 16) & 0xFFFF, r2 = hi & 0xFFFF, r3 = (hi >>> 16) & 0xFFFF;
  const rows = [r0, r1, r2, r3];
  let maxExp = 0, big13 = 0, bigPair = 0;
  for (let r = 0; r < 4; r++) {
    const row = rows[r];
    let prev = -1;
    for (let c = 0; c < 4; c++) {
      const e = (row >>> (12 - 4 * c)) & 0xF;
      if (e > maxExp) maxExp = e;
      if (e >= 12) {
        if (e >= 13) big13++;
        if (e === prev) bigPair = 1;
      }
      prev = e;
    }
  }
  // 列方向
  for (let c = 0; c < 4; c++) {
    let prev = -1;
    for (let r = 0; r < 4; r++) {
      const row = rows[r];
      const e = (row >>> (12 - 4 * c)) & 0xF;
      if (e >= 12 && e === prev) bigPair = 1;
      prev = e;
    }
  }
  return { maxExp, big13, bigPair };
}

function playGame(depth, limit, budget, seed) {
  if (seed !== undefined && seed !== null) rng = mulberry32(seed >>> 0);
  TT_TAG.fill(0);
  B_LO = 0; B_HI = 0;
  for (let k = 0; k < 2; k++) {
    collectEmpty(B_LO, B_HI);
    const idx = EMPTY_IDX[(rng() * EMPTY_N) | 0];
    const rr = (idx / 4) | 0, cc = idx % 4;
    const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
    const e = rng() < 0.9 ? 1 : 2;
    if (rr < 2) B_LO = (B_LO | (e << sh)) >>> 0; else B_HI = (B_HI | (e << sh)) >>> 0;
  }
  let score = 0, steps = 0, maxExp = 0;
  // 里程碑诊断
  const diag = { stepAt12: -1, stepAt13: -1, stepAt14: -1, empAt12: -1, empAt13: -1, step2nd13: -1, deathExp: 0, deathEmp: 0, deathBigPair: 0 };
  while (steps < 300000) {
    const lo = B_LO, hi = B_HI;
    const empty = countEmpty(lo, hi);
    let d = depth + (empty <= 3 ? 1 : 0);
    if (P.deepOnMaxExp > 0 && maxExp >= P.deepOnMaxExp) d += 1;
    if (d > 9) d = 9;
    const mv = bestMove(lo, hi, d, limit, budget);
    if (mv < 0) break;
    B_LO = lo; B_HI = hi;
    if (!moveDir(mv)) break;
    score += G;
    collectEmpty(B_LO, B_HI);
    if (EMPTY_N === 0) break;
    const idx = EMPTY_IDX[(rng() * EMPTY_N) | 0];
    const rr = (idx / 4) | 0, cc = idx % 4;
    const sh = (rr < 2 ? 16 * rr : 16 * (rr - 2)) + (12 - 4 * cc);
    const e = rng() < 0.9 ? 1 : 2;
    if (rr < 2) B_LO = (B_LO | (e << sh)) >>> 0; else B_HI = (B_HI | (e << sh)) >>> 0;
    steps++;
    // 里程碑统计（每步一次轻量扫描）
    const st = boardStats(B_LO, B_HI);
    maxExp = st.maxExp;
    if (diag.stepAt12 < 0 && maxExp >= 12) { diag.stepAt12 = steps; diag.empAt12 = countEmpty(B_LO, B_HI); }
    if (diag.stepAt13 < 0 && maxExp >= 13) { diag.stepAt13 = steps; diag.empAt13 = countEmpty(B_LO, B_HI); }
    if (diag.stepAt14 < 0 && maxExp >= 14) diag.stepAt14 = steps;
    if (diag.step2nd13 < 0 && st.big13 >= 2) diag.step2nd13 = steps;
    let can = false; const sl = B_LO, shh = B_HI;
    for (let i = 0; i < 4; i++) { B_LO = sl; B_HI = shh; if (moveDir(i)) { can = true; break; } }
    B_LO = sl; B_HI = shh;
    if (!can) break;
  }
  readCells(B_LO, B_HI);
  const fin = boardStats(B_LO, B_HI);
  maxExp = fin.maxExp;
  diag.deathExp = maxExp;
  diag.deathEmp = countEmpty(B_LO, B_HI);
  diag.deathBigPair = fin.bigPair;
  return { score, steps, maxExp, diag };
}

module.exports = { playGame, setParams, getParams: () => P, evaluate, readCells, CELLS, bestMove, moveDir, setBoard: (l,h)=>{B_LO=l>>>0;B_HI=h>>>0;}, getBoard: ()=>({lo:B_LO,hi:B_HI}), countEmpty, getGain: () => G, setSeed, clearSeed, ENGINE_TAG };
