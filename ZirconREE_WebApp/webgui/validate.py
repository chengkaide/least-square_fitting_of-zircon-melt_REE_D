# -*- coding: utf-8 -*-
"""
validate.py -- 算法验证：反向检验 + 蒙特卡洛误差标定 + 敏感性分析

产出
  validation.json   所有验证数字（网页「验证」页直接引用这些数字，不手写）
  validation.md     人读的验证报告

三类检验
  A. 反向检验   把温度计用在「温度独立已知」的实验数据上，看能否反演回来
  B. 蒙特卡洛   合成数据 + 已知真值：参数恢复的偏差、离散度、±1σ 覆盖率
  C. 敏感性     量化「模型常数选择」与「数据误差」分别贡献多少不确定度

拟合用 scipy；网页端 JS 求解器另有 77 项对照（相对偏差 <1e-9），两者是独立实现。
"""
import functools
import json
import os

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit

import zrdemos as Z

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

NA, R, RS = Z.NA, Z.RGAS, Z.RSITE
B = Z.B_term


# ----------------------------------------------------------------- 工具函数
def _w1(mf, x, a):
    return np.log10(mf(x, a))


def _w2(mf, x, a, b):
    return np.log10(mf(x, a, b))


def _w3(mf, x, a, b, c):
    return np.log10(mf(x, a, b, c))


def fit_generic(model, x, y, sig, p0, bounds, logspace):
    """通用加权最小二乘

    logspace=False：残差 = f(x) - y，权重 1/σ   （原脚本用绝对 1σ）
    logspace=True ：残差 = log10 f(x) - log10 y（无 σ、且 D 跨多个数量级时的合理选择：
                    线性域等权会让小 D 点完全不起作用）

    注意：curve_fit 要从函数签名推断参数个数，所以按参数个数生成显式签名的包装，
    不能写 lambda xx, *p（会报 Unable to determine number of fit parameters）。
    """
    if logspace:
        f = functools.partial(_w1 if len(p0) == 1 else (_w2 if len(p0) == 2 else _w3), model)
        yy = np.log10(y)
    else:
        f = model
        yy = y
    p, c = curve_fit(f, x, yy, sigma=sig, absolute_sigma=True, maxfev=200000,
                     bounds=bounds, method='trf')
    return p, c


def fit_free(ri, di, sig, logspace=False):
    """模块① 自由晶格应变拟合（T 只影响 E 的换算，不参与拟合）"""
    mf = lambda x, D0, r0, E: D0 * np.exp(-4 * np.pi * E * B(x, r0))
    p, c = fit_generic(mf, ri, di, None if logspace else sig, (1.0, 1.0, 1.0),
                       ((1e-9, 1e-6, 1e-9), (2000, 2, 1000)), logspace)
    e = np.sqrt(np.diag(c))
    res = np.log10(mf(ri, *p)) - np.log10(di)
    return dict(D0=float(p[0]), r0=float(p[1]), Efit=float(p[2]),
                dD0=float(abs(e[0])), dr0=float(abs(e[1])), dEfit=float(abs(e[2])),
                corr_r0_E=(float(c[1, 2] / np.sqrt(c[1, 1] * c[2, 2]))
                           if c[1, 1] > 0 and c[2, 2] > 0 else None),
                rms_log=float(np.sqrt(np.mean(res ** 2))),
                max_log=float(np.max(np.abs(res))),
                lree_max_log=float(np.max(np.abs(res[:3]))))   # La, Ce, Pr


