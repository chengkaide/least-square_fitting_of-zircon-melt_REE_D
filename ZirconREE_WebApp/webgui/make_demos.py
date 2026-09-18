# -*- coding: utf-8 -*-
"""
make_demos.py -- 生成 src/demos.js

内容
  DEMO_SERIES        三组合成数据（各组 D0/r0/E 真值已知，用于反向验证恢复能力）
  DEMO_THERMO_SYN    温度计合成数据（三个样品，真值温度已知）
  VALIDATION         验证数字（直接读 validation.json，不在网页里手写）
  LIT_REF            文献出处与获取性说明（哪些能验、哪些拿不到）

顺序：先 python webgui/validate.py（产出 validation.json），再 python webgui/make_demos.py
"""
import json
import os

import zrdemos as Z

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')

# ---------------------------------------------------------------- 合成数据
series = []
for spec in Z.SYNTH_SERIES:
    series.append(dict(key=spec['key'], label=spec['label'], T_C=spec['T_C'],
                       truth=dict(D0=spec['D0'], r0=spec['r0'], E_GPa=spec['E_GPa']),
                       noise=spec['noise'], note=spec['note'],
                       rows=Z.make_lattice_rows(spec)))

t_radii, t_cols, t_truth = Z.make_thermo_columns()
thermo_syn = dict(label=Z.THERMO_SYNTH['label'], note=Z.THERMO_SYNTH['note'],
                  Q=Z.THERMO_SYNTH['Q'], r0=Z.THERMO_SYNTH['r0'],
                  d0Model=Z.THERMO_SYNTH['d0_model'], noise=Z.THERMO_SYNTH['noise'],
                  radii=t_radii, columns=t_cols, truth=t_truth)

# ---------------------------------------------------------------- 验证数字
vpath = os.path.join(HERE, 'validation.json')
VALIDATION = None
if os.path.exists(vpath):
    with open(vpath, encoding='utf-8') as f:
        VALIDATION = json.load(f)
    print('已读入 validation.json（%d 字节）' % os.path.getsize(vpath))
else:
    print('!! 未找到 validation.json —— 请先运行 python webgui/validate.py')
    VALIDATION = {}

# ------------------------------------------------------- 文献数据可获取性
LIT_REF = {
    'note': '下列实验数据集都带独立已知温度，是检验温度计的理想材料；但四篇均为付费期刊、'
            'Unpaywall/OpenAlex 都查不到合法开放副本（2026-09-18 实测），因此本工具只用'
            '仓库自带的 Burnham & Berry (2012) 做反向检验，其余留作手工导入。',
    'items': [
        dict(key='burnham2012', cite='Burnham & Berry (2012) GCA 95, 196-212',
             doi='10.1016/j.gca.2012.07.034', T_C=1295, P_GPa=0.0001,
             status='已在仓库内', note='本仓库 Non_Linear_Fit_Code/2_Lattice_Strain_Data.xlsx，'
                                      '13 个元素，实验温度 1295 °C'),
        dict(key='rubatto2007', cite='Rubatto & Hermann (2007) Chem Geol 241, 38-61',
             doi='10.1016/j.chemgeo.2007.01.027', T_C='800–1000', P_GPa=2.0,
             status='付费，无开放副本', note='20 kbar 含水花岗质熔体，4 个温度点，'
                                            '最理想的独立检验集 —— 拿到 PDF 后可直接粘贴进模块③'),
        dict(key='luo2009', cite='Luo & Ayers (2009) GCA 73, 3656-3679',
             doi='10.1016/j.gca.2009.03.027', T_C='800–1300', P_GPa='1.0–2.0',
             status='付费，无开放副本', note='实验锆石/熔体 D(REE)'),
        dict(key='thomas2002', cite='Thomas et al. (2002) GCA 66, 2885-2898',
             doi='10.1016/s0016-7037(02)00881-5', T_C='—', P_GPa='—',
             status='付费，无开放副本', note='熔体包裹体法测锆石/熔体 D'),
        dict(key='whitehouse2002', cite='Whitehouse & Kamber (2002) EPSL 204, 333-346',
             doi='10.1016/s0012-821x(02)01000-2', T_C='自然样品',
             status='已在仓库内（表名 "Whitehouse Data"）',
             note='两件太古宙片麻岩；该文结论是 LREE 相对晶格应变模型超丰度，'
                  '属于「模型已知失效」的反面案例'),
    ],
    'stds': ('关于锆石标样（91500 / Plešovice / GJ-1 / Temora / Mud Tank）：它们是 U-Pb 与微量元素'
             '的「锆石端元」参考物质，只给出锆石自身的浓度。本工具三个模块的输入都是'
             '分配系数 D = C_锆石 / C_熔体，缺熔体端就构不成 D，因此标样数据不能直接用于'
             '温度反演。要使用标样，需要配对的锆石 + 熔体（或全岩）分析 —— 主页「浓度换算 D」'
             '小工具就是为这一步准备的。'),
}

lines = []
lines.append('/* 由 webgui/make_demos.py 自动生成，请勿手工编辑 */')
lines.append('const DEMO_SERIES = %s;' % json.dumps(series, ensure_ascii=False))
lines.append('const DEMO_THERMO_SYN = %s;' % json.dumps(thermo_syn, ensure_ascii=False))
lines.append('const VALIDATION = %s;' % json.dumps(VALIDATION, ensure_ascii=False))
lines.append('const LIT_REF = %s;' % json.dumps(LIT_REF, ensure_ascii=False))
lines.append('const WH_SOURCE = %s;' % json.dumps(
    {'label': 'Whitehouse & Kamber (2002) 自然样品（LREE 超丰度，模型失效案例）',
     'cite': 'Whitehouse & Kamber (2002) EPSL 204, 333-346',
     'note': '西南格陵兰 Itsaq 片麻杂岩两件太古宙样品（3.81 Ga 英云闪长岩、3.64 Ga 花岗闪长片麻岩）；'
             '该文结论：陆地锆石 LREE 相对晶格应变模型超丰度、两件样品互推熔体可差两个数量级。'
             '仓库里这张表名就叫 "Whitehouse Data"。'},
    ensure_ascii=False))

with open(os.path.join(SRC, 'demos.js'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')

print('写出 src/demos.js：合成数据集 %d 组，温度计合成 %d 个样品，验证块 %s'
      % (len(series), len(t_cols), '有' if VALIDATION else '无'))
