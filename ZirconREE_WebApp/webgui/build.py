# -*- coding: utf-8 -*-
"""
build.py -- 把 template.html + src/* 合成零依赖单文件 HTML

用法：python webgui/build.py
产出：ZirconREE_WebApp/锆石熔体REE工具.html  （可直接双击打开、可邮件发送）
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(os.path.join(HERE, ".."))
TOKEN = "/*@{}@*/"
PARTS = [("STYLE", "src/style.css"), ("DATA", "src/data.js"), ("MATH", "src/math.js"), ("APP", "src/app.js")]
OUT_NAME = "锆石熔体REE工具.html"



def main():
    tpl_path = os.path.join(HERE, "template.html")
    with open(tpl_path, encoding="utf-8") as f:
        html = f.read()

    found = re.findall(r"/\*@(\w+)@\*/", html)
    expected = [k for k, _ in PARTS]
    missing = [k for k in expected if k not in found]
    if missing:
        sys.exit("template.html 缺少占位符: %s" % ", ".join(missing))
    unknown = [k for k in found if k not in expected]
    if unknown:
        sys.exit("template.html 有未知占位符: %s" % ", ".join(unknown))

    for key, rel in PARTS:
        p = os.path.join(HERE, rel)
        with open(p, encoding="utf-8") as f:
            body = f.read()
        if "</script" in body or "</style" in body:
            sys.exit("%s 含有会提前闭合标签的内容，请检查" % rel)
        html = html.replace(TOKEN.format(key), body)

    left = re.findall(r"/\*@\w+@\*/", html)
    if left:
        sys.exit("仍有未替换的占位符: %s" % ", ".join(left))

    # 说明性页脚，便于收到文件的人知道怎么重建
    html = html.replace("</body>",
                        "<!-- 本文件由 webgui/build.py 从 webgui/src/* 生成，"
                        "请勿直接编辑；改源码后重新运行 python webgui/build.py -->\n</body>")

    out = os.path.join(OUT_DIR, OUT_NAME)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    size = os.path.getsize(out)
    print("已生成 %s  (%.1f KB)" % (out, size / 1024.0))
    print("组件: " + ", ".join("%s=%d 字节" % (k, len(open(os.path.join(HERE, r), encoding='utf-8').read()))
                              for k, r in PARTS))


if __name__ == "__main__":
    main()
