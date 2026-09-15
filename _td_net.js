/*
 * _td_net.js —— N-Tuple 网络（4-tuple × 8 视图）+ 加性融合校准
 * ==========================================================================
 * 视图定义（与引擎 evaluate 的查表完全同构，O(1) 无 nibble 抽取）：
 *   视图 0..3 = 行字 r0..r3（lo/hi 的 4 个 16bit 半字，自上而下）
 *   视图 4..7 = 列转置字 c0..c3（c0 的 nibble 自上而下 = 第 0 列各行）
 * V_td(lo,hi) = Σ_{v=0..7} WT[v*65536 + word_v]
 *
 * 融合：V_fused = V_hand + tdRelWeight·K_unit·(V_td − mean)，其中
 *   K_unit = std(V_hand)/std(V_td)（校准集上测得），实际融合系数 K = tdRelWeight·K_unit。
 * 校准集优先用「自博弈实际决策局面」（训练器训练结束时产出，分布最贴近实战），
 * 无则退回随机棋盘。
 *
 * 二进制格式（小端）：
 *   header: magic 'TDN1'(4B) | version u32 | tupleType u32 | nViews u32 | viewSize u32
 *           | K f64 | mean f64
 *   body:   nViews*viewSize 个 Float32 权重
 *   训练状态块（checkpoint 追加，可选）: step f64 | gamesDone f64 | alpha f64 | rngState u32
 */
'use strict';

const fs = require('fs');

const MAGIC = 0x314e4454;          // 'TDN1' 小端
const VERSION = 1;
const HEADER_SIZE = 4 + 4 + 4 + 4 + 4 + 8 + 8;   // 36B
const STATE_SIZE = 8 + 8 + 8 + 4;                // 28B

// 6-tuple×8 视图的 cell 索引表（每视图 6 格；行版 4 + 列版 4，行列对称，
// 每个视图 = 一行/列 4 格 + 相邻行/列端部 2 格——文献标准 6-tuple 形状的行列对称近似）
const VIEWS6 = [
  [0, 1, 2, 3, 4, 5],        // 行0 + 行1 左2
  [4, 5, 6, 7, 0, 1],        // 行1 + 行0 左2
  [8, 9, 10, 11, 4, 5],      // 行2 + 行1 左2
  [12, 13, 14, 15, 8, 9],    // 行3 + 行2 左2
  [0, 4, 8, 12, 1, 5],       // 列0 + 列1 上2
  [1, 5, 9, 13, 0, 4],       // 列1 + 列0 上2
  [2, 6, 10, 14, 1, 5],      // 列2 + 列1 上2
  [3, 7, 11, 15, 2, 6]       // 列3 + 列2 上2
];
const TMP16 = new Int32Array(16);

class TDNet {
  constructor(tupleType = '4x8') {
    this.tupleType = tupleType;
    if (tupleType === '4x8') {
      this.nViews = 8;
      this.viewSize = 65536;                          // 16^4
      this.WT = new Float32Array(this.nViews * this.viewSize);   // 2MB
    } else if (tupleType === '6x8') {
      this.nViews = 8;
      this.viewSize = 16777216;                       // 16^6
      this.WT = new Float32Array(this.nViews * this.viewSize);   // 536MB
    } else throw new Error('未知 tupleType: ' + tupleType);
    this.K = 0;            // 融合系数（含 tdRelWeight）
    this.mean = 0;         // V_td 校准均值
    this.tdRelWeight = 0.03;
    // 训练状态
    this.step = 0;
    this.gamesDone = 0;
    this.alpha = 0.1;
    this.rngState = 0;
  }

