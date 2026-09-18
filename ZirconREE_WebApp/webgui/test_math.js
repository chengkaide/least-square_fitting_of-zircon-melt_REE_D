/* ============================================================================
 * test_math.js -- Node 逐位对照
 *
 *   node webgui/test_math.js
 *
 * 对照对象：reference.json
 *   ref[*]          用 scipy least_squares(method='lm') + 极紧容差 + 高斯-牛顿抛光
 *                   求得的「真最优解」，是本文件的判定基准
 *   ref_default[*]  原脚本默认设置（maxfev=50 / dogbox）的解，仅用于量化差距
 *
 * 另含两项独立自检：
 *   1) 解析雅可比 vs 中心差分数值雅可比（每套模型，随机参数点）
 *   2) 正演 -> 反演闭合（合成数据能找回真值）
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
const SRC = path.join(HERE, 'src');

const sandbox = { window: {}, console: console, isFinite: isFinite, Math: Math };
vm.createContext(sandbox);
for (const f of ['data.js', 'math.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const ZR = sandbox.window.ZR;
const DEMO_LATTICE = vm.runInContext('DEMO_LATTICE', sandbox);
const DEMO_PARTITION = vm.runInContext('DEMO_PARTITION', sandbox);
const DEMO_SYNTH = vm.runInContext('DEMO_SYNTH', sandbox);
const REF = JSON.parse(fs.readFileSync(path.join(HERE, 'reference.json'), 'utf8'));

let nPass = 0, nFail = 0, worst = { rel: 0, tag: '' };
const failures = [];

function relDev(a, b) {
  const d = Math.abs(a - b), s = Math.max(Math.abs(a), Math.abs(b));
  return s === 0 ? (d === 0 ? 0 : Infinity) : d / s;
}
function chk(tag, got, want, tol) {
  const dev = relDev(got, want);
  if (dev > worst.rel && isFinite(dev)) worst = { rel: dev, tag: tag };
  if (!(dev <= tol)) {
    nFail++;
    failures.push(`${tag}: JS=${got}  scipy=${want}  rel=${dev.toExponential(3)} > ${tol}`);
    return false;
  }
  nPass++;
  return true;
}

/* ---------------------------------------------------------------- 1. 模型一 */
const L = DEMO_LATTICE;
const ri = L.rows.map(r => r.ri), di = L.rows.map(r => r.di), s1 = L.rows.map(r => r.s1);
const r1 = ZR.fitFree({ ri, di, s1, T_C: L.T_C, P_GPa: L.P_GPa, errMode: 'abs', absoluteSigma: true });
const R1 = REF.ref.mod1;
console.log('\n=== 模型一 自由晶格应变拟合 (Burnham & Berry 2012) ===');
console.log(`  JS : D0=${r1.D0}  r0=${r1.r0}  E=${r1.E_GPa} GPa`);
console.log(`  ref: D0=${R1.params[0]}  r0=${R1.params[1]}  E=${R1.E_GPa} GPa`);
console.log(`  原脚本默认: D0=${REF.ref_default.mod1.params[0]}  r0=${REF.ref_default.mod1.params[1]}  E=${(REF.ref_default.mod1.params[2] * R1.conv)} GPa`);
console.log(`  收敛: iters=${r1.fit.iters} reason=${r1.fit.reason} |g|=${r1.fit.gnorm.toExponential(2)} chi2red=${r1.fit.chi2red}`);
console.log(`  最优性验证: 在 ±${r1.fit.optWindow} 相对窗口内最大 SSR 改进 = ${r1.fit.maxImprove.toExponential(2)} (判据 <=1e-13)`);
nPass += assertTrue('mod1 最优性验证', r1.fit.optimalityVerified);