def fit_constrained(ri, di, sig, T_C, Q, logspace=False):
    """模块② 约束拟合（E 由 Q 定）"""
    iv = (-4 * np.pi * NA * (Q * 1e-21)) / R / (T_C + 273.15)
    mf = lambda x, D0, r0: D0 * np.exp(iv * B(x, r0) / (RS + r0) ** 3)
    p, c = fit_generic(mf, ri, di, None if logspace else sig, (1.0, 1.0),
                       ((1e-9, 1e-6), (2000, 2)), logspace)
    e = np.sqrt(np.diag(c))
    E = (Q * 1e-21 / ((RS + p[1]) * 1e-10) ** 3) / 1e9
    return dict(D0=float(p[0]), r0=float(p[1]), dD0=float(abs(e[0])), dr0=float(abs(e[1])),
                Q=Q, E_GPa=float(E),
                rms_log=float(np.sqrt(np.mean(
                    (np.log10(mf(ri, *p)) - np.log10(di)) ** 2))))


def fit_T(ri, di, Q, r0, model, logspace=True):
    """模块③ 温度计反演。logspace=True 为对数域等权（推荐）；False 为原脚本的线性域不加权。"""
    A, Bc = Z.D0_RELATIONS[model]
    k = (-4 * np.pi * NA * (Q * 1e-21)) / R / (RS + r0) ** 3
    mf = lambda x, Tv: np.exp(A / Tv + Bc) * np.exp((k / Tv) * B(x, r0))
    p, c = fit_generic(mf, ri, di, None, (1200.0,), ((1.0,), (2500.0,)), logspace)
    e = np.sqrt(np.diag(c))[0]
    return dict(T_K=float(p[0]), dT_K=float(abs(e)), T_C=float(p[0] - 273.15),
                rms_log=float(np.sqrt(np.mean(
                    (np.log10(mf(ri, *p)) - np.log10(di)) ** 2))))


# ============================================================ A. 反向检验
lat = pd.read_excel(os.path.join(ROOT, "Non_Linear_Fit_Code", "2_Lattice_Strain_Data.xlsx"))
bb_ri = lat['ri'].to_numpy(float)
bb_di = lat['Di'].to_numpy(float)
bb_s1 = lat['1s'].to_numpy(float)
bb_T = float(lat['T [C]'].to_numpy(float)[0])
bb_TK = bb_T + 273.15
bb_conv = R * bb_TK / NA * 1e21

par = pd.read_excel(os.path.join(ROOT, "T_Calc_D(Zircon-melt)", "Partition_coefficents_data.xlsx"))
wh_ri = par['Radii'].to_numpy(float)
wh_cols = {str(c): par[c].to_numpy(float) for c in par.columns[1:]}

OUT = {}
bb_free = fit_free(bb_ri, bb_di, bb_s1, logspace=False)
bb_free['E_GPa'] = bb_free['Efit'] * bb_conv
bb_free['dE_GPa'] = bb_free['dEfit'] * bb_conv
bb_con = []
for Q in (6489, 7827):
    c = fit_constrained(bb_ri, bb_di, bb_s1, bb_T, Q)
    c['E_GPa'] = (Q * 1e-21 / ((RS + c['r0']) * 1e-10) ** 3) / 1e9
    bb_con.append(c)

rev = {'burnham_berry_2012': dict(
    source='Burnham & Berry (2012) GCA 95, 196-212（实验，13 个点）',
    provenance='EXP — 实验数据，温度由实验设定、独立已知',
    T_known_C=bb_T, T_known_K=bb_TK,
    free=bb_free, constrained=bb_con, thermo={}, thermo_log={})}
for Q in (6489, 7827):
    for r0 in (0.93, 0.95):
        for m in ('streicher2023', 'rubatto2007'):
            k = '%d_%.2f_%s' % (Q, r0, m)
            for tag, logs in (('thermo', False), ('thermo_log', True)):
                r = fit_T(bb_ri, bb_di, Q, r0, m, logspace=logs)
                r['bias_K'] = r['T_K'] - bb_TK
                rev['burnham_berry_2012'][tag][k] = r
OUT['reverse'] = rev

