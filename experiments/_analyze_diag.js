// 8192→16384 失败模式分析：读取 <tag>.diag.json 输出里程碑统计
// 用法: node experiments/_analyze_diag.js results/probd6.diag.json [probd6deep]
const fs = require('fs');

for (const f of process.argv.slice(2)) {
  const games = JSON.parse(fs.readFileSync(f, 'utf8'));
  const n = games.length;
  console.log(`\n===== ${f}（n=${n} 局）=====`);
  const r12 = games.filter(g => g.diag.stepAt12 >= 0);
  const r13 = games.filter(g => g.diag.stepAt13 >= 0);
  const r14 = games.filter(g => g.diag.stepAt14 >= 0);
  const med = a => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN;
  console.log(`4096 达成: ${r12.length} (${(r12.length / n * 100).toFixed(1)}%) | 中位步数 ${med(r12.map(g => g.diag.stepAt12))} | 达成时中位空位 ${med(r12.map(g => g.diag.empAt12))}`);
  console.log(`8192 达成: ${r13.length} (${(r13.length / n * 100).toFixed(1)}%) | 中位步数 ${med(r13.map(g => g.diag.stepAt13))} | 达成时中位空位 ${med(r13.map(g => g.diag.empAt13))}`);
  console.log(`16384 达成: ${r14.length} (${(r14.length / n * 100).toFixed(1)}%)`);

  // 8192 之后发生了什么
  if (r13.length) {
    const second = r13.filter(g => g.diag.step2nd13 >= 0);
    console.log(`\n-- 到达 8192 的 ${r13.length} 局细分 --`);
    console.log(`出现过第二个 8192: ${second.length} (${(second.length / r13.length * 100).toFixed(1)}%) | 首个→第二个中位间隔 ${med(second.map(g => g.diag.step2nd13 - g.diag.stepAt13))} 步`);
    const deadAt13 = r13.filter(g => g.diag.deathExp === 13);
    const deadAt14 = r13.filter(g => g.diag.deathExp >= 14);
    console.log(`死于最高 8192: ${deadAt13.length} (${(deadAt13.length / r13.length * 100).toFixed(1)}%) | 死于最高 ≥16384: ${deadAt14.length}`);
    const bp = r13.filter(g => g.diag.deathBigPair === 1);
    console.log(`死局存在 exp≥12 相邻同值对（对齐机会未用尽）: ${bp.length} (${(bp.length / r13.length * 100).toFixed(1)}%)`);
    console.log(`8192 局死亡时中位空位: ${med(r13.map(g => g.diag.deathEmp))}`);
    console.log(`8192 局中位最终分: ${med(r13.map(g => g.score))} | 全体中位最终分: ${med(games.map(g => g.score))}`);
    // 第二个 8192 出现后是否活更久
    if (second.length) {
      const s1 = second.map(g => g.steps - g.diag.step2nd13);
      console.log(`出现第二个 8192 后中位存活: ${med(s1)} 步`);
    }
    // 第一个 8192 后平均还能走多久
    const surv = r13.map(g => g.steps - g.diag.stepAt13);
    console.log(`首个 8192 后中位存活: ${med(surv)} 步`);
  }
  // 16384 冲击成功局明细
  if (r14.length) {
    console.log(`\n★ 16384 达成局明细:`);
    for (const g of r14) console.log(`  seed=${g.seed} score=${g.score} steps=${g.steps} maxExp=${g.maxExp} stepAt14=${g.diag.stepAt14}`);
  }
}