function assertTrue(tag, cond) {
  if (cond) return 1;
  nFail++; failures.push(tag + ': 未通过'); return 0;
}
const TOL = 1e-9;
chk('mod1.D0', r1.D0, R1.params[0], TOL);
chk('mod1.r0', r1.r0, R1.params[1], TOL);
chk('mod1.E_GPa', r1.E_GPa, R1.E_GPa, TOL);
chk('mod1.dD0', r1.dD0, R1.err[0], TOL);
chk('mod1.dr0', r1.dr0, R1.err[1], TOL);
chk('mod1.dE_GPa', r1.dE_GPa, R1.dE_GPa, TOL);

/* ---------------------------------------------------------------- 2. 模型二 */
console.log('\n=== 模型二 约束拟合（锆石） ===');
for (const Q of [6489, 7827]) {
  const r2 = ZR.fitConstrained({ ri, di, s1, T_C: L.T_C, Q, errMode: 'abs', absoluteSigma: true });
  const R2 = REF.ref['mod2_Q' + Q];
  console.log(`  Q=${Q}: JS D0=${r2.D0.toFixed(6)} r0=${r2.r0.toFixed(6)} E=${r2.E_GPa} ± ${r2.dE_GPa} GPa`);
  console.log(`          ref D0=${R2.params[0].toFixed(6)} r0=${R2.params[1].toFixed(6)} E=${R2.E_GPa} ± ${R2.dE_GPa} GPa`);
  chk(`mod2_Q${Q}.D0`, r2.D0, R2.params[0], TOL);
  chk(`mod2_Q${Q}.r0`, r2.r0, R2.params[1], TOL);
  chk(`mod2_Q${Q}.dD0`, r2.dD0, R2.err[0], TOL);
  chk(`mod2_Q${Q}.dr0`, r2.dr0, R2.err[1], TOL);
  chk(`mod2_Q${Q}.E_GPa`, r2.E_GPa, R2.E_GPa, TOL);
  chk(`mod2_Q${Q}.dE_GPa`, r2.dE_GPa, R2.dE_GPa, TOL);
  nPass += assertTrue(`mod2_Q${Q} 最优性验证`, r2.fit.optimalityVerified);
}

/* ---------------------------------------------------------------- 3. 模型三 */
console.log('\n=== 模型三 REE 温度计 ===');
for (const Q of [6489, 7827]) {
  for (const r0 of [0.93, 0.95]) {
    for (const d0m of ['streicher2023', 'rubatto2007']) {
      const r3 = ZR.fitThermo({
        radii: DEMO_PARTITION.radii, columns: DEMO_PARTITION.columns,
        Q, r0, d0Model: d0m, absoluteSigma: false
      });
      r3.samples.forEach(sm => {
        const key = `${Q}_${r0.toFixed(2)}_${d0m}_${sm.sample}`;
        const R3 = REF.ref.mod3[key];
        if (!R3) { nFail++; failures.push('缺少参考值 ' + key); return; }
        chk('mod3.' + key + '.T_K', sm.T_K, R3.T_K, TOL);
        chk('mod3.' + key + '.dT_K', sm.dT_K, R3.dT_K, TOL);
        nPass += assertTrue('mod3.' + key + ' 最优性验证', sm.fit.optimalityVerified);
      });
      console.log(`  Q=${Q} r0=${r0} ${d0m}: ` + r3.samples.map(s =>
        `${s.sample} T=${s.T_K.toFixed(4)}K (${s.T_C.toFixed(2)}°C) ±${s.dT_K.toFixed(4)}`).join(' | '));
    }
  }
}

/* -------------------------------------------------------- 4. 雅可比正确性 */
console.log('\n=== 解析雅可比 vs 中心差分数值雅可比 ===');
function jacCheck(tag, evalFn, jacFn, p, rset) {
  let mx = 0;
  for (const r of rset) {
    const ana = jacFn(r, p);
    for (let j = 0; j < p.length; j++) {
      const h = 1e-6 * Math.max(Math.abs(p[j]), 1e-8);
      const pp = p.slice(); pp[j] += h;
      const pm = p.slice(); pm[j] -= h;
      const num = (evalFn(r, pp) - evalFn(r, pm)) / (2 * h);
      mx = Math.max(mx, relDev(ana[j], num));
    }
  }
  if (mx < 1e-7) { nPass++; console.log(`  ${tag}: max rel dev = ${mx.toExponential(2)}  OK`); }
  else { nFail++; failures.push(`${tag}: 解析雅可比与数值不符, max rel dev = ${mx.toExponential(2)}`); console.log(`  ${tag}: max rel dev = ${mx.toExponential(2)}  FAIL`); }
}
const rr = ri;
jacCheck('free  [D0,r0,E]', (r, p) => ZR.MODEL_FREE.eval(r, p), (r, p) => ZR.MODEL_FREE.jac(r, p),
  [3.4688, 0.9562, 28.38], rr);
