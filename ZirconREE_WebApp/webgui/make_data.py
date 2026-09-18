# -*- coding: utf-8 -*-
"""
make_data.py -- 从两个原始脚本导出「示例数据 + 权威参考值」

产出:
  src/data.js        示例数据 (两个原始 xlsx + Shannon VIII 半径表 + 合成闭合测试数据)
  reference.json     用 scipy 以紧容差求得的真最优解 (供 test_math.js 逐位对照)

参考值分两组:
  ref[*]          紧容差最优解  -> JS 求解器必须收敛到同一点
  ref_default[*]  原脚本的默认设置 (maxfev=50, dogbox, scipy 默认 ftol/xtol/gtol)
                  -> 用来量化「原脚本默认设置离真最优解有多远」
"""
import json
import os

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit, least_squares

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(HERE, "src")

NA = 6.02214086 * 10 ** 23
RGAS = 8.314472
RSITE = 1.38            # Å，原脚本中的 (1.38 + r0) 常数

# --------------------------------------------------------------------------
# 模型 (与原脚本逐字对应；仅把固定常数提成参数以便多数据集复用)
# --------------------------------------------------------------------------

def B_term(x, r0):
    """0.5*r0*(x-r0)^2 + (1/3)*(x-r0)^3"""
    s = x - r0
    return 0.5 * r0 * s ** 2 + (1 / 3) * s ** 3


def model_free(x, D0, r0, Efit):
    """3_Non_Linear_Regression.py 的 model()"""
    return D0 * np.exp((-4) * np.pi * Efit * B_term(x, r0))


def model_constrained(x, D0, r0, indi_var):
    """4_Non_Linear_Regression_Constrained.py 的 model()"""
    return D0 * np.exp(indi_var * B_term(x, r0) / (RSITE + r0) ** 3)


# --------------------------------------------------------------------------
# 1) 读示例数据
# --------------------------------------------------------------------------

lat = pd.read_excel(os.path.join(ROOT, "Non_Linear_Fit_Code", "2_Lattice_Strain_Data.xlsx"))
par = pd.read_excel(os.path.join(ROOT, "T_Calc_D(Zircon-melt)", "Partition_coefficents_data.xlsx"))

x = lat["ri"].to_numpy(float)
y = lat["Di"].to_numpy(float)
s = lat["1s"].to_numpy(float)
T_C = float(lat["T [C]"].to_numpy(float)[0])
P_GPa = float(lat["P [GPa]"].to_numpy(float)[0])
T_K = T_C + 273.15
names = [str(v) for v in lat["Element"].to_numpy()]

pr = par["Radii"].to_numpy(float)
pcols = [str(c) for c in par.columns[1:]]
pdata = {c: par[c].to_numpy(float) for c in pcols}

# --------------------------------------------------------------------------
# 2) 合成一组「已知真值」数据，做正演->反演闭合测试
#    真值取 Burnham&Berry 数据集拟合结果的量级
# --------------------------------------------------------------------------

TRUE = dict(D0=2.75, r0=0.9410, E_GPa=580.0)
T_C2 = 1000.0
T_K2 = T_C2 + 273.15
rng = np.random.RandomState(20230918)
ri_syn = np.array([0.870, 1.160, 1.143, 1.126, 1.109, 1.079, 1.066,
                   1.053, 1.040, 1.027, 1.015, 1.004, 0.994, 0.985, 0.977])
Efit_true = TRUE["E_GPa"] * NA / (RGAS * T_K2 * 1e21)  # 由 E[GPa]=Efit*R*T/Na*1e21 反推
syn_clean = model_free(ri_syn, TRUE["D0"], TRUE["r0"], Efit_true)
syn_err = np.abs(syn_clean) * 0.10
syn_noisy = syn_clean * (1.0 + rng.normal(0.0, 0.10, ri_syn.size))

# --------------------------------------------------------------------------
# 3) 参考值计算
# --------------------------------------------------------------------------

ref = {}
ref_default = {}