  // 8 个视图字（Int32Array(8) 复用外部缓冲）；6x8 的「字」= 24bit 组装索引
  views(lo, hi, out) {
    const r0 = lo & 0xFFFF, r1 = (lo >>> 16) & 0xFFFF, r2 = hi & 0xFFFF, r3 = (hi >>> 16) & 0xFFFF;
    const o = out || TMP_IDX;
    if (this.tupleType === '4x8') {
      o[0] = r0; o[1] = r1; o[2] = r2; o[3] = r3;
      o[4] = ((r0 & 0xF000))        | ((r1 & 0xF000) >>> 4) | ((r2 & 0xF000) >>> 8) | ((r3 & 0xF000) >>> 12);
      o[5] = ((r0 & 0x0F00) << 4)   | (r1 & 0x0F00)        | ((r2 & 0x0F00) >>> 4) | ((r3 & 0x0F00) >>> 8);
      o[6] = ((r0 & 0x00F0) << 8)   | ((r1 & 0x00F0) << 4) | (r2 & 0x00F0)         | ((r3 & 0x00F0) >>> 4);
      o[7] = ((r0 & 0x000F) << 12)  | ((r1 & 0x000F) << 8) | ((r2 & 0x000F) << 4)  | (r3 & 0x000F);
      return o;
    }
    // 6x8：逐格 nibble 组装
    const E = TMP16;
    E[0]=(r0>>>12)&0xF; E[1]=(r0>>>8)&0xF; E[2]=(r0>>>4)&0xF; E[3]=r0&0xF;
    E[4]=(r1>>>12)&0xF; E[5]=(r1>>>8)&0xF; E[6]=(r1>>>4)&0xF; E[7]=r1&0xF;
    E[8]=(r2>>>12)&0xF; E[9]=(r2>>>8)&0xF; E[10]=(r2>>>4)&0xF; E[11]=r2&0xF;
    E[12]=(r3>>>12)&0xF; E[13]=(r3>>>8)&0xF; E[14]=(r3>>>4)&0xF; E[15]=r3&0xF;
    for (let v = 0; v < 8; v++) {
      const cells = VIEWS6[v];
      o[v] = E[cells[0]] | (E[cells[1]] << 4) | (E[cells[2]] << 8) | (E[cells[3]] << 12) | (E[cells[4]] << 16) | (E[cells[5]] << 20);
    }
    return o;
  }

  value(lo, hi) {
    const r0 = lo & 0xFFFF, r1 = (lo >>> 16) & 0xFFFF, r2 = hi & 0xFFFF, r3 = (hi >>> 16) & 0xFFFF;
    const W = this.WT, S = this.viewSize;
    if (this.tupleType === '4x8') {
      return W[r0] + W[S + r1] + W[2 * S + r2] + W[3 * S + r3]
           + W[4 * S + (((r0 & 0xF000))        | ((r1 & 0xF000) >>> 4) | ((r2 & 0xF000) >>> 8) | ((r3 & 0xF000) >>> 12))]
           + W[5 * S + (((r0 & 0x0F00) << 4)   | (r1 & 0x0F00)        | ((r2 & 0x0F00) >>> 4) | ((r3 & 0x0F00) >>> 8))]
           + W[6 * S + (((r0 & 0x00F0) << 8)   | ((r1 & 0x00F0) << 4) | (r2 & 0x00F0)         | ((r3 & 0x00F0) >>> 4))]
           + W[7 * S + (((r0 & 0x000F) << 12)  | ((r1 & 0x000F) << 8) | ((r2 & 0x000F) << 4)  | (r3 & 0x000F))];
    }
    // 6x8
    const E = TMP16;
    E[0]=(r0>>>12)&0xF; E[1]=(r0>>>8)&0xF; E[2]=(r0>>>4)&0xF; E[3]=r0&0xF;
    E[4]=(r1>>>12)&0xF; E[5]=(r1>>>8)&0xF; E[6]=(r1>>>4)&0xF; E[7]=r1&0xF;
    E[8]=(r2>>>12)&0xF; E[9]=(r2>>>8)&0xF; E[10]=(r2>>>4)&0xF; E[11]=r2&0xF;
    E[12]=(r3>>>12)&0xF; E[13]=(r3>>>8)&0xF; E[14]=(r3>>>4)&0xF; E[15]=r3&0xF;
    let s = 0;
    for (let v = 0; v < 8; v++) {
      const cells = VIEWS6[v];
      s += W[v * S + (E[cells[0]] | (E[cells[1]] << 4) | (E[cells[2]] << 8) | (E[cells[3]] << 12) | (E[cells[4]] << 16) | (E[cells[5]] << 20))];
    }
    return s;
  }