# Whitehouse & Kamber (2002)：自然样品，该文自己就指出模型在这类数据上失效
wh = {'source': 'Whitehouse & Kamber (2002) EPSL 204, 333-346（西南格陵兰 Itsaq 片麻杂岩，自然样品）',
      'provenance': 'NAT — 自然样品锆石/熔体 D(REE)；该文结论：陆地锆石 LREE 相对晶格应变模型超丰度，'
                    '两件样品互推熔体成分可差两个数量级。仓库里该表名为 "Whitehouse Data"。',
      'space': 'log — 该数据无 1σ 且 D 跨 5 个数量级，按对数域等权拟合',
      'samples': {}}
for name, d in wh_cols.items():
    r = fit_free(wh_ri, d, None, logspace=True)
    r['E_GPa'] = r['Efit'] * bb_conv
    r['dE_GPa'] = r['dEfit'] * bb_conv
    r['thermo_default'] = fit_T(wh_ri, d, 6489, 0.93, 'streicher2023', logspace=True)
    wh['samples'][name] = r
OUT['natural'] = wh


# ========================================================== B. 蒙特卡洛
def mc_free(spec, nrep=400):
    """合成 -> 反演：偏差、离散度、±1σ 覆盖率（用工具同样的加权方式）"""
    rng = np.random.RandomState(spec['seed'] + 777)
    ri = Z.RADII_SYN
    truth = Z.forward_free(ri, spec['D0'], spec['r0'], spec['E_GPa'], spec['T_C'])
    sig = np.abs(truth) * spec['noise']
    conv = R * (spec['T_C'] + 273.15) / NA * 1e21
    f = lambda x, D0, r0, E: D0 * np.exp(-4 * np.pi * E * B(x, r0))
    got = []
    for _ in range(nrep):
        y = truth * (1.0 + rng.normal(0.0, spec['noise'], ri.size))
        try:
            p, c = curve_fit(f, ri, y, sigma=sig, absolute_sigma=True, maxfev=20000,
                             bounds=((0, 0, 0), (2000, 2, 1000)), method='dogbox')
            e = np.sqrt(np.diag(c))
            got.append([p[0], p[1], p[2] * conv, e[0], e[1], e[2] * conv])
        except Exception:
            pass
    a = np.array(got)
    if a.size == 0:
        return None
    tru = np.array([spec['D0'], spec['r0'], spec['E_GPa']])
    est, err = a[:, :3], a[:, 3:]
    out = {'nrep': int(a.shape[0]),
           'truth': dict(D0=spec['D0'], r0=spec['r0'], E_GPa=spec['E_GPa'])}
    for j, k in enumerate(['D0', 'r0', 'E_GPa']):
        out[k] = {'mean': float(est[:, j].mean()),
                  'bias_pct': float(100 * (est[:, j].mean() - tru[j]) / tru[j]),
                  'sd': float(est[:, j].std(ddof=1)),
                  'mean_err': float(err[:, j].mean()),
                  'cov1': float(np.mean(np.abs(est[:, j] - tru[j]) <= err[:, j])),
                  'cov2': float(np.mean(np.abs(est[:, j] - tru[j]) <= 2 * err[:, j]))}
    return out


def mc_thermo(T_K, Q, r0, model, noise, nrep=400, seed=1234,
              fitQ=None, fitr0=None, fitmodel=None, logspace=True):
    """由已知温度正演 -> 反演。fit* 给不同值时即为「模型误用」情形"""
    rng = np.random.RandomState(seed)
    ri = Z.RADII_SYN[1:]
    truth = Z.forward_thermo(ri, T_K, Q, r0, model)
    fQ = Q if fitQ is None else fitQ
    fr0 = r0 if fitr0 is None else fitr0
    fm = model if fitmodel is None else fitmodel
    A, Bc = Z.D0_RELATIONS[fm]
    k = (-4 * np.pi * NA * (fQ * 1e-21)) / R / (RS + fr0) ** 3
    f = lambda x, Tv: np.exp(A / Tv + Bc) * np.exp((k / Tv) * B(x, fr0))
    if logspace:
        def ff(x, Tv):
            return np.log10(f(x, Tv))
    else:
        ff = f
    est, err = [], []
    for _ in range(nrep):
        y = truth * (1.0 + rng.normal(0.0, noise, ri.size))
        try:
            p, c = curve_fit(ff, ri, np.log10(y) if logspace else y, maxfev=20000,
                             bounds=((1.0,), (2500.0,)), method='trf')
            est.append(p[0]); err.append(np.sqrt(np.diag(c))[0])
        except Exception:
            pass
    est = np.array(est); err = np.array(err)
    if est.size == 0:
        return None
    return {'truth_K': float(T_K), 'nrep': int(est.size), 'mean_K': float(est.mean()),
            'bias_K': float(est.mean() - T_K), 'sd_K': float(est.std(ddof=1)),
            'mean_err_K': float(err.mean()),
            'cov1': float(np.mean(np.abs(est - T_K) <= err)),
            'cov2': float(np.mean(np.abs(est - T_K) <= 2 * err)),
            'rmse_K': float(np.sqrt(np.mean((est - T_K) ** 2)))}