LAT_ROWS = [dict(el=n, ri=float(a), di=float(b), s1=float(c)) for n, a, b, c in zip(names, x, y, s)]


def weighted_resid_free(p, xv, yv, sv):
    return (model_free(xv, p[0], p[1], p[2]) - yv) / sv


def weighted_resid_c1(p, xv, yv, sv):
    return (model_constrained(xv, p[0], p[1], p[2]) - yv) / sv


def tight_solution(fun, p0, guard=None):
    """用 'lm' + 极紧容差求加权最小二乘的真最优解，再做高斯-牛顿抛光"""
    r = least_squares(fun, p0, method="lm", xtol=1e-15, ftol=1e-15, gtol=1e-15,
                      max_nfev=200000)
    # Gauss-Newton 抛光 (雅可比用中心差分，与 JS 端解析式互为独立复核)
    p = r.x.copy()
    for _ in range(80):
        J = np.zeros((fun(p).size, p.size))
        for j in range(p.size):
            h = 1e-6 * max(abs(p[j]), 1e-8)
            pp = p.copy(); pp[j] += h
            pm = p.copy(); pm[j] -= h
            J[:, j] = (fun(pp) - fun(pm)) / (2 * h)
        g = J.T @ fun(p)
        if np.max(np.abs(g)) < 1e-12:
            break
        try:
            step = np.linalg.solve(J.T @ J, -g)
        except np.linalg.LinAlgError:
            break
        p = p + step
        if guard is not None and not guard(p):
            p = p - step
            break
    return p


def cov_from_jac(p, fun, m, absolute_sigma):
    n = p.size
    J = np.zeros((m, n))
    for j in range(n):
        h = 1e-6 * max(abs(p[j]), 1e-8)
        pp = p.copy(); pp[j] += h
        pm = p.copy(); pm[j] -= h
        J[:, j] = (fun(pp) - fun(pm)) / (2 * h)
    pcov = np.linalg.inv(J.T @ J)
    if not absolute_sigma:
        ssr = float(np.sum(fun(p) ** 2))
        pcov = pcov * (ssr / (m - n))
    return pcov


# ---- 模块一：自由拟合 ----
b1 = ((0, 0, 0), (2000, 2, 1000))
p0_1 = (1.0, 1.0, 1.0)
conv = RGAS * T_K / NA * 1e21
fun1 = lambda p: weighted_resid_free(p, x, y, s)
p1_t = tight_solution(fun1, p0_1, guard=lambda p: (p[0] > 0 and 0 < p[1] < 2 and p[2] > 0))
c1 = cov_from_jac(p1_t, fun1, x.size, True)
e1 = np.sqrt(np.diag(c1))
ref["mod1"] = dict(
    params=[float(v) for v in p1_t],
    err=[float(v) for v in np.abs(e1)],
    E_GPa=float(p1_t[2] * conv), dE_GPa=float(np.abs(e1[2]) * conv), conv=float(conv),
    T_K=T_K, dof=int(x.size - 3), ssr=float(np.sum(fun1(p1_t) ** 2)),
)

# 原脚本默认设置的解，用于量化差距
popt, pcov = curve_fit(model_free, x, y, sigma=s, absolute_sigma=True, maxfev=50,
                       bounds=b1, method="dogbox")
ref_default["mod1"] = dict(params=[float(v) for v in popt],
                           err=[float(v) for v in np.abs(np.sqrt(np.diag(pcov)))])

