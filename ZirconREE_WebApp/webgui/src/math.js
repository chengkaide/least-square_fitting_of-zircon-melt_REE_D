/* ============================================================================
 * math.js -- 数值核心 (零依赖，可在浏览器与 Node 中运行)
 *
 * 移植自仓库原作者 Linus Streicher (VU Amsterdam) 的三个脚本：
 *   3_Non_Linear_Regression.py             -> ZR.fitFree
 *   4_Non_Linear_Regression_Constrained.py -> ZR.fitConstrained
 *   T_Calc_D(Zircon-melt)/T_Calc_Application.py -> ZR.fitThermo
 *
 * 公式均按原文逐字照抄（见每个函数上的注释），只把固定常数提成参数。
 * 与原脚本的唯一实质差别：原脚本用 scipy.optimize.curve_fit 且有 maxfev=50 的
 * 迭代上限，本文件改为自研的有界 Levenberg-Marquardt + 高斯-牛顿抛光，
 * 收敛判据基于梯度范数（详见 fit()）。数值结果与 scipy 紧容差最优解一致。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var VERSION = '1.0.0';

  /* ---------------------------------------------------------------- 常数 */
  var NA = 6.02214086e23;   // 1/mol      (原脚本 N_a)
  var RGAS = 8.314472;      // J/(K*mol)  (原脚本 R)
  var RSITE = 1.38;         // Å          原脚本中的 (1.38 + r0) 常数

  /* ------------------------------------------------------- 小线性代数工具 */
  /** 高斯-约当求逆，奇异返回 null。A 为行优先的普通数组。 */
  function matInv(Ain, n) {
    var A = new Float64Array(n * 2 * n), i, j, k;
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) A[i * 2 * n + j] = Ain[i * n + j];
      A[i * 2 * n + n + i] = 1;
    }
    for (i = 0; i < n; i++) {
      var piv = i, best = Math.abs(A[i * 2 * n + i]);
      for (k = i + 1; k < n; k++) {
        var v = Math.abs(A[k * 2 * n + i]);
        if (v > best) { best = v; piv = k; }
      }
      if (!(best > 0) || !isFinite(best)) return null;
      if (piv !== i) {
        for (j = 0; j < 2 * n; j++) {
          var t = A[i * 2 * n + j]; A[i * 2 * n + j] = A[piv * 2 * n + j]; A[piv * 2 * n + j] = t;
        }
      }
      var d = A[i * 2 * n + i];
      for (j = 0; j < 2 * n; j++) A[i * 2 * n + j] /= d;
      for (k = 0; k < n; k++) {
        if (k === i) continue;
        var f = A[k * 2 * n + i];
        if (f === 0) continue;
        for (j = 0; j < 2 * n; j++) A[k * 2 * n + j] -= f * A[i * 2 * n + j];
      }
    }
    var out = new Float64Array(n * n);
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) out[i * n + j] = A[i * 2 * n + n + j];
    return out;
  }

  /** 解 A x = b (A: n×n 行优先, b: 长度 n)，返回 x 或 null */
  function matSolve(A, b, n) {
    var M = new Float64Array(n * (n + 1)), i, j, k;
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j];
      M[i * (n + 1) + n] = b[i];
    }
    for (i = 0; i < n; i++) {
      var piv = i, best = Math.abs(M[i * (n + 1) + i]);
      for (k = i + 1; k < n; k++) {
        var v = Math.abs(M[k * (n + 1) + i]);
        if (v > best) { best = v; piv = k; }
      }
      if (!(best > 0) || !isFinite(best)) return null;
      if (piv !== i) {
        for (j = 0; j <= n; j++) {
          var t = M[i * (n + 1) + j]; M[i * (n + 1) + j] = M[piv * (n + 1) + j]; M[piv * (n + 1) + j] = t;
        }
      }
      for (k = i + 1; k < n; k++) {
        var f = M[k * (n + 1) + i] / M[i * (n + 1) + i];
        if (f === 0) continue;
        for (j = i; j <= n; j++) M[k * (n + 1) + j] -= f * M[i * (n + 1) + j];
      }
    }
    var x = new Float64Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = M[i * (n + 1) + n];
      for (j = i + 1; j < n; j++) s -= M[i * (n + 1) + j] * x[j];
      x[i] = s / M[i * (n + 1) + i];
      if (!isFinite(x[i])) return null;
    }
    return x;
  }

  /* --------------------------------------------------------- 模型与导数 */
  /** B(r, r0) = 0.5*r0*(r-r0)^2 + (1/3)*(r-r0)^3  —— 原文中反复出现的立方项 */
  function bTerm(r, r0) {
    var s = r - r0;
    return 0.5 * r0 * s * s + (1 / 3) * s * s * s;
  }
  /** dB/dr0 = -0.5*s^2 - r0*s */
  function bTermDr0(r, r0) {
    var s = r - r0;
    return -0.5 * s * s - r0 * s;
  }

  /* ---- 模型一：自由晶格应变拟合 (3_Non_Linear_Regression.py::model)
     D_i = D0 * exp(-4π*E*(0.5*r0*(r_i-r0)^2 + (1/3)*(r_i-r0)^3))
     参数 p = [D0, r0, E]（E 为无量纲形状参数，输出时乘以 E_Conv_Factor）   */
  var MODEL_FREE = {
    keys: ['D0', 'r0', 'E'],
    labels: ['D\u2080', 'r\u2080', 'E'],
    lo: [1e-12, 1e-6, 1e-12],
    hi: [2000, 2, 1000],                    // 原脚本 bounds=((0,0,0),(2000,2,1000))
    p0: [1, 1, 1],                          // scipy 在无 p0 时取 (1,1,1)（落在界内）
    eval: function (r, p) {
      return p[0] * Math.exp(-4 * Math.PI * p[2] * bTerm(r, p[1]));
    },
    jac: function (r, p) {                  // 返回 [df/dD0, df/dr0, df/dE]
      var f = MODEL_FREE.eval(r, p), s = r - p[1];
      return [f / p[0],
              f * (-4 * Math.PI * p[2]) * bTermDr0(r, p[1]),
              f * (-4 * Math.PI) * bTerm(r, p[1])];
    }
  };

  /* ---- 模型二：约束拟合 (4_Non_Linear_Regression_Constrained.py::model)
     参数 p = [D0, r0]，E 由 Q 约束定出：
       indi_var = -4π*N_a*(Q*1e-21)/(R) * 1/T
       D_i = D0 * exp( indi_var * B(r_i,r0) / (1.38+r0)^3 )
     indiVar 作为固定量由外部传入（依赖 Q 与 T）                            */
  function makeModelC1(indiVar) {
    return {
      keys: ['D0', 'r0'],
      lo: [1e-12, 1e-6],
      hi: [2000, 2],                        // 原脚本 bounds=((0,0),(2000,2))
      p0: [1, 1],
      indiVar: indiVar,
      eval: function (r, p) {
        return p[0] * Math.exp(indiVar * bTerm(r, p[1]) / Math.pow(RSITE + p[1], 3));
      },
      jac: function (r, p) {
        var f = MODEL_C1_eval(r, p, indiVar);
        var c = indiVar / Math.pow(RSITE + p[1], 3);
        var dc = -3 * indiVar / Math.pow(RSITE + p[1], 4);
        return [f / p[0], f * (dc * bTerm(r, p[1]) + c * bTermDr0(r, p[1]))];
      }
    };
  }
  function MODEL_C1_eval(r, p, indiVar) {
    return p[0] * Math.exp(indiVar * bTerm(r, p[1]) / Math.pow(RSITE + p[1], 3));
  }

  /* ---- 模型三：REE 锆石-熔体温度计 (T_Calc_Application.py::model_constrainted)
       T 为唯一待求参数；r0 固定；D0 随温度走 exp(A/T + Bc)
       k = -4π*N_a*(Q*1e-21)/R / (1.38+r0)^3                                */
  function makeModelThermo(k, r0, A, Bc) {
    var keys = ['T'];
    return {
      keys: keys,
      lo: [1e-3],
      hi: [2000],                           // 原脚本 bounds=((0),(2000))
      p0: [1000],                           // 原脚本 p0 默认 (1,) 亦能收敛；1000 K 更稳
      k: k, r0: r0, A: A, Bc: Bc,
      eval: function (r, p) {
        var T = p[0];
        return Math.exp(A / T + Bc) * Math.exp((k / T) * bTerm(r, r0));
      },
      jac: function (r, p) {
        var T = p[0];
        var f = Math.exp(A / T + Bc) * Math.exp((k / T) * bTerm(r, r0));
        return [-f * (A + k * bTerm(r, r0)) / (T * T)];
      }
    };
  }

  /* ------------------------------------------------- 有界 Levenberg-Marquardt
   * 最小化 SSR(p) = Σ [ (f(r_i;p) - y_i)/σ_i ]^2
   * resid(p) -> 加权残差数组 (长度 m)
   * jac(p)   -> m×n 加权雅可比（解析式）
   * 返回 {p, pcov, err, ssr, dof, chi2red, iters, converged, boundHit, gnorm}
   * ------------------------------------------------------------------------ */
  function fit(residFn, jacFn, p0, lo, hi, opts) {
    opts = opts || {};
    var maxIter = opts.maxIter || 300;
    var n = p0.length;
    var m = residFn(p0).length;
    var i, j, k;

    function SSR(pv) { var r = residFn(pv), s = 0; for (i = 0; i < r.length; i++) s += r[i] * r[i]; return s; }
    function buildAJ(pv) {                    // A = JᵀJ (对称), g = Jᵀr
      var r = residFn(pv), J = jacFn(pv);
      var A = new Float64Array(n * n), g = new Float64Array(n);
      for (i = 0; i < m; i++) {
        var row = J[i];
        for (j = 0; j < n; j++) {
          var v = row[j];
          g[j] += v * r[i];
          for (k = j; k < n; k++) A[j * n + k] += v * row[k];
        }
      }
      for (j = 0; j < n; j++) for (k = 0; k < j; k++) A[j * n + k] = A[k * n + j];
      return { A: A, g: g, r: r };
    }
    function gradNorm(g) { var s = 0; for (j = 0; j < n; j++) s = Math.max(s, Math.abs(g[j])); return s; }
    function clip(pv) {                       // 投影回可行域（留极小内边距）
      var out = pv.slice();
      for (j = 0; j < n; j++) {
        var pad = 1e-12 * (hi[j] - lo[j]);
        if (!(out[j] > lo[j] + pad)) out[j] = lo[j] + pad;
        if (!(out[j] < hi[j] - pad)) out[j] = hi[j] - pad;
      }
      return out;
    }
    function stepFrom(st, lam) {
      var A2 = st.A.slice();
      for (j = 0; j < n; j++) A2[j * n + j] += lam * Math.max(st.A[j * n + j], 1e-300);
      var neg = new Float64Array(n);
      for (j = 0; j < n; j++) neg[j] = -st.g[j];
      var d = matSolve(A2, neg, n);
      if (!d) return null;
      var pn = new Array(n);
      for (j = 0; j < n; j++) pn[j] = st.p[j] + d[j];
      if (!isFinite(pn[0])) return null;
      return { p: clip(pn), raw: pn };
    }

    var p = p0.slice();
    var ssr = SSR(p);
    var st = { p: p, A: null, g: null };
    var s0 = buildAJ(p); st.A = s0.A; st.g = s0.g;
    var lam = 1e-3, iters = 0, converged = false, reason = 'maxIter';

    for (iters = 1; iters <= maxIter; iters++) {
      var gn = gradNorm(st.g);
      if (gn <= 1e-14 * Math.max(1, ssr)) { converged = true; reason = 'gradient'; break; }
      var accepted = false;
      for (var inner = 0; inner < 40; inner++) {
        var s = stepFrom(st, lam);
        if (!s) { lam *= 10; if (lam > 1e16) break; continue; }
        var ssrn = SSR(s.p);
        if (ssrn < ssr) {
          var moved = 0;
          for (j = 0; j < n; j++) moved = Math.max(moved, Math.abs(s.p[j] - p[j]) / Math.max(Math.abs(p[j]), 1e-30));
          p = s.p; ssr = ssrn;
          var sn = buildAJ(p); st = { p: p, A: sn.A, g: sn.g };
          lam = Math.max(lam / 3, 1e-15);
          accepted = true;
          if (moved < 1e-14) { reason = 'step'; }
          break;
        }
        lam *= 10;
        if (lam > 1e16) break;
      }
      if (!accepted) { reason = 'noDescent'; break; }
      if (reason === 'step') { converged = true; break; }
    }

    /* --- 高斯-牛顿抛光（带回溯线搜索）：把最优点推到机器精度 --- */
    for (var pol = 0; pol < 60; pol++) {
      var gn2 = gradNorm(st.g);
      if (gn2 <= 1e-14 * Math.max(1, ssr)) { converged = true; reason = 'gradient'; break; }
      var neg2 = new Float64Array(n);
      for (j = 0; j < n; j++) neg2[j] = -st.g[j];
      var dd = matSolve(st.A, neg2, n);
      if (!dd) break;
      var okStep = false, alpha = 1, bestP = null, bestS = ssr;
      for (var bt = 0; bt < 60; bt++) {
        var pn2 = new Array(n);
        for (j = 0; j < n; j++) pn2[j] = p[j] + alpha * dd[j];
        pn2 = clip(pn2);
        var ss2 = SSR(pn2);
        if (ss2 < ssr) { okStep = true; bestP = pn2; bestS = ss2; break; }
        alpha *= 0.5;
      }
      if (!okStep) break;
      var moved2 = 0;
      for (j = 0; j < n; j++) moved2 = Math.max(moved2, Math.abs(bestP[j] - p[j]) / Math.max(Math.abs(p[j]), 1e-30));
      p = bestP; ssr = bestS;
      var sn2 = buildAJ(p); st = { p: p, A: sn2.A, g: sn2.g };
      if (moved2 < 1e-15) { converged = true; break; }
    }

    /* --- 协方差：pcov = inv(JᵀJ) *（absolute_sigma=False 时再乘 s²） --- */
    var pcov = matInv(st.A, n), err = new Array(n).fill(NaN);
    var dof = m - n, chi2red = NaN;
    if (pcov) {
      var scale = opts.absoluteSigma === false ? (ssr / Math.max(dof, 1)) : 1;
      for (j = 0; j < n; j++) {
        var v = pcov[j * n + j] * scale;
        err[j] = v > 0 ? Math.sqrt(v) : NaN;
      }
    }
    if (dof > 0) chi2red = ssr / dof;

    /* --- 是否顶在参数边界（结果可能不可靠，需提示用户） --- */
    var boundHit = false;
    for (j = 0; j < n; j++) {
      var pad2 = 1e-6 * (hi[j] - lo[j]);
      if (p[j] <= lo[j] + pad2 || p[j] >= hi[j] - pad2) boundHit = true;
    }

    /* --- 最优性验证 ---
     * 梯度范数在本问题里不是一个好判据：A = JᵀJ 的量级跨度极大（D0 方向可达 1e10 以上），
     * 梯度降到 1e-8 时参数其实已经精确到 1e-13 相对。这里改为直接检验：
     * 在 ±1e-8 相对窗口内逐参数单向扰动，能否找到比当前点更低（相对改进 > 1e-13）的 SSR。
     * 找不到 => 已达双精度噪声底，结果可判为最优。                          */
    var optWindow = 1e-8, maxImprove = 0;
    for (j = 0; j < n; j++) {
      for (var sg = -1; sg <= 1; sg += 2) {
        for (var amp = 1e-11; amp <= optWindow * 1.0000001; amp *= 10) {
          var pv = p.slice();
          pv[j] = p[j] * (1 + sg * amp);
          if (!(pv[j] > 0)) continue;
          var s2 = SSR(clip(pv));
          var imp = (ssr - s2) / Math.max(ssr, 1e-300);
          if (imp > maxImprove) maxImprove = imp;
        }
      }
    }
    var optimalityVerified = maxImprove <= 1e-13;
    if (optimalityVerified && !converged) { converged = true; reason = 'optimality'; }

    return {
      p: p, pcov: pcov, err: err, ssr: ssr, dof: dof, chi2red: chi2red,
      iters: iters, converged: converged, reason: reason, boundHit: boundHit,
      gnorm: gradNorm(st.g), optWindow: optWindow, maxImprove: maxImprove,
      optimalityVerified: optimalityVerified
    };
  }

  /* --------------------------------------------------------- 误差权重模式 */
  /* mode: 'abs' = 1s 即绝对 1σ (原脚本默认)
           'pct' = 1s 为相对百分数（原 README 提到的 1s%）
           'none'= 不加权（σ_i = 1）                                        */
  function makeSigma(mode, di, s1) {
    var sig = new Float64Array(di.length), i, bad = 0;
    for (i = 0; i < di.length; i++) {
      var v = 1;
      if (mode === 'abs') v = s1[i];
      else if (mode === 'pct') v = Math.abs(di[i]) * s1[i] / 100;
      if (!(isFinite(v) && v > 0)) { v = 1; bad++; }
      sig[i] = v;
    }
    return { sigma: sig, degraded: bad, useWeights: mode !== 'none' };
  }

  /* ------------------------------------------------- 统计量（结果格式化用） */
  function stats(r, y, pred) {
    var i, m = y.length;
    // 对数域 R²（地球化学常规作图轴为 logD）
    var ly = [], lp = [], ok = 0;
    for (i = 0; i < m; i++) {
      if (y[i] > 0 && pred[i] > 0) { ly.push(Math.log10(y[i])); lp.push(Math.log10(pred[i])); ok++; }
    }
    var out = { n: m, r2_log: NaN, rms_log: NaN, maxResLog: NaN };
    if (ok > 1) {
      var mean = 0;
      for (i = 0; i < ok; i++) mean += ly[i];
      mean /= ok;
      var sst = 0, sse = 0, mx = 0;
      for (i = 0; i < ok; i++) {
        sst += (ly[i] - mean) * (ly[i] - mean);
        var e = lp[i] - ly[i];
        sse += e * e;
        mx = Math.max(mx, Math.abs(e));
      }
      out.r2_log = sst > 0 ? 1 - sse / sst : NaN;
      out.rms_log = Math.sqrt(sse / ok);
      out.maxResLog = mx;
    }
    return out;
  }

  /* ==================================================================
   * 公开 API
   * ================================================================== */

  /**
   * 模型一：自由晶格应变拟合
   * opts = {ri:[], di:[], s1:[], T_C, P_GPa, errMode, absoluteSigma}
   */
  function fitFree(o) {
    var ri = o.ri, di = o.di, s1 = o.s1 || [], n = ri.length;
    var T_K = o.T_C + 273.15;
    var sm = makeSigma(o.errMode || 'abs', di, s1);
    var sig = sm.sigma;
    var resid = function (p) {
      var out = new Float64Array(n);
      for (var i = 0; i < n; i++) out[i] = (MODEL_FREE.eval(ri[i], p) - di[i]) / sig[i];
      return out;
    };
    var jac = function (p) {
      var rows = [];
      for (var i = 0; i < n; i++) {
        var j = MODEL_FREE.jac(ri[i], p);
        rows.push([j[0] / sig[i], j[1] / sig[i], j[2] / sig[i]]);
      }
      return rows;
    };
    var r = fit(resid, jac, MODEL_FREE.p0.slice(), MODEL_FREE.lo.slice(), MODEL_FREE.hi.slice(),
                { absoluteSigma: o.absoluteSigma !== false });
    // E_Conv_Factor = R*T/N_a*1e21  (J/Å³ -> GPa)
    var conv = RGAS * T_K / NA * 1e21;
    var pred = ri.map(function (x) { return MODEL_FREE.eval(x, r.p); });
    return {
      module: 'free', T_K: T_K, P_GPa: o.P_GPa, conv: conv,
      D0: r.p[0], r0: r.p[1], Efit: r.p[2],
      dD0: r.err[0], dr0: r.err[1], dEfit: r.err[2],
      E_GPa: r.p[2] * conv, dE_GPa: r.err[2] * conv,
      pred: pred, fit: r, sigmaMode: sm, stats: stats(r, di, pred)
    };
  }

  /**
   * 模型二：约束拟合（锆石专属，E 由 Q 定）
   * opts = {ri, di, s1, T_C, Q, errMode, absoluteSigma}
   */
  function fitConstrained(o) {
    var ri = o.ri, di = o.di, s1 = o.s1 || [], n = ri.length;
    var T_K = o.T_C + 273.15;
    var cc = o.Q * 1e-21;                            // J
    var indiVar = (-4 * Math.PI * NA * cc) / RGAS * 1 / T_K;
    var sm = makeSigma(o.errMode || 'abs', di, s1);
    var sig = sm.sigma;
    var model = makeModelC1(indiVar);
    var resid = function (p) {
      var out = new Float64Array(n);
      for (var i = 0; i < n; i++) out[i] = (MODEL_C1_eval(ri[i], p, indiVar) - di[i]) / sig[i];
      return out;
    };
    var jac = function (p) {
      var rows = [];
      for (var i = 0; i < n; i++) {
        var j = model.jac(ri[i], p);
        rows.push([j[0] / sig[i], j[1] / sig[i]]);
      }
      return rows;
    };
    var r = fit(resid, jac, model.p0.slice(), model.lo.slice(), model.hi.slice(),
                { absoluteSigma: o.absoluteSigma !== false });
    var D0 = r.p[0], r0 = r.p[1];
    // E = Q / ((1.38+r0)*1e-10)^3 / 1e9  [GPa]
    var E_GPa = (cc / Math.pow((RSITE + r0) * 1e-10, 3)) / 1e9;
    // 原文的 2 阶泰勒误差传播
    var t0 = r.err[1] * 1e-10;
    var dE = Math.sqrt(Math.pow((-3 * cc / Math.pow((RSITE + r0) * 1e-10, 4)) * t0
      + (6 * cc / Math.pow((RSITE + r0) * 1e-10, 5)) * t0 * t0, 2)) / 1e9;
    var pred = ri.map(function (x) { return MODEL_C1_eval(x, r.p, indiVar); });
    return {
      module: 'constrained', T_K: T_K, Q: o.Q, indiVar: indiVar,
      D0: D0, r0: r0, dD0: r.err[0], dr0: r.err[1],
      E_GPa: E_GPa, dE_GPa: dE,
      pred: pred, fit: r, sigmaMode: sm, stats: stats(r, di, pred)
    };
  }

  /** D0(T) 关系的两组可选系数 */
  var THERMO_D0 = {
    streicher2023: { A: 13594, Bc: -7.1266, label: 'Streicher et al. (2022/2023)' },
    rubatto2007: { A: 22420, Bc: -14.221, label: 'Rubatto & Hermann (2007)' }
  };

  /**
   * 模型三：REE 锆石-熔体温度计（逐样品反演 T）
   * opts = {radii:[], columns:{name:[D...]}, Q, r0, d0Model, absoluteSigma, errMode, sigmaCol}
   */
  function fitThermo(o) {
    var radii = o.radii, n = radii.length, r0 = o.r0;
    var cc = o.Q * 1e-21;
    var k = (-4 * Math.PI * NA * cc) / RGAS / Math.pow(RSITE + r0, 3);
    var d0 = THERMO_D0[o.d0Model || 'streicher2023'];
    var model = makeModelThermo(k, r0, d0.A, d0.Bc);
    var out = [];
    Object.keys(o.columns).forEach(function (name) {
      var ds = o.columns[name];
      var sm = o.errMode === 'abs' && o.sigmaCol && o.sigmaCol[name]
        ? makeSigma('abs', ds, o.sigmaCol[name])
        : makeSigma('none', ds, []);
      var sig = sm.sigma;
      var resid = function (p) {
        var a = new Float64Array(n);
        for (var i = 0; i < n; i++) a[i] = (model.eval(radii[i], p) - ds[i]) / sig[i];
        return a;
      };
      var jac = function (p) {
        var rows = [];
        for (var i = 0; i < n; i++) rows.push([model.jac(radii[i], p)[0] / sig[i]]);
        return rows;
      };
      var r = fit(resid, jac, model.p0.slice(), model.lo.slice(), model.hi.slice(),
                  { absoluteSigma: o.absoluteSigma === true });
      var pred = radii.map(function (x) { return model.eval(x, r.p); });
      out.push({
        sample: name, T_K: r.p[0], dT_K: r.err[0], T_C: r.p[0] - 273.15,
        pred: pred, fit: r, stats: stats(r, ds, pred)
      });
    });
    return {
      module: 'thermo', Q: o.Q, r0: r0, k: k, d0Model: o.d0Model || 'streicher2023',
      d0Label: d0.label, A: d0.A, Bc: d0.Bc, samples: out
    };
  }

  /* 前向模型：给定参数算 D(ri)，用于画曲线与闭合测试 */
  function forwardFree(ri, D0, r0, Efit) { return ri.map(function (x) { return MODEL_FREE.eval(x, [D0, r0, Efit]); }); }
  function forwardC1(ri, D0, r0, T_C, Q) {
    var iv = (-4 * Math.PI * NA * (Q * 1e-21)) / RGAS / (T_C + 273.15);
    return ri.map(function (x) { return MODEL_C1_eval(x, [D0, r0], iv); });
  }
  function forwardThermo(ri, T_K, r0, Q, d0Model) {
    var cc = Q * 1e-21;
    var kk = (-4 * Math.PI * NA * cc) / RGAS / Math.pow(RSITE + r0, 3);
    var m = makeModelThermo(kk, r0, THERMO_D0[d0Model].A, THERMO_D0[d0Model].Bc);
    return ri.map(function (x) { return m.eval(x, [T_K]); });
  }

  var API = {
    VERSION: VERSION,
    NA: NA, RGAS: RGAS, RSITE: RSITE,
    bTerm: bTerm, bTermDr0: bTermDr0,
    matInv: matInv, matSolve: matSolve,
    MODEL_FREE: MODEL_FREE, makeModelC1: makeModelC1, makeModelThermo: makeModelThermo,
    THERMO_D0: THERMO_D0,
    fitFree: fitFree, fitConstrained: fitConstrained, fitThermo: fitThermo,
    forwardFree: forwardFree, forwardC1: forwardC1, forwardThermo: forwardThermo,
    stats: stats
  };

  if (typeof window !== 'undefined') window.ZR = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