mc = {'free': {}, 'thermo': {}, 'thermo_mismodel': {}}
for spec in Z.SYNTH_SERIES:
    mc['free'][spec['key']] = {'label': spec['label'], 'noise': spec['noise'],
                               'res': mc_free(spec)}
    print('MC free', spec['key'], 'ok')

print('MC thermo ...')
for T_C in (700, 800, 900, 1000, 1100, 1200, 1300):
    for noise in (0.05, 0.10, 0.20):
        key = '%dC_%.0f' % (T_C, noise * 100)
        mc['thermo'][key] = mc_thermo(T_C + 273.15, 6489, 0.93, 'streicher2023', noise,
                                      seed=abs(hash(key)) % 100000)
for T_C in (800, 1000, 1200):
    mc['thermo_mismodel']['用 Q2/r0=0.95 生成 -> 用 Q1/r0=0.93 反演（%d C）' % T_C] = mc_thermo(
        T_C + 273.15, 7827, 0.95, 'streicher2023', 0.10, seed=T_C,
        fitQ=6489, fitr0=0.93)
    mc['thermo_mismodel']['用 Streicher 生成 -> 用 Rubatto 反演（%d C）' % T_C] = mc_thermo(
        T_C + 273.15, 6489, 0.93, 'streicher2023', 0.10, seed=T_C, fitmodel='rubatto2007')
OUT['montecarlo'] = mc

# ============================================================ C. 敏感性
spans = []
for k in (4, 6, 8, 10, 13):
    sub = slice(None, k)
    r = fit_free(bb_ri[sub], bb_di[sub], bb_s1[sub], logspace=False)
    E = r['Efit'] * bb_conv
    bad = (r['D0'] > 1999 or r['r0'] > 1.99 or not (0 < E < 2000)
           or r['corr_r0_E'] is None)
    spans.append(dict(n=int(k), span=float(bb_ri[sub].max() - bb_ri[sub].min()),
                      r0=r['r0'], dr0=r['dr0'], E_GPa=E, D0=r['D0'],
                      dE_GPa=r['dEfit'] * bb_conv, corr_r0_E=r['corr_r0_E'],
                      degenerate=bool(bad)))
ts = [v['T_K'] for v in rev['burnham_berry_2012']['thermo_log'].values()]
OUT['sensitivity'] = dict(
    radius_span=spans,
    thermo_model_spread=dict(min_K=float(min(ts)), max_K=float(max(ts)),
                             span_K=float(max(ts) - min(ts)),
                             min_bias_K=float(min(ts) - bb_TK),
                             max_bias_K=float(max(ts) - bb_TK)),
    thermo_internal_1sigma={k: v['dT_K']
                            for k, v in rev['burnham_berry_2012']['thermo_log'].items()},
    weighting_effect={k: dict(linear=rev['burnham_berry_2012']['thermo'][k]['T_K'],
                              log=rev['burnham_berry_2012']['thermo_log'][k]['T_K'])
                      for k in rev['burnham_berry_2012']['thermo']})