# ---- 模块二：约束拟合 ----
for Q in (6489, 7827):
    cc = Q * 1e-21
    indi = (-4 * np.pi * NA * cc) / RGAS * 1 / T_K
    fun2 = (lambda indi: (lambda p: weighted_resid_c1([p[0], p[1], indi], x, y, s)))(indi)
    p2_t = tight_solution(fun2, (1.0, 1.0), guard=lambda p: (p[0] > 0 and 0 < p[1] < 2))
    c2 = cov_from_jac(p2_t, fun2, x.size, True)
    e2 = np.sqrt(np.diag(c2))
    E_GPa = (cc / ((RSITE + p2_t[1]) * 1e-10) ** 3) / 1e9
    dE = np.sqrt((((-3 * cc / ((RSITE + p2_t[1]) * 1e-10) ** 4) * e2[1] * 1e-10
                   + (6 * cc / ((RSITE + p2_t[1]) * 1e-10) ** 5) * (e2[1] * 1e-10) ** 2) / 1e9) ** 2)
    ref["mod2_Q%d" % Q] = dict(params=[float(p2_t[0]), float(p2_t[1])],
                               err=[float(np.abs(e2[0])), float(np.abs(e2[1]))],
                               E_GPa=float(E_GPa), dE_GPa=float(dE),
                               indi=float(indi), Q=Q, T_K=T_K,
                               dof=int(x.size - 2), ssr=float(np.sum(fun2(p2_t) ** 2)))
    p2d, c2d = curve_fit(lambda xx, D0, r0: model_constrained(xx, D0, r0, indi), x, y,
                         sigma=s, absolute_sigma=True, maxfev=50,
                         bounds=((0, 0), (2000, 2)), method="dogbox")
    ref_default["mod2_Q%d" % Q] = dict(params=[float(v) for v in p2d],
                                       err=[float(v) for v in np.abs(np.sqrt(np.diag(c2d)))])

# ---- 模块三：REE 温度计 ----
THERMO_MODELS = [("streicher2023", 13594.0, -7.1266), ("rubatto2007", 22420.0, -14.221)]
ref["mod3"] = {}
for Q in (6489, 7827):
    for r0 in (0.93, 0.95):
        cc = Q * 1e-21
        k = (-4 * np.pi * NA * cc) / RGAS / (RSITE + r0) ** 3
        for mname, A, Bc in THERMO_MODELS:
            def f3(Tv, xv, A=A, Bc=Bc, k=k, r0=r0):
                Tv = np.atleast_1d(Tv)[0]
                return np.exp(A / Tv + Bc) * np.exp((k / Tv) * B_term(xv, r0))
            for col in pcols:
                yv = pdata[col]
                fun3 = (lambda f3, yv: (lambda t: f3(t, pr) - yv))(f3, yv)
                r = least_squares(fun3, [1000.0], method="lm",
                                  xtol=1e-15, ftol=1e-15, gtol=1e-15, max_nfev=200000)
                # 1 参数高斯-牛顿抛光
                Tfit = float(r.x[0])
                for _ in range(30):
                    h = 1e-6 * abs(Tfit)
                    d = (fun3([Tfit + h]) - fun3([Tfit - h])) / (2 * h)
                    g = float(d @ fun3([Tfit]))
                    if abs(g) < 1e-12:
                        break
                    Tfit += float(-g / (d @ d))
                # 标准误 (absolute_sigma=False, 与原脚本一致)
                # 用 4 阶 Richardson 外推的数值导数，保证参考值自身精度 ~1e-13
                def dnum_at(h):
                    return (f3([Tfit + h], pr) - f3([Tfit - h], pr)) / (2 * h)
                dnum = (4 * dnum_at(1e-3) - dnum_at(2e-3)) / 3
                ssr = float(np.sum((f3([Tfit], pr) - yv) ** 2))
                jtj = float(np.sum(dnum ** 2))
                dof = pr.size - 1
                var = (1.0 / jtj) * (ssr / dof)
                ref["mod3"]["%d_%.2f_%s_%s" % (Q, r0, mname, col)] = dict(
                    T_K=Tfit, dT_K=float(np.sqrt(var)),
                    ssr=ssr, dof=int(dof),
                    T_C=Tfit - 273.15,
                )

