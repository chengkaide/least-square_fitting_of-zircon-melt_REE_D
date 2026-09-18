# -*- coding: utf-8 -*-
"""
zrdemos.py -- 示例数据集的统一定义（make_data.py 与 validate.py 共用，避免两处常量漂移）

真值来源分三类：
  [EXP]  实验数据，温度独立已知        -> 用于反向检验（能否反演出正确温度）
  [NAT]  自然样品数据，模型已知失效     -> 用于检查工具能否识别模型失效
  [SYN]  合成数据，各组参数真值已知     -> 用于蒙特卡洛误差标定

常量与公式严格照抄原仓库脚本，勿改。
"""
import numpy as np

# Shannon (1976) 8 次配位离子半径，Å
RADII_SYN = np.array([0.870, 1.160, 1.143, 1.126, 1.109, 1.079, 1.066,
                      1.053, 1.040, 1.027, 1.015, 1.004, 0.994, 0.985, 0.977])
ELEMS_SYN = ['Sc', 'La', 'Ce', 'Pr', 'Nd', 'Sm', 'Eu', 'Gd',
             'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu']

NA = 6.02214086e23
RGAS = 8.314472
RSITE = 1.38


def B_term(x, r0):
    """0.5*r0*(x-r0)^2 + (1/3)*(x-r0)^3   —— 原脚本中反复出现的立方项"""
    s = x - r0
    return 0.5 * r0 * s ** 2 + s ** 3 / 3


def efit_from_GPa(E_GPa, T_K):
    """E[GPa] = Efit * R*T/Na*1e21 的反解"""
    return E_GPa * NA / (RGAS * T_K * 1e21)


def forward_free(ri, D0, r0, E_GPa, T_C):
    """模块①的正演：由真值生成 D(ri)"""
    Ef = efit_from_GPa(E_GPa, T_C + 273.15)
    return D0 * np.exp(-4 * np.pi * Ef * B_term(ri, r0))


def forward_thermo(ri, T_K, Q, r0, d0_model):
    """模块③的正演：由已知温度生成 D(ri)"""
    A, Bc = D0_RELATIONS[d0_model]
    k = (-4 * np.pi * NA * (Q * 1e-21)) / RGAS / (RSITE + r0) ** 3
    return np.exp(A / T_K + Bc) * np.exp((k / T_K) * B_term(ri, r0))


D0_RELATIONS = {
    'streicher2023': (13594.0, -7.1266),   # 原脚本 factor = exp((13594/T)-7.1266)
    'rubatto2007': (22420.0, -14.221),     # 原脚本注释掉的那一行
}

# --------------------------------------------------------------- 合成数据集
# 三组真值刻意拉开 E 与 r0，覆盖「低温高 E」「中温中等 E」「高温低 E」三种情形
SYNTH_SERIES = [
    dict(key='syn_a', label='合成 A　中温 / 中等 E',
         T_C=1000.0, D0=2.75, r0=0.9410, E_GPa=580.0, noise=0.10, seed=20230918,
         note='真值 D₀=2.75，r₀=0.9410 Å，E=580 GPa，T=1000 °C，每点 10% 高斯噪声'),
    dict(key='syn_b', label='合成 B　低温 / 高 E',
         T_C=800.0, D0=0.95, r0=0.9300, E_GPa=760.0, noise=0.10, seed=11235813,
         note='真值 D₀=0.95，r₀=0.9300 Å，E=760 GPa，T=800 °C，每点 10% 高斯噪声'),
    dict(key='syn_c', label='合成 C　高温 / 低 E',
         T_C=1300.0, D0=6.20, r0=0.9600, E_GPa=430.0, noise=0.15, seed=31415926,
         note='真值 D₀=6.20，r₀=0.9600 Å，E=430 GPa，T=1300 °C，每点 15% 高斯噪声'),
]

# 温度计合成数据：三个样品，温度独立已知
THERMO_SYNTH = dict(
    key='thermo_syn', label='合成　三个已知温度样品',
    T_K=[1173.15, 1373.15, 1573.15],       # 900 / 1100 / 1300 °C
    Q=6489, r0=0.93, d0_model='streicher2023', noise=0.08, seed=27182818,
    note='由温度计模型正演，三个样品真值温度 900 / 1100 / 1300 °C，每点 8% 高斯噪声',
)


def make_lattice_rows(spec):
    """按真值生成一个合成数据集的表格行"""
    rng = np.random.RandomState(spec['seed'])
    clean = forward_free(RADII_SYN, spec['D0'], spec['r0'], spec['E_GPa'], spec['T_C'])
    err = np.abs(clean) * spec['noise']
    noisy = clean * (1.0 + rng.normal(0.0, spec['noise'], RADII_SYN.size))
    return [dict(el=e, ri=float(r), di=float(d), s1=float(s))
            for e, r, d, s in zip(ELEMS_SYN, RADII_SYN, noisy, err)]


def make_thermo_columns():
    """按已知温度生成温度计合成数据（返回 radii, columns, 真值表）

    样品名刻意用中性的 Syn-1/2/3 —— 不要让列名把答案写在脸上，
    真值只放在 note / truth 里，配错时由工具自己算错。
    """
    rng = np.random.RandomState(THERMO_SYNTH['seed'])
    radii = RADII_SYN[1:]                            # 去掉 Sc，只留 14 个 REE
    cols, truth = {}, {}
    for i, T_K in enumerate(THERMO_SYNTH['T_K']):
        clean = forward_thermo(radii, T_K, THERMO_SYNTH['Q'], THERMO_SYNTH['r0'],
                               THERMO_SYNTH['d0_model'])
        noisy = clean * (1.0 + rng.normal(0.0, THERMO_SYNTH['noise'], radii.size))
        name = 'Syn-%d' % (i + 1)
        cols[name] = [float(v) for v in noisy]
        truth[name] = float(T_K)
    return [float(v) for v in radii], cols, truth