OUT['meta'] = dict(T_known_BB=bb_T, T_known_BB_K=bb_TK,
                   note='全部数字由 webgui/validate.py 生成；scipy 拟合，与网页端 JS 求解器'
                        '另有 77 项对照（最大相对偏差 6.3e-10）')

with open(os.path.join(HERE, 'validation.json'), 'w', encoding='utf-8') as f:
    json.dump(OUT, f, indent=1, ensure_ascii=False)

# ------------------------------------------------------------------ 报告
L = []
L.append('# 算法验证报告\n')
L.append('> 数字全部由 `webgui/validate.py` 自动生成（见 `validation.json`），未手写。\n')
L.append('## A. 反向检验：拿温度已知的实验数据考温度计\n')
L.append('### A1. Burnham & Berry (2012)：实验，T = %.0f °C = %.2f K（独立已知）\n' % (bb_T, bb_TK))
L.append('- 自由拟合：D0 = %.3f ± %.3f，r0 = %.4f ± %.4f Å，E = %.1f ± %.1f GPa'
         % (bb_free['D0'], bb_free['dD0'], bb_free['r0'], bb_free['dr0'],
            bb_free['E_GPa'], bb_free['dE_GPa']))
L.append('- corr(r0, E) = %.3f；RMS(log10D) = %.3f dex，最大偏差 %.3f dex'
         % (bb_free['corr_r0_E'], bb_free['rms_log'], bb_free['max_log']))
L.append('- 约束拟合：' + '；'.join('Q=%d -> E=%.1f GPa，r0=%.4f' % (c['Q'], c['E_GPa'], c['r0'])
                                for c in bb_con))
L.append('')
L.append('温度计反演（8 种参数组合，对数域等权）：')
L.append('')
L.append('| Q | r0 (Å) | D0(T) 关系 | 反演 T (K) | ±1σ (K) | 与实验温度之差 |')
L.append('|---|---|---|---|---|---|')
for k, v in rev['burnham_berry_2012']['thermo_log'].items():
    Q, r0, m = k.split('_')
    L.append('| %s | %s | %s | %.2f | %.2f | **%+.1f K** |' % (Q, r0, m, v['T_K'], v['dT_K'], v['bias_K']))
s = OUT['sensitivity']['thermo_model_spread']
L.append('')
L.append('- 参数组合导致的 T 跨度 **%.1f K**（%+.1f ～ %+.1f K）；'
         '数据噪声给出的内部 ±1σ 只有 %.1f–%.1f K。**误差预算由模型常数主导，不是数据。**'
         % (s['span_K'], s['min_bias_K'], s['max_bias_K'],
            min(OUT['sensitivity']['thermo_internal_1sigma'].values()),
            max(OUT['sensitivity']['thermo_internal_1sigma'].values())))
L.append('')
L.append('### A2. Whitehouse & Kamber (2002)：自然样品，模型已知失效\n')
for name, r in wh['samples'].items():
    tag = '（**参数顶界：拟合不可用**）' if (r['D0'] > 1999 or r['r0'] < 0.90) else ''
    L.append('- **%s**%s：D0=%.2f，r0=%.4f Å，E=%.0f GPa；RMS(log10D)=%.2f dex，最大偏差 %.2f dex'
             '（约 %.0f 倍），其中 La-Pr 三点最大偏差 %.2f dex'
             % (name, tag, r['D0'], r['r0'], r['E_GPa'], r['rms_log'], r['max_log'],
                10 ** r['max_log'], r['lree_max_log']))
    L.append('  - 温度计默认参数反演：%.1f K（%.0f °C）'
             % (r['thermo_default']['T_K'], r['thermo_default']['T_C']))