jacCheck('free  (另一组参数)', (r, p) => ZR.MODEL_FREE.eval(r, p), (r, p) => ZR.MODEL_FREE.jac(r, p),
  [0.85, 1.05, 73.5], rr);
{
  const iv = ZR.makeModelC1(1.0).indiVar;
  const mc = ZR.makeModelC1(3.7);
  jacCheck('c1    [D0,r0]', (r, p) => mc.eval(r, p), (r, p) => mc.jac(r, p), [3.15, 0.947], rr);
  jacCheck('c1    (另一组参数)', (r, p) => mc.eval(r, p), (r, p) => mc.jac(r, p), [40, 0.88], rr);
}
{
  const mt = ZR.makeModelThermo(-1200, 0.93, 13594, -7.1266);
  jacCheck('thermo [T]', (r, p) => mt.eval(r, p), (r, p) => mt.jac(r, p), [966.0], DEMO_PARTITION.radii);
  jacCheck('thermo [T] (另一组)', (r, p) => mt.eval(r, p), (r, p) => mt.jac(r, p), [1400.0], DEMO_PARTITION.radii);
}

/* ------------------------------------------------------- 5. 正演->反演闭合 */
console.log('\n=== 正演 -> 反演闭合（合成数据，含 10% 噪声） ===');
{
  const sy = DEMO_SYNTH;
  const sr = ZR.fitFree({
    ri: sy.rows.map(r => r.ri), di: sy.rows.map(r => r.di), s1: sy.rows.map(r => r.s1),
    T_C: sy.T_C, P_GPa: 0, errMode: 'abs', absoluteSigma: true
  });
  console.log(`  真值 D0=${sy.truth.D0} r0=${sy.truth.r0} E=${sy.truth.E_GPa} GPa`);
  console.log(`  反演 D0=${sr.D0.toFixed(4)} r0=${sr.r0.toFixed(4)} E=${sr.E_GPa.toFixed(1)} GPa`);
  const ok = Math.abs(sr.E_GPa - sy.truth.E_GPa) < 60 && Math.abs(sr.r0 - sy.truth.r0) < 0.01;
  if (ok) { nPass++; console.log('  闭合性 OK (10% 噪声下各项落在合理误差带内)'); }
  else { nFail++; failures.push('合成闭合性检查失败'); }
  // 温度计闭合：用真实参数正演再反演
  const T_true = 1500, Q = 6489, r0 = 0.93;
  const dvals = ZR.forwardThermo(DEMO_PARTITION.radii, T_true, r0, Q, 'streicher2023');
  const back = ZR.fitThermo({ radii: DEMO_PARTITION.radii, columns: { closed: dvals },
    Q, r0, d0Model: 'streicher2023', absoluteSigma: false });
  chk('thermo 闭合 T_K', back.samples[0].T_K, T_true, 1e-8);
  console.log(`  温度计闭合: 正演 ${T_true} K -> 反演 ${back.samples[0].T_K.toFixed(6)} K`);
}

/* ------------------------------------------------------------------- 汇总 */
console.log('\n---------------- 汇总 ----------------');
console.log(`通过 ${nPass} / 失败 ${nFail}`);
console.log(`最大相对偏差 ${worst.rel.toExponential(3)}  (${worst.tag})`);
if (failures.length) {
  console.log('\n失败明细:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部对照通过。');
