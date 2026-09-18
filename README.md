# least-square_fitting_of-zircon-melt_REE_D
The application of this code is described in the publication.
Streicher, L.B., van Westrenen, W., Hanchar, J.M., Brouwer, F.M., 2023. A REE-based zircon geothermometer based on improved lattice strain modeling of zircon-melt REE partition coefficients. Geochimica et Cosmochimica Acta 346, 54-64. doi.org/https://doi.org/10.1016/j.gca.2023.01.030. 

## 网页版（本仓库新增，非原作者的代码）

把上面两个文件夹里的三个脚本整合成**一个单文件、完全离线的网页应用**：

**`ZirconREE_WebApp/锆石熔体REE工具.html`** —— 双击即用（不需要 Python、不需要联网）。

```
准备数据 → 选算法 → 点「计算」 → 看结果 → 导出
```

| 模块 | 原脚本 | 输入 | 得到 |
|---|---|---|---|
| ① 自由晶格应变拟合 | `Non_Linear_Fit_Code/3_Non_Linear_Regression.py` | 元素 · ri · Di · 1s，T、P | D₀ ± 1σ、r₀ ± 1σ (Å)、E ± 1σ (GPa) |
| ② 约束拟合（锆石） | `Non_Linear_Fit_Code/4_Non_Linear_Regression_Constrained.py` | 元素 · ri · Di · 1s，T、Q | D₀ ± 1σ、r₀ ± 1σ (Å)、E (GPa) |
| ③ REE 温度计 | `T_Calc_D(Zircon-melt)/T_Calc_Application.py` | ri 一列 + 每个样品一列 D | 每个样品的 T ± 1σ（K / °C） |

支持从 Excel 粘贴或拖入 `.xlsx`，输出可复制文本 / CSV / JSON / PNG / 打印成 PDF。
模型公式与原脚本逐字一致，只把求解器换成离线可用的有界 Levenberg–Marquardt（对照测试见
`ZirconREE_WebApp/webgui/test_math.js`，77 项全部通过，最大相对偏差 6.3×10⁻¹⁰）。

详见 [ZirconREE_WebApp/README.md](ZirconREE_WebApp/README.md)。