  // Vidx：由视图索引数组取值（训练器迹更新路径）
  valueByIdx(idx8) {
    const W = this.WT, S = this.viewSize;
    return W[idx8[0]] + W[S + idx8[1]] + W[2 * S + idx8[2]] + W[3 * S + idx8[3]]
         + W[4 * S + idx8[4]] + W[5 * S + idx8[5]] + W[6 * S + idx8[6]] + W[7 * S + idx8[7]];
  }

  // 校准：boardProvider(cb) 逐个产出 [lo,hi]（同步回调，上限 nSamples 个）；handEval(lo,hi)->number
  // 校准内容：mean(V_td)、K = tdRelWeight * std(V_hand)/std(V_td)
  calibrate(boardProvider, handEval, nSamples) {
    const n = nSamples || 5000;
    const idx = new Int32Array(8);
    let sumH = 0, sumH2 = 0, sumT = 0, sumT2 = 0;
    let cnt = 0;
    boardProvider((lo, hi) => {
      if (cnt >= n) return;
      const h = handEval(lo, hi);
      const t = this.value(lo, hi);
      sumH += h; sumH2 += h * h;
      sumT += t; sumT2 += t * t;
      cnt++;
    });
    if (cnt < 100) throw new Error('校准样本不足: ' + cnt);
    const meanH = sumH / cnt, varH = Math.max(1e-9, sumH2 / cnt - meanH * meanH);
    const meanT = sumT / cnt, varT = Math.max(1e-9, sumT2 / cnt - meanT * meanT);
    this.mean = meanT;
    this.K = this.tdRelWeight * Math.sqrt(varH) / Math.sqrt(varT);
    return { K: this.K, mean: this.mean, stdH: Math.sqrt(varH), stdT: Math.sqrt(varT), n: cnt };
  }

  // 兄弟校准：决策粒度的 K —— 对每个采样盘取合法动作的 afterstate 兄弟组，
  // 以「组内 std(V_hand) 与 std(V_td) 之比」校准 K，mean 取兄弟组 V_td 均值的平均。
  // 比随机盘校准更贴近搜索中的实际比较粒度（随机盘 std 被大块位置差异主导，
  // 曾导致 K 偏大、搜索崩溃——tdscout03 侦察教训）。
  calibrateSibling(groupProvider, handEval, nGroups) {
    const n = nGroups || 3000;
    let sumVH = 0, sumVT = 0, sumMeanT = 0, cnt = 0, leafCnt = 0;
    groupProvider((loArr, hiArr) => {
      if (cnt >= n) return;
      if (loArr.length < 2) return;
      let mh = 0, mt = 0;
      const hs = [], ts = [];
      for (let i = 0; i < loArr.length; i++) {
        const h = handEval(loArr[i], hiArr[i]);
        const t = this.value(loArr[i], hiArr[i]);
        hs.push(h); ts.push(t);
        mh += h; mt += t; leafCnt++;
      }
      mh /= loArr.length; mt /= loArr.length;
      for (let i = 0; i < loArr.length; i++) {
        sumVH += (hs[i] - mh) * (hs[i] - mh);
        sumVT += (ts[i] - mt) * (ts[i] - mt);
      }
      sumMeanT += mt;
      cnt++;
    });
    if (cnt < 200 || leafCnt < 1000) throw new Error('兄弟校准样本不足: 组=' + cnt + ' 叶=' + leafCnt);
    const varH = Math.max(1e-9, sumVH / leafCnt);
    const varT = Math.max(1e-9, sumVT / leafCnt);
    this.mean = sumMeanT / cnt;
    this.K = this.tdRelWeight * Math.sqrt(varH) / Math.sqrt(varT);
    return { K: this.K, mean: this.mean, stdH: Math.sqrt(varH), stdT: Math.sqrt(varT), groups: cnt, leaves: leafCnt };
  }