# 原脚本默认设置
for col in pcols:
    yv = pdata[col]
    k = (-4 * np.pi * NA * 6489e-21) / RGAS / (RSITE + 0.93) ** 3
    mod3 = lambda xx, Tv: np.exp(13594.0 / Tv - 7.1266) * np.exp((k / Tv) * B_term(xx, 0.93))
    p3d, c3d = curve_fit(mod3, pr, yv, maxfev=10000, bounds=((0), (2000)), method="trf")
    ref_default["mod3_%s" % col] = dict(T_K=float(p3d[0]),
                                        dT_K=float(np.abs(np.sqrt(np.diag(c3d)))[0]))

# ---- 合成闭合数据参考值 ----
ref["synth"] = dict(true=TRUE, T_C=T_C2,
                    rows=[dict(el="X%d" % i, ri=float(a), di=float(b), s1=float(c))
                          for i, (a, b, c) in enumerate(zip(ri_syn, syn_noisy, syn_err))])

# --------------------------------------------------------------------------
# 4) 写 src/data.js
# --------------------------------------------------------------------------

SHANNON = [
    # 元素, 8次配位 (VIII) 离子半径 Å -- Shannon (1976)，原示例数据即用此套
    ("Sc", 0.870), ("Y", 1.019), ("La", 1.160), ("Ce", 1.143), ("Pr", 1.126),
    ("Nd", 1.109), ("Pm", 1.093), ("Sm", 1.079), ("Eu", 1.066), ("Gd", 1.053),
    ("Tb", 1.040), ("Dy", 1.027), ("Ho", 1.015), ("Er", 1.004), ("Tm", 0.994),
    ("Yb", 0.985), ("Lu", 0.977),
]

lines = []
lines.append("/* 由 webgui/make_data.py 自动生成，请勿手工编辑 */")
lines.append("const DEMO_LATTICE = {")
lines.append("  name: 'Burnham & Berry (2012) 实验样品',")
lines.append("  source: 'Non_Linear_Fit_Code/2_Lattice_Strain_Data.xlsx',")
lines.append("  T_C: %r, P_GPa: %r," % (T_C, P_GPa))
lines.append("  rows: %s" % json.dumps(LAT_ROWS, ensure_ascii=False))
lines.append("};")
lines.append("const DEMO_PARTITION = {")
lines.append("  name: '示例分配系数数据',")
lines.append("  source: 'T_Calc_D(Zircon-melt)/Partition_coefficents_data.xlsx',")
lines.append("  radii: %s," % json.dumps([float(v) for v in pr]))
lines.append("  columns: %s," % json.dumps(
    {c: [float(v) for v in pdata[c]] for c in pcols}, ensure_ascii=False))
lines.append("};")
lines.append("const DEMO_SYNTH = {")
lines.append("  name: '闭合测试数据（10%% 噪声，真值已知）',")
lines.append("  T_C: %r," % T_C2)
lines.append("  truth: %s," % json.dumps(TRUE, ensure_ascii=False))
lines.append("  rows: %s" % json.dumps(ref["synth"]["rows"], ensure_ascii=False))
lines.append("};")
lines.append("const R_SHANNON_VIII = {")
lines.append("  source: 'Shannon (1976) 有效离子半径, 8 次配位',")
lines.append("  radii: %s" % json.dumps({k: v for k, v in SHANNON}, ensure_ascii=False))
lines.append("};")
lines.append("const ELEMENT_ORDER = %s;" % json.dumps([k for k, _ in SHANNON]))

with open(os.path.join(SRC, "data.js"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")

with open(os.path.join(HERE, "reference.json"), "w", encoding="utf-8") as f:
    json.dump({"ref": ref, "ref_default": ref_default}, f, indent=1, ensure_ascii=False)

print("data.js / reference.json 写出完成")
print("mod1 真最优解:", ref["mod1"]["params"], "E=%.3f GPa" % ref["mod1"]["E_GPa"])
print("mod1 原脚本默认:", ref_default["mod1"]["params"])
print("mod3 Sample1 (Q1,r0.93,streicher): T=%.4f K  默认: %.4f K"
      % (ref["mod3"]["6489_0.93_streicher2023_D(Sample 1)"]["T_K"],
         ref_default["mod3_D(Sample 1)"]["T_K"]))