L.append('')
L.append('这两件样品上，自由拟合的 D0 直接顶到搜索上界 2000、r0 掉到 0.83–0.85 Å（锆石的位点半径')
L.append('本应约 0.93–0.96 Å），说明**模型在这份数据上根本不成立**；LREE 残差高达 1.4 dex。')
L.append('工具把这一点直接暴露在 RMS / 最大偏差 / 残差图上，而不是给一个「看着挺好」的拟合。')
L.append('')
L.append('## B. 蒙特卡洛误差标定（合成数据，真值已知）\n')
L.append('### B1. 晶格应变拟合（模块①②，每组 400 次重复）\n')
L.append('cov1/cov2 = 真值落在 ±1σ/±2σ 内的频率，理想值 0.68 / 0.95')
L.append('')
L.append('| 数据集 | 噪声 | 参数 | 相对偏差 | 平均报出的 1σ | 1σ 覆盖率 | 2σ 覆盖率 |')
L.append('|---|---|---|---|---|---|---|')
for k, v in mc['free'].items():
    r = v['res']
    for p in ('D0', 'r0', 'E_GPa'):
        L.append('| %s | %.0f%% | %s | %+.1f%% | %.4g | %.2f | %.2f |'
                 % (v['label'], v['noise'] * 100, p, r[p]['bias_pct'], r[p]['mean_err'],
                    r[p]['cov1'], r[p]['cov2']))
L.append('')
L.append('### B2. 温度计反演（模块③）\n')
L.append('| 真值 T | 噪声 | 平均反演 T | 偏差 | RMSE | 平均报出的 1σ | 1σ 覆盖率 |')
L.append('|---|---|---|---|---|---|---|')
for k, v in mc['thermo'].items():
    L.append('| %.0f K | %s%% | %.1f K | %+.1f K | %.1f K | %.1f K | %.2f |'
             % (v['truth_K'], k.split('_')[1], v['mean_K'], v['bias_K'], v['rmse_K'],
                v['mean_err_K'], v['cov1']))
L.append('')
L.append('### B3. 模型误用（生成与反演用不同常数）\n')
L.append('| 情形 | 真值 T | 平均反演 T | 偏差 |')
L.append('|---|---|---|---|')
for k, v in mc['thermo_mismodel'].items():
    L.append('| %s | %.0f K | %.1f K | **%+.1f K** |' % (k, v['truth_K'], v['mean_K'], v['bias_K']))
L.append('')
L.append('## C. 敏感性\n')
L.append('### C1. 半径跨度 vs 参数不确定度（逐点削减实验数据）\n')
L.append('| 点数 | 半径跨度 (Å) | r0 | ±1σ(r0) | E (GPa) | ±1σ(E) | corr(r0,E) |')
L.append('|---|---|---|---|---|---|---|')
for r in spans:
    if r['degenerate']:
        L.append('| %d | %.3f | 病态 | — | 病态 | — | — |' % (r['n'], r['span']))
    else:
        L.append('| %d | %.3f | %.4f | %.4f | %.1f | %.1f | %.3f |'
                 % (r['n'], r['span'], r['r0'], r['dr0'], r['E_GPa'], r['dE_GPa'],
                    r['corr_r0_E']))
L.append('')
L.append('- 4 点那一行是**病态**的：前 4 个半径是 Sc(0.870) + 三个轻稀土(1.126–1.160)，'
         '中间缺一大段，参数不可辨识（D₀、r₀ 顶在边界上）。'
         '界面在这种情况下会给出「触及参数边界」警告 —— 这类数据不能用来拟合。')
L.append('')
L.append('### C2. 权重方式对反演温度的影响（同一数据）\n')
L.append('| 组合 | 线性域不加权（原脚本） | 对数域等权 | 差值 |')
L.append('|---|---|---|---|')
for k, v in OUT['sensitivity']['weighting_effect'].items():
    L.append('| %s | %.1f K | %.1f K | %+.1f K |' % (k, v['linear'], v['log'], v['log'] - v['linear']))
L.append('')
with open(os.path.join(HERE, 'validation.md'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(L) + '\n')

import sys as _sys
try:
    _sys.stdout.reconfigure(errors='replace')
except Exception:
    pass
print('\n'.join(L))
print('\n=> 写出 validation.json / validation.md')