  // 融合值（引擎端调用）
  fused(lo, hi, handVal) {
    return handVal + this.K * (this.value(lo, hi) - this.mean);
  }

  maxAbsW() {
    let m = 0;
    for (let i = 0; i < this.WT.length; i++) { const a = Math.abs(this.WT[i]); if (a > m) m = a; }
    return m;
  }

  save(path, withTrainingState) {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt32LE(VERSION, 4);
    header.writeUInt32LE(this.tupleType === '6x8' ? 1 : 0, 8);
    header.writeUInt32LE(this.nViews, 12);
    header.writeUInt32LE(this.viewSize, 16);
    header.writeDoubleLE(this.K, 20);
    header.writeDoubleLE(this.mean, 28);
    const fd = fs.openSync(path, 'w');
    try {
      fs.writeSync(fd, header);
      // 分块写权重（6x8 为 536MB，避免一次性大 Buffer）
      const wBuf = Buffer.from(this.WT.buffer, this.WT.byteOffset, this.WT.byteLength);
      const CHUNK = 64 * 1024 * 1024;
      for (let off = 0; off < wBuf.length; off += CHUNK) {
        fs.writeSync(fd, wBuf, off, Math.min(CHUNK, wBuf.length - off));
      }
      if (withTrainingState) {
        const st = Buffer.alloc(STATE_SIZE);
        st.writeDoubleLE(this.step, 0);
        st.writeDoubleLE(this.gamesDone, 8);
        st.writeDoubleLE(this.alpha, 16);
        st.writeUInt32LE(this.rngState >>> 0, 24);
        fs.writeSync(fd, st);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  static load(path) {
    const buf = fs.readFileSync(path);
    if (buf.length < HEADER_SIZE) throw new Error('TDNet 文件过小: ' + path);
    if (buf.readUInt32LE(0) !== MAGIC) throw new Error('TDNet magic 不匹配: ' + path);
    const version = buf.readUInt32LE(4);
    if (version !== VERSION) throw new Error('TDNet 版本不匹配: ' + version);
    const tupleTypeCode = buf.readUInt32LE(8);
    const nViews = buf.readUInt32LE(12);
    const viewSize = buf.readUInt32LE(16);
    const net = new TDNet(tupleTypeCode === 1 ? '6x8' : '4x8');
    if (net.nViews !== nViews || net.viewSize !== viewSize) {
      throw new Error(`TDNet 形状不匹配: header ${nViews}x${viewSize} vs 构造 ${net.nViews}x${net.viewSize}`);
    }
    const need = HEADER_SIZE + nViews * viewSize * 4;
    if (buf.length < need) throw new Error(`TDNet 权重段不足: 需 ${need} 实际 ${buf.length}`);
    for (let i = 0; i < nViews * viewSize; i++) net.WT[i] = buf.readFloatLE(HEADER_SIZE + i * 4);
    net.K = buf.readDoubleLE(20);
    net.mean = buf.readDoubleLE(28);
    if (buf.length >= need + STATE_SIZE) {
      net.step = buf.readDoubleLE(need);
      net.gamesDone = buf.readDoubleLE(need + 8);
      net.alpha = buf.readDoubleLE(need + 16);
      net.rngState = buf.readUInt32LE(need + 24);
      net.hasTrainingState = true;
    }
    return net;
  }
}

const TMP_IDX = new Int32Array(8);

module.exports = { TDNet };
