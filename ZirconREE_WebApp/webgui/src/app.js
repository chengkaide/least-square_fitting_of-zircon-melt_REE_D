/* ============================================================================
 * app.js -- 界面逻辑：数据输入 / 计算 / 格式化结果 / 输出
 * 依赖：data.js (示例数据) + math.js (window.ZR)
 * ==========================================================================*/
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ZR = window.ZR;
  var TOOL = '锆石–熔体 REE 分配系数工具';
  var VER = ZR.VERSION;

  // 任何未捕获的脚本错误都显示在状态栏（方便用户反馈，也让无头测试能读到）
  window.addEventListener('error', function (ev) {
    var m = 'JS 错误: ' + ev.message + '  (行 ' + ev.lineno + ')';
    document.title = m;
    var el = document.getElementById('statusPill');
    if (el) { el.textContent = m; el.className = 'pill err'; }
    var so = document.getElementById('selftestOut');
    if (so) so.setAttribute('data-jserror', m);
  });

  /* ==================================================================== 工具 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fx(v, d) { return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d); }
  function sig(v, d) {
    if (v == null || !isFinite(v)) return '—';
    if (v === 0) return '0';
    var a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) return Number(v).toExponential(d);
    return Number(v).toPrecision(d);
  }
  /** 有效数字对齐：把 value ± err 都按 err 的量级取位（科学记数法用于论文） */
  function pm(value, err, unit) {
    if (err == null || !isFinite(err) || err === 0) return sig(value, 6) + (unit ? ' ' + unit : '');
    var exp = Math.floor(Math.log10(Math.abs(err)));
    var dec = Math.max(0, Math.min(12, -exp + 1));
    return value.toFixed(dec) + ' ± ' + err.toFixed(dec) + (unit ? ' ' + unit : '');
  }
  /** 压力有可能极小（如 0.000101325 GPa = 1 atm），按量级选格式 */
  function fmtP(v) { return (Math.abs(v) < 0.01 && v !== 0) ? Number(v).toPrecision(3) : fx(v, 2); }
  function numCell(s) {
    if (s == null) return null;
    var t = String(s).replace(/[\s\u00a0\u3000]/g, '');
    if (t === '' || /^(na|nan|nd|n\.d\.|—|–|-|\?)$/i.test(t)) return null;
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
    var v = Number(t);
    return isFinite(v) ? v : null;
  }
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function csvCell(v) {
    var s = (v == null) ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows) { return '\ufeff' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n'); }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function setStatus(text, cls) {
    var el = $('statusPill');
    el.textContent = text;
    el.className = 'pill' + (cls ? ' ' + cls : '');
  }
  function setBadge(pfx, text, cls) {
    var el = $(pfx + '_badge');
    if (!el) return;
    el.textContent = text;
    el.className = 'pill' + (cls ? ' ' + cls : '');
  }

  /* =========================================================== 表格解析 */
  function parseDelimited(text) {
    var lines = text.replace(/\r\n?/g, '\n').split('\n');
    var head = null, delim = '\t';
    for (var i = 0; i < lines.length && head === null; i++) {
      if (lines[i].trim() !== '') head = lines[i];
    }
    if (head === null) return { rows: [] };
    var nt = (head.match(/\t/g) || []).length;
    var nc = (head.match(/,/g) || []).length;
    var ns = (head.match(/;/g) || []).length;
    if (nt >= nc && nt >= ns && nt > 0) delim = '\t';
    else if (nc >= ns && nc > 0) delim = ',';
    else if (ns > 0) delim = ';';
    else delim = null;                                    // 空白分隔
    var rows = [];
    for (var k = 0; k < lines.length; k++) {
      var ln = lines[k];
      if (ln.trim() === '') continue;
      var cells = delim === null ? ln.trim().split(/\s+/) : splitCSV(ln, delim);
      rows.push(cells.map(function (c) { return c.trim(); }));
    }
    if (!rows.length) return { rows: [] };
    // 首行是否表头：非数值单元格占比 >= 50% 且至少一个单元格命中已知关键词
    var nonNum = rows[0].filter(function (c) { return c !== '' && numCell(c) === null; }).length;
    var frac = rows[0].length ? nonNum / rows[0].length : 0;
    var hasKV = rows[0].some(function (c) {
      return Object.keys(KWR).some(function (r) { return KWR[r].test(c); });
    });
    var hasHeader = frac >= 0.5 && (hasKV || rows[0].every(function (c) { return numCell(c) === null; }));
    var header = null, body = rows;
    if (hasHeader) { header = rows[0]; body = rows.slice(1); }
    var nCol = 0;
    body.forEach(function (r) { nCol = Math.max(nCol, r.length); });
    if (header) nCol = Math.max(nCol, header.length);
    var colNames = [];
    for (var c2 = 0; c2 < nCol; c2++) {
      colNames.push((header && header[c2] != null && String(header[c2]).trim() !== '')
        ? String(header[c2]).trim() : ('列' + (c2 + 1)));
    }
    return { header: header, colNames: colNames, rows: body, nCol: nCol };
  }
  function splitCSV(line, delim) {
    if (delim === '\t' || delim === ';') return line.split(delim);
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /* ---------------------------------------------------------- xlsx 读取 */
  function readU16(dv, p) { return dv.getUint16(p, true); }
  function readU32(dv, p) { return dv.getUint32(p, true); }

  function unzipEntries(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1, lim = Math.max(0, u8.length - 66000);
    for (var p = u8.length - 22; p >= lim; p--) {
      if (u8[p] === 0x50 && u8[p + 1] === 0x4b && u8[p + 2] === 0x05 && u8[p + 3] === 0x06) { eocd = p; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx（zip）文件');
    var nEnt = readU16(dv, eocd + 10), off = readU32(dv, eocd + 16);
    var out = {};
    for (var i = 0; i < nEnt; i++) {
      if (readU32(dv, off) !== 0x02014b50) break;
      var method = readU16(dv, off + 10);
      var csize = readU32(dv, off + 20);
      var nameLen = readU16(dv, off + 28), extraLen = readU16(dv, off + 30), cmtLen = readU16(dv, off + 32);
      var lho = readU32(dv, off + 42);
      var name = '';
      for (var j = 0; j < nameLen; j++) name += String.fromCharCode(u8[off + 46 + j]);
      var nl2 = readU16(dv, lho + 26), el2 = readU16(dv, lho + 28);
      var start = lho + 30 + nl2 + el2;
      out[name] = { method: method, data: u8.subarray(start, start + csize) };
      off += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }
  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前浏览器不支持解压（需 Chrome/Edge 103+）。请把表格另存为 CSV 后拖入。'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function dec(bytes) { return new TextDecoder('utf-8').decode(bytes); }

  function xlsxToTSV(u8) {
    var files = unzipEntries(u8);
    var names = Object.keys(files).filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); }).sort();
    if (!names.length) return Promise.reject(new Error('xlsx 里没找到工作表'));
    var sheet = names[0];
    var sheetCount = names.length;
    var jobs = [inflateRaw(files[sheet].data)];
    var hasShared = !!files['xl/sharedStrings.xml'];
    if (hasShared) jobs.push(inflateRaw(files['xl/sharedStrings.xml'].data));
    return Promise.all(jobs).then(function (res) {
      var shared = [];
      if (hasShared) {
        var doc = new DOMParser().parseFromString(dec(res[1]), 'application/xml');
        Array.prototype.forEach.call(doc.getElementsByTagName('si'), function (si) {
          var txt = '';
          Array.prototype.forEach.call(si.getElementsByTagName('t'), function (t) { txt += t.textContent; });
          shared.push(txt);
        });
      }
      var sd = new DOMParser().parseFromString(dec(res[0]), 'application/xml');
      var rows = sd.getElementsByTagName('row'), out = [];
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].getElementsByTagName('c'), line = [], col = -1;
        for (var k = 0; k < cells.length; k++) {
          var ref = cells[k].getAttribute('r') || '';
          var m = /^([A-Z]+)/.exec(ref);
          var idx = m ? colLetters(m[1]) : col + 1;
          while (col + 1 < idx) { line.push(''); col++; }
          var t = cells[k].getAttribute('t'), v = '';
          if (t === 's') {
            var vn = cells[k].getElementsByTagName('v')[0];
            v = vn ? (shared[parseInt(vn.textContent, 10)] || '') : '';
          } else if (t === 'inlineStr') {
            Array.prototype.forEach.call(cells[k].getElementsByTagName('t'), function (tt) { v += tt.textContent; });
          } else {
            var vn2 = cells[k].getElementsByTagName('v')[0];
            v = vn2 ? vn2.textContent : '';
          }
          line.push(String(v).trim());
          col = idx;
        }
        out.push(line.join('\t'));
      }
      var tsv = out.join('\n');
      if (sheetCount > 1) tsv = '# 注意：xlsx 含 ' + sheetCount + ' 个工作表，只读取了第一个\n' + tsv;
      return tsv;
    });
  }
  function colLetters(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  /* ====================================================== 列角色识别 */
  // 用正则而不是简单 substring：否则 'Radii' 会被 'di' 命中、'Element' 会被 't' 命中
  var KWR = {
    el: /(^|[^a-z])(element|el|name|sample)(?![a-z])|元素|离子|样品/i,
    ri: /(^|[^a-z])(ri|radius|radii|r)(?![a-z])|半径|ionic/i,
    di: /(^|[^a-z])(di|d|partition|coefficient|kd)(?![a-z])|分配/i,
    s1: /(^|[^a-z0-9])1s(?![a-z0-9])|(^|[^a-z])s1(?![a-z])|err|error|sigma|(?<![a-z])sd(?![a-z])|std|±|1σ|误差/i,
    t: /(^|[^a-z])(t|temp|temperature)(?![a-z])|温度/i,
    p: /(^|[^a-z])(p|pressure)(?![a-z])|压力/i
  };
  function matchRole(name, role) {
    return KWR[role].test(String(name).trim());
  }

  /* ============================================================= 图表 */
  var PALETTE = ['#4f9cf9', '#3ecf8e', '#f0a52b', '#c084fc', '#22d3ee', '#fb7185', '#a3e635'];
  function cssVar(n) { return getComputedStyle(document.body).getPropertyValue(n).trim() || '#888'; }

  function niceTicks(lo, hi, want) {
    var span = hi - lo;
    if (!(span > 0)) return [lo];
    var raw = span / want;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag, step;
    if (norm <= 1) step = 1; else if (norm <= 2) step = 2; else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5; else step = 10;
    step *= mag;
    var out = [], v = Math.ceil(lo / step) * step;
    for (; v <= hi + step * 1e-9; v += step) out.push(v);
    return out;
  }
  function prepCanvas(c) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var cssH = Number(c.getAttribute('data-h') || 300);
    var cssW = Math.max(320, c.parentElement.clientWidth - 24);
    c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
    c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx: ctx, w: cssW, h: cssH };
  }
  function fmtTick(v, step) {
    if (v === 0) return '0';
    var dec = Math.max(0, Math.min(9, Math.ceil(-Math.log10(Math.abs(step) * 0.999))));
    var a = Math.abs(v);
    if (a >= 1e5 || a < 1e-4) return Number(v).toExponential(0);
    return Number(v).toFixed(dec);
  }
  function drawErrorBars(ctx, pts, sx, sy, color, capW) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    pts.forEach(function (p) {
      if (p.ey == null || !(p.ey > 0)) return;
      if (!(p.y - p.ey > 0)) return;
      var X = sx(p.x), Y1 = sy(p.y - p.ey), Y2 = sy(p.y + p.ey);
      ctx.beginPath(); ctx.moveTo(X, Y1); ctx.lineTo(X, Y2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X - capW, Y1); ctx.lineTo(X + capW, Y1);
      ctx.moveTo(X - capW, Y2); ctx.lineTo(X + capW, Y2); ctx.stroke();
    });
  }
  function drawLine(ctx, xs, ys, sx, sy, color, width) {
    ctx.strokeStyle = color; ctx.lineWidth = width || 2; ctx.beginPath();
    for (var i = 0; i < xs.length; i++) {
      var X = sx(xs[i]), Y = sy(ys[i]);
      if (!isFinite(X) || !isFinite(Y)) continue;
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.stroke();
  }
  function drawPoly(ctx, points, sx, sy, color, width) {
    ctx.strokeStyle = color; ctx.lineWidth = width || 2; ctx.beginPath();
    points.forEach(function (p, i) { i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y)); });
    ctx.stroke();
  }
  function textBox(ctx, lines, x, y, align, fs) {
    fs = fs || 12;
    ctx.font = fs + 'px ui-monospace, Consolas, monospace';
    var w = 0;
    lines.forEach(function (l) { w = Math.max(w, ctx.measureText(l).width); });
    var h = lines.length * (fs + 5) + 10;
    var bx = align === 'right' ? x - w - 14 : x;
    var by = y;
    ctx.fillStyle = cssVar('--panel2'); ctx.globalAlpha = 0.94;
    ctx.fillRect(bx, by, w + 14, h); ctx.globalAlpha = 1;
    ctx.strokeStyle = cssVar('--line2'); ctx.lineWidth = 1; ctx.strokeRect(bx + .5, by + .5, w + 13, h - 1);
    ctx.fillStyle = cssVar('--text');
    lines.forEach(function (l, i) { ctx.fillText(l, bx + 7, by + fs + 5 + i * (fs + 5) - 2); });
    return by + h;
  }

  /**
   * 主拟合图：横轴 r_i (线性)，纵轴 D (对数)。
   * opt = {points:[{x,y,ey,c,label}], curves:[{pts:[{x,y}],c,label}], boxes:[str],
   *        xRange, yRange, yLabel}
   */
  function drawMainChart(canvas, opt) {
    var g = prepCanvas(canvas), ctx = g.ctx, W = g.w, H = g.h;
    var padL = 58, padR = 14, padT = 12, padB = 34;
    var pw = W - padL - padR, ph = H - padT - padB;
    var pts = opt.points || [];
    var curves = opt.curves || [];

    var xs = [];
    pts.forEach(function (p) { xs.push(p.x); });
    curves.forEach(function (c) { c.pts.forEach(function (p) { xs.push(p.x); }); });
    var xlo = opt.xRange ? opt.xRange[0] : Math.min.apply(null, xs) - 0.03;
    var xhi = opt.xRange ? opt.xRange[1] : Math.max.apply(null, xs) + 0.03;
    var allY = [];
    pts.forEach(function (p) {
      if (p.y > 0) allY.push(p.y);
      if (p.ey != null && p.y - p.ey > 0) allY.push(p.y - p.ey);
      if (p.ey != null) allY.push(p.y + p.ey);
    });
    curves.forEach(function (c) { c.pts.forEach(function (p) { if (p.y > 0) allY.push(p.y); }); });
    if (!allY.length) allY = [0.001, 1];
    var ylo = opt.yRange ? opt.yRange[0] : Math.min.apply(null, allY);
    var yhi = opt.yRange ? opt.yRange[1] : Math.max.apply(null, allY);
    ylo = Math.max(ylo, 1e-12); if (yhi <= ylo) yhi = ylo * 10;
    ylo = Math.pow(10, Math.floor(Math.log10(ylo))); yhi = Math.pow(10, Math.ceil(Math.log10(yhi)));

    var sx = function (x) { return padL + (x - xlo) / (xhi - xlo) * pw; };
    var sy = function (y) {
      y = Math.max(y, ylo);
      var a = Math.log10(y), b = Math.log10(ylo), c = Math.log10(yhi);
      return padT + (1 - (a - b) / (c - b)) * ph;
    };

    // 网格 + y 轴（对数）
    ctx.font = '11px ui-monospace, Consolas, monospace';
    var d0 = Math.floor(Math.log10(ylo)), d1 = Math.ceil(Math.log10(yhi));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var d = d0; d <= d1; d++) {
      var dec = [0.1, 0.2, 0.5].concat([1]);
      for (var k = 0; k < 10; k++) {
        var mult = (k === 0 ? 1 : (k === 1 ? 2 : (k === 2 ? 3 : (k === 5 ? 5 : null))));
        if (d === d0 && k > 0) { /* 底部十进之间也画 */ }
        if (mult == null) continue;
        var val = mult * Math.pow(10, d);
        if (val < ylo * 0.999 || val > yhi * 1.001) continue;
        var Y = sy(val);
        var major = (k === 0);
        ctx.strokeStyle = major ? cssVar('--grid') : cssVar('--line');
        ctx.globalAlpha = major ? 1 : 0.5;
        ctx.beginPath(); ctx.moveTo(padL, Y); ctx.lineTo(padL + pw, Y); ctx.stroke();
        ctx.globalAlpha = 1;
        if (major) { ctx.fillStyle = cssVar('--muted'); ctx.fillText(fmtTick(val, Math.pow(10, d)), padL - 7, Y); }
      }
    }
    // x 轴
    var xticks = niceTicks(xlo, xhi, 6);
    var xstep = xticks.length > 1 ? xticks[1] - xticks[0] : 0.1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    xticks.forEach(function (t) {
      var X = sx(t);
      ctx.strokeStyle = cssVar('--grid');
      ctx.beginPath(); ctx.moveTo(X, padT); ctx.lineTo(X, padT + ph); ctx.stroke();
      ctx.fillStyle = cssVar('--muted'); ctx.fillText(fmtTick(t, xstep), X, padT + ph + 7);
    });
    ctx.strokeStyle = cssVar('--line2'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + ph); ctx.lineTo(padL + pw, padT + ph); ctx.stroke();

    // 曲线
    curves.forEach(function (c) {
      ctx.save();
      ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
      var seg = [], prevSign = null;
      c.pts.forEach(function (p) {
        var s = (p.y > 0 && isFinite(p.y)) ? 1 : -1;
        if (prevSign !== null && s !== prevSign) { if (seg.length > 1) drawPoly(ctx, seg, sx, sy, c.c, 2.2); seg = []; }
        if (s > 0) seg.push(p); else seg = [];
        prevSign = s;
      });
      if (seg.length > 1) drawPoly(ctx, seg, sx, sy, c.c, 2.2);
      ctx.restore();
    });
    // 误差棒
    pts.forEach(function (p) { drawErrorBars(ctx, [p], sx, sy, p.c || cssVar('--pt'), 3.5); });
    // 数据点
    pts.forEach(function (p) {
      ctx.fillStyle = p.c || cssVar('--pt');
      ctx.strokeStyle = cssVar('--panel'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), 3.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
    // 轴标签
    ctx.fillStyle = cssVar('--muted'); ctx.font = '12px -apple-system, "Segoe UI", "Microsoft YaHei"';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('离子半径 r_i (Å)', padL + pw / 2, padT + ph + 21);
    ctx.save();
    ctx.translate(13, padT + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle'; ctx.fillText(opt.yLabel || 'D(Zircon/Melt)', 0, 0);
    ctx.restore();
    // 结果框
    var by = padT + 6;
    if (opt.boxes && opt.boxes.length) by = textBox(ctx, opt.boxes, padL + 8, padT + 6, 'left', 12);
    if (opt.topleft) textBox(ctx, opt.topleft, padL + pw - 8, padT + 6, 'right', 12);
    // 图例
    if (opt.legend && opt.legend.length) {
      var lx = padL + 10, ly = padT + ph - 14 - (opt.legend.length - 1) * 16;
      ctx.font = '11.5px ui-monospace, Consolas, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      opt.legend.forEach(function (L, i) {
        var y = ly + i * 16;
        ctx.fillStyle = L.c; ctx.beginPath(); ctx.arc(lx + 4, y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = cssVar('--text'); ctx.fillText(L.label, lx + 14, y + 1);
      });
    }
    return { sx: sx, sy: sy, padL: padL, padT: padT, pw: pw, ph: ph };
  }

  /** 残差图：线性纵轴，带 ±参考线。bandLabel 为空时按 σ 标注 */
  function drawResidChart(canvas, pts, yLabel, bands, bandLabel) {
    var g = prepCanvas(canvas), ctx = g.ctx, W = g.w, H = g.h;
    var padL = 58, padR = 14, padT = 22, padB = 34;
    var pw = W - padL - padR, ph = H - padT - padB;
    ctx.font = '11px ui-monospace, Consolas, monospace';
    if (!pts.length) {
      ctx.fillStyle = cssVar('--muted'); ctx.textAlign = 'center';
      ctx.fillText('无残差数据', W / 2, H / 2);
      return;
    }
    var xs = pts.map(function (p) { return p.x; }), rs = pts.map(function (p) { return p.r; });
    var xlo = Math.min.apply(null, xs) - 0.02, xhi = Math.max.apply(null, xs) + 0.02;
    var mx = Math.max.apply(null, rs.map(Math.abs));
    var lim = Math.max(1e-6, mx * 1.15);
    bands = bands || [];
    bands.forEach(function (b) { lim = Math.max(lim, b * 1.2); });
    var sx = function (x) { return padL + (x - xlo) / (xhi - xlo) * pw; };
    var sy = function (r) { return padT + (1 - (r + lim) / (2 * lim)) * ph; };
    // 参考线
    bands.forEach(function (b) {
      [b, -b].forEach(function (v, k) {
        var Y = sy(v);
        ctx.strokeStyle = cssVar('--line'); ctx.setLineDash(k ? [] : [4, 4]);
        ctx.beginPath(); ctx.moveTo(padL, Y); ctx.lineTo(padL + pw, Y); ctx.stroke();
        ctx.setLineDash([]);
      });
    });
    ctx.strokeStyle = cssVar('--line2'); ctx.beginPath();
    ctx.moveTo(padL, sy(0)); ctx.lineTo(padL + pw, sy(0)); ctx.stroke();
    var ticks = niceTicks(-lim, lim, 4);
    ticks.forEach(function (t) {
      ctx.strokeStyle = cssVar('--grid'); ctx.beginPath();
      ctx.moveTo(padL, sy(t)); ctx.lineTo(padL + pw, sy(t)); ctx.stroke();
    });
    ctx.fillStyle = cssVar('--muted'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    var stp = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
    ticks.forEach(function (t) { ctx.fillText(fmtTick(t, stp), padL - 7, sy(t)); });
    var xticks = niceTicks(xlo, xhi, 5), xs2 = xticks.length > 1 ? xticks[1] - xticks[0] : 0.1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    xticks.forEach(function (t) { ctx.fillText(fmtTick(t, xs2), sx(t), padT + ph + 6); });
    pts.forEach(function (p) {
      ctx.fillStyle = p.c || cssVar('--pt');
      ctx.beginPath(); ctx.arc(sx(p.x), sy(p.r), 3.4, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = cssVar('--muted'); ctx.font = '11px -apple-system, "Segoe UI", "Microsoft YaHei"';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(yLabel, padL + 2, padT - 1);
    if (bands.length) {
      ctx.textAlign = 'right';
      ctx.fillText(bandLabel || ('参考线 ±' + bands.join(' / ±')), padL + pw, padT - 1);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('离子半径 r_i (Å)', padL + pw / 2, padT + ph + 19);
  }

  /* ===================================================== 通用：数据层 */
  var ST = {};

  function textareaOf(pfx) {
    var m = { m1: 1, m2: 2, m3: 3 }[pfx];
    return $('m' + m + '_data');
  }
  function refreshTable(pfx) {
    var txt = textareaOf(pfx).value;
    var t = parseDelimited(txt);
    ST[pfx].table = t;
    return t;
  }
  function colTitle(t, i) { return t.colNames[i] || ('列' + (i + 1)); }

  function fillSelect(sel, t, role, allowNone, noneLabel) {
    var prev = sel.value;
    sel.innerHTML = '';
    if (allowNone) {
      var o = document.createElement('option');
      o.value = '-1'; o.textContent = noneLabel || '— 无 —';
      sel.appendChild(o);
    }
    for (var i = 0; i < t.nCol; i++) {
      var op = document.createElement('option');
      op.value = String(i);
      op.textContent = (i + 1) + ': ' + colTitle(t, i);
      sel.appendChild(op);
    }
    var has = Array.prototype.some.call(sel.options, function (o2) { return o2.value === prev; });
    sel.value = has ? prev : '-1';
  }
  function autoMap(t, role, sel, allowNone) {
    // 表头关键词优先
    if (t.header) {
      for (var i = 0; i < t.nCol; i++) {
        if (matchRole(t.colNames[i], role)) {
          if (allowNone) { /* 继续找 D 列，避免把 'D(Sample)' 抢成 element */ }
          sel.value = String(i); return true;
        }
      }
    }
    return false;
  }
  function autoMapDi(t, sel) {
    if (t.header) {
      for (var i = 0; i < t.nCol; i++) {
        var n = t.colNames[i].toLowerCase();
        if (matchRole(n, 'di') && !matchRole(n, 's1')) { sel.value = String(i); return true; }
      }
    }
    return false;
  }
  function detectLatticeMaps(pfx, force) {
    var t = ST[pfx].table, s = ST[pfx].maps;
    var ids = { el: pfx + '_mapEl', ri: pfx + '_mapRi', di: pfx + '_mapDi', s: pfx + '_mapS' };
    Object.keys(ids).forEach(function (k) { fillSelect($(ids[k]), t, k, true); });
    if (!t.nCol) return;
    var numeric = {};
    for (var i = 0; i < t.nCol; i++) {
      var nNum = 0, tot = 0;
      t.rows.forEach(function (r) { tot++; if (numCell(r[i]) !== null) nNum++; });
      numeric[i] = tot ? nNum / tot : 0;
    }
    if (force || !s.inited) {
      autoMap(t, 'el', $(ids.el), true) || ($(ids.el).value = '-1');
      autoMap(t, 'ri', $(ids.ri), true);
      autoMapDi(t, $(ids.di));
      autoMap(t, 's1', $(ids.s), true) || ($(ids.s).value = '-1');
      // 无表头时的启发式
      if (!t.header) {
        if (numeric[0] < 0.3) {
          $(ids.el).value = '0'; $(ids.ri).value = '1'; $(ids.di).value = '2'; $(ids.s).value = t.nCol > 3 ? '3' : '-1';
        } else {
          $(ids.el).value = '-1';
          var cands = [];
          for (var c = 0; c < t.nCol; c++) if (numeric[c] > 0.8) cands.push(c);
          if (cands.length >= 3 && isRadiusCol(t, cands[0])) {
            $(ids.ri).value = String(cands[0]); $(ids.di).value = String(cands[1]); $(ids.s).value = String(cands[2]);
          } else if (cands.length >= 2) {
            $(ids.ri).value = String(cands[0]); $(ids.di).value = String(cands[1]); $(ids.s).value = '-1';
          }
        }
      } else {
        if ($(ids.ri).value === '-1') {
          for (var c2 = 0; c2 < t.nCol; c2++) if (numeric[c2] > 0.8 && isRadiusCol(t, c2)) { $(ids.ri).value = String(c2); break; }
        }
        if ($(ids.di).value === '-1') {
          for (var c3 = 0; c3 < t.nCol; c3++) {
            if (String(c3) !== $(ids.ri).value && String(c3) !== $(ids.el).value && numeric[c3] > 0.8) { $(ids.di).value = String(c3); break; }
          }
        }
      }
      s.inited = true;
    }
    s.el = Number($(ids.el).value); s.ri = Number($(ids.ri).value);
    s.di = Number($(ids.di).value); s.s = Number($(ids.s).value);
    s.tCol = -1; s.pCol = -1;
    for (var c4 = 0; c4 < t.nCol; c4++) {
      if (matchRole(t.colNames[c4], 't') && s.tCol < 0) s.tCol = c4;
      if (matchRole(t.colNames[c4], 'p') && s.pCol < 0) s.pCol = c4;
    }
  }
  function isRadiusCol(t, c) {
    var ok = 0, tot = 0;
    t.rows.forEach(function (r) { var v = numCell(r[c]); if (v !== null) { tot++; if (v > 0.6 && v < 1.7) ok++; } });
    return tot > 0 && ok / tot > 0.8;
  }

  function extractLattice(pfx) {
    var t = ST[pfx].table, s = ST[pfx].maps, out = { rows: [], issues: [] };
    var minPoints = pfx === 'm2' ? 3 : 4;
    if (!t.rows.length) { out.issues.push(['e', '没有解析到数据行。请粘贴表格或拖入文件。']); return out; }
    if (s.ri < 0) { out.issues.push(['e', '未指定「离子半径 ri」列。']); return out; }
    if (s.di < 0) { out.issues.push(['e', '未指定「分配系数 D」列。']); return out; }
    var dup = {}, dropped = 0, noErr = 0, badRadius = 0;
    t.rows.forEach(function (r, idx) {
      var ri = numCell(r[s.ri]), di = numCell(r[s.di]);
      var el = s.el >= 0 ? (r[s.el] || '') : ('行' + (idx + 2));
      var s1 = s.s >= 0 ? numCell(r[s.s]) : null;
      if (ri === null || di === null) { dropped++; return; }
      if (!(di > 0)) { dropped++; return; }
      if (ri < 0.6 || ri > 1.7) badRadius++;
      if (s1 === null) noErr++;
      if (dup[ri]) out.issues.push(['w', '离子半径 ri = ' + ri + ' 出现重复（' + el + '）。']);
      dup[ri] = true;
      out.rows.push({ el: el, ri: ri, di: di, s1: s1 });
    });
    if (dropped) out.issues.push(['w', '有 ' + dropped + ' 行被跳过（ri 或 D 缺失、D ≤ 0 无法取对数）。']);
    if (badRadius) out.issues.push(['w', '有 ' + badRadius + ' 行的 ri 超出常见 REE 半径范围 0.6–1.7 Å，请确认列映射。']);
    if (noErr && s.s >= 0) out.issues.push(['w', '有 ' + noErr + ' 行缺误差值，将按 σ=1 处理。']);
    if (!noErr && s.s < 0) out.issues.push(['i', '未指定误差列：按不加权（σ=1）拟合。']);
    if (out.rows.length < minPoints) out.issues.push(['e', '有效数据点只有 ' + out.rows.length + ' 个，拟合至少需要 ' + minPoints + ' 个点。']);
    else if (out.rows.length < 6) out.issues.push(['w', '数据点较少（' + out.rows.length + '），参数误差可能不可靠。']);
    var span = out.rows.length > 1 ? Math.max.apply(null, out.rows.map(function (r) { return r.ri; })) - Math.min.apply(null, out.rows.map(function (r) { return r.ri; })) : 0;
    if (span > 0 && span < 0.08) out.issues.push(['w', '半径跨度只有 ' + span.toFixed(3) + ' Å，拟合会病态（E 与 r₀ 高度相关）。']);
    return out;
  }

  function setMsgs(pfx, list) {
    var ul = $(pfx + '_msgs');
    ul.innerHTML = list.map(function (m) { return '<li class="' + m[0] + '">' + esc(m[1]) + '</li>'; }).join('');
  }

  function renderPreview(pfx, data, res) {
    var box = $(pfx + '_stats');
    var rows = data.rows;
    if (!rows.length) { box.innerHTML = '<p class="hint" style="padding:10px">暂无数据</p>'; return; }
    var h = '<table class="data"><thead><tr><th>#</th><th>元素</th><th>ri (Å)</th><th>D 实测</th><th>1σ</th>';
    if (res) h += '<th>D 计算</th><th>加权残差</th>';
    h += '</tr></thead><tbody>';
    rows.forEach(function (r, i) {
      var bad = '';
      if (res) {
        var w = (r.di - res.pred[i]) / (res.sigmaMode.sigma[i] || 1);
        var flag = Math.abs(w);
        bad = (flag > 3) ? ' class="bl"' : '';
      }
      h += '<tr' + bad + '><td>' + (i + 1) + '</td><td>' + esc(r.el) + '</td><td>' + r.ri.toFixed(3) + '</td><td>' +
        (r.di < 0.01 ? r.di.toExponential(3) : r.di.toPrecision(5)) + '</td><td>' + (r.s1 == null ? '—' : (r.s1 < 0.01 ? r.s1.toExponential(2) : r.s1.toPrecision(3))) + '</td>';
      if (res) {
        var dc = res.pred[i];
        h += '<td>' + (dc < 0.01 ? dc.toExponential(3) : dc.toPrecision(5)) + '</td><td>' +
          (((r.di - dc) / (res.sigmaMode.sigma[i] || 1))).toFixed(2) + '</td>';
      }
      h += '</tr>';
    });
    h += '</tbody></table>';
    box.innerHTML = h;
  }

  /* ============================================== 结果卡片与统计表渲染 */
  function bigvals(pfx, items) {
    $(pfx + '_bigvals').innerHTML = items.map(function (it) {
      return '<div class="bv"><div class="k">' + it.k + '</div><div class="v">' + it.v +
        (it.u ? ' <span class="u">' + it.u + '</span>' : '') + '</div>' +
        (it.e ? '<div class="e">' + it.e + '</div>' : '') + '</div>';
    }).join('');
  }
  function statsTable(pfx, rows) {
    return '<table class="data"><tbody>' + rows.map(function (r) {
      return '<tr><td style="color:var(--muted)">' + r[0] + '</td><td>' + r[1] + '</td></tr>';
    }).join('') + '</tbody></table>';
  }
  function convergenceTags(res) {
    var t = [];
    if (res.optimalityVerified) t.push('<span class="tag ok">最优性已验证</span>');
    else t.push('<span class="tag err">收敛可疑</span>');
    if (res.boundHit) t.push('<span class="tag warn">触及参数边界</span>');
    if (res.chi2red != null && res.chi2red > 4) t.push('<span class="tag warn">χ²/dof 偏大 (' + fx(res.chi2red, 2) + ')</span>');
    t.push('<span class="tag">迭代 ' + res.iters + '</span>');
    return t.join('');
  }

  /* ========================================================== ① 自由拟合 */
  function computeM1() {
    var pfx = 'm1', st = ST[pfx];
    refreshTable(pfx);
    detectLatticeMaps(pfx);
    var data = extractLattice(pfx);
    var msgs = data.issues.slice();
    if (!data.rows.length || data.rows.length < 4 || st.maps.ri < 0 || st.maps.di < 0) {
      setMsgs(pfx, msgs);
      renderPreview(pfx, data, null);
      $(pfx + '_report').textContent = '数据不足，无法拟合。';
      bigvals(pfx, [{ k: '状态', v: '待输入' }]);
      st.res = null;
      setBadge(pfx, '数据不足', 'err'); setStatus('数据不足', 'err');
      return;
    }
    var T = Number($(pfx + '_T').value), P = Number($(pfx + '_P').value);
    if (!isFinite(T)) {
      msgs.push(['e', '温度 T 无效，请填写数值。']);
      setMsgs(pfx, msgs); setBadge(pfx, '参数错误', 'err'); setStatus('参数错误', 'err'); st.res = null; return;
    }
    var errMode = $(pfx + '_errmode').value;
    if (errMode === 'none') msgs.push(['i', '按不加权拟合（σ=1），误差标度设置被忽略。']);
    var absSigma = $(pfx + '_abs').value === 'abs1';
    var res;
    try {
      res = ZR.fitFree({
        ri: data.rows.map(function (r) { return r.ri; }),
        di: data.rows.map(function (r) { return r.di; }),
        s1: data.rows.map(function (r) { return r.s1 == null ? 1 : r.s1; }),
        T_C: T, P_GPa: P, errMode: errMode, absoluteSigma: absSigma
      });
    } catch (e) {
      msgs.push(['e', '拟合失败：' + e.message]);
      setMsgs(pfx, msgs); setBadge(pfx, '拟合失败', 'err'); setStatus('拟合失败', 'err');
      return;
    }
    res.rows = data.rows;
    st.res = res; st.data = data;
    if (res.sigmaMode.degraded) msgs.push(['w', '有 ' + res.sigmaMode.degraded + ' 个误差值无效（≤0 或非数值），已按 σ=1 处理。']);
    if (res.fit.boundHit) msgs.push(['w', '有参数顶在边界上，说明该模型/数据组合不合适，结果不可直接使用。']);
    setMsgs(pfx, msgs);

    var conv = res.conv, T_K = res.T_K;
    bigvals(pfx, [
      { k: 'D₀', v: fx(res.D0, 2), e: '± ' + fx(res.dD0, 2) },
      { k: 'r₀ (Å)', v: fx(res.r0, 4), e: '± ' + fx(res.dr0, 4) },
      { k: 'E (GPa)', v: fx(res.E_GPa, 0), e: '± ' + fx(res.dE_GPa, 0) },
      { k: '拟合质量', v: fx(res.stats.r2_log, 4), u: 'R²(logD)', e: 'χ²/dof = ' + fx(res.fit.chi2red, 3) }
    ]);
    $(pfx + '_report').textContent = reportM1(res, data);
    $(pfx + '_stats').innerHTML = statsTable(pfx, [
      ['数据点数 N', String(data.rows.length)],
      ['自由度 dof', String(res.fit.dof)],
      ['加权 χ²', fx(res.fit.ssr, 4)],
      ['χ²/dof', fx(res.fit.chi2red, 4)],
      ['RMSWD = √(χ²/N)', fx(Math.sqrt(res.fit.ssr / data.rows.length), 4)],
      ['R²(log₁₀D)', fx(res.stats.r2_log, 5)],
      ['RMS(log₁₀D)', fx(res.stats.rms_log, 4)],
      ['最大 |Δlog₁₀D|', fx(res.stats.maxResLog, 4)],
      ['温度 T', fx(T, 1) + ' °C = ' + fx(T_K, 2) + ' K'],
      ['压力 P（仅标注）', fmtP(P) + ' GPa'],
      ['E 换算因子', sig(conv, 6) + ' GPa per unit'],
      ['误差标度', absSigma ? '绝对 1σ（absolute_sigma=True）' : '按 χ² 缩放（False）'],
      ['求解器', 'LM + GN 抛光，迭代 ' + res.fit.iters + ' 次，判据 ' + res.fit.reason]
    ]) + '<div class="tags" style="padding:8px 10px">' + convergenceTags(res.fit) + '</div>';
    renderPreview(pfx, data, res);
    drawM1Charts(res, data);
    setBadge(pfx, '已计算', 'ok'); setStatus('计算完成 · ' + data.rows.length + ' 点', 'ok');
  }

  function reportM1(res, data) {
    var L = [];
    L.push('── 自由晶格应变拟合结果 ─────────────────────────');
    L.push('D₀  = ' + pm(res.D0, res.dD0));
    L.push('r₀  = ' + pm(res.r0, res.dr0, 'Å'));
    L.push('E   = ' + pm(res.E_GPa, res.dE_GPa, 'GPa'));
    L.push('');
    L.push('条件   T = ' + fx($('m1_T').value, 1) + ' °C (' + fx(res.T_K, 2) + ' K)' +
      '，P = ' + fmtP(Number($('m1_P').value)) + ' GPa（仅标注）');
    L.push('数据   N = ' + data.rows.length + '，误差 ' + errLabel('m1') +
      '，dof = ' + res.fit.dof);
    L.push('质量   χ²/dof = ' + fx(res.fit.chi2red, 4) +
      '，RMSWD = ' + fx(Math.sqrt(res.fit.ssr / data.rows.length), 4) +
      '，R²(log₁₀D) = ' + fx(res.stats.r2_log, 5));
    L.push('收敛   ' + (res.fit.optimalityVerified ? '最优性已验证（±1e-8 窗口内无更低 SSR）' : '未达最优，请检查数据') +
      (res.fit.boundHit ? '｜警告：参数触界' : ''));
    L.push('生成   ' + TOOL + ' v' + VER + '  ' + stamp());
    return L.join('\n');
  }
  function errLabel(pfx) {
    var v = $(pfx + '_errmode').value;
    return v === 'abs' ? '绝对 1σ' : (v === 'pct' ? '相对百分数' : '不加权');
  }

  function drawM1Charts(res, data) {
    var box = ['D₀ = ' + fx(res.D0, 2) + ' ± ' + fx(res.dD0, 2),
      'r₀ = ' + fx(res.r0, 4) + ' ± ' + fx(res.dr0, 4) + ' Å',
      'E  = ' + fx(res.E_GPa, 0) + ' ± ' + fx(res.dE_GPa, 0) + ' GPa'];
    var riMin = Math.min.apply(null, data.rows.map(function (r) { return r.ri; }));
    var riMax = Math.max.apply(null, data.rows.map(function (r) { return r.ri; }));
    var xlo = Math.min(0.8, riMin - 0.05), xhi = Math.max(1.22, riMax + 0.05);
    var curve = [], n = 260;
    for (var i = 0; i <= n; i++) {
      var x = xlo + (xhi - xlo) * i / n;
      curve.push({ x: x, y: res.pred.length ? ZR.MODEL_FREE.eval(x, res.fit.p) : NaN });
    }
    drawMainChart($('m1_chart'), {
      points: data.rows.map(function (r) { return { x: r.ri, y: r.di, ey: r.s1, c: cssVar('--pt') }; }),
      curves: [{ pts: curve, c: cssVar('--curve') }],
      xRange: [xlo, xhi], boxes: box,
      topleft: [fmtP(Number($('m1_P').value)) + ' GPa']
    });
    drawResidChart($('m1_resid'), data.rows.map(function (r, i) {
      return { x: r.ri, r: (r.di - res.pred[i]) / (res.sigmaMode.sigma[i] || 1), c: cssVar('--curve') };
    }), '加权残差 (D_obs − D_calc)/σ', [1, 2], '参考线 ±1σ / ±2σ');
  }

  /* ======================================================== ② 约束拟合 */
  function computeM2() {
    var pfx = 'm2', st = ST[pfx];
    refreshTable(pfx);
    detectLatticeMaps(pfx);
    var data = extractLattice(pfx);
    var msgs = data.issues.slice();
    if (!data.rows.length || data.rows.length < 3 || st.maps.ri < 0 || st.maps.di < 0) {
      setMsgs(pfx, msgs); renderPreview(pfx, data, null);
      $(pfx + '_report').textContent = '数据不足，无法拟合。';
      bigvals(pfx, [{ k: '状态', v: '待输入' }]);
      st.res = null; setBadge(pfx, '数据不足', 'err'); setStatus('数据不足', 'err');
      return;
    }
    var T = Number($(pfx + '_T').value), Q = Number($(pfx + '_Q').value), P = Number($(pfx + '_P').value);
    var errMode = $(pfx + '_errmode').value;
    var absSigma = $(pfx + '_abs').value === 'abs1';
    var res;
    try {
      res = ZR.fitConstrained({
        ri: data.rows.map(function (r) { return r.ri; }),
        di: data.rows.map(function (r) { return r.di; }),
        s1: data.rows.map(function (r) { return r.s1 == null ? 1 : r.s1; }),
        T_C: T, Q: Q, errMode: errMode, absoluteSigma: absSigma
      });
    } catch (e) {
      msgs.push(['e', '拟合失败：' + e.message]); setMsgs(pfx, msgs);
      setBadge(pfx, '拟合失败', 'err'); setStatus('拟合失败', 'err'); return;
    }
    res.rows = data.rows; st.res = res; st.data = data;
    if (res.fit.boundHit) msgs.push(['w', '有参数顶在边界上，结果不可直接使用。']);
    setMsgs(pfx, msgs);
    bigvals(pfx, [
      { k: 'D₀', v: fx(res.D0, 3), e: '± ' + fx(res.dD0, 3) },
      { k: 'r₀ (Å)', v: fx(res.r0, 4), e: '± ' + fx(res.dr0, 4) },
      { k: 'E (GPa)', v: fx(res.E_GPa, 1), e: '± ' + fx(res.dE_GPa, 1) },
      { k: '拟合质量', v: fx(res.stats.r2_log, 4), u: 'R²(logD)', e: 'χ²/dof = ' + fx(res.fit.chi2red, 3) }
    ]);
    $(pfx + '_report').textContent = [
      '── 约束晶格应变拟合结果（锆石，Q 约束） ─────────',
      'D₀  = ' + pm(res.D0, res.dD0),
      'r₀  = ' + pm(res.r0, res.dr0, 'Å'),
      'E   = ' + pm(res.E_GPa, res.dE_GPa, 'GPa') + '   （由 Q 推出，误差按 2 阶泰勒传播）',
      '',
      '约束   Q = ' + Q + '（' + (Q === 6489 ? 'Q₁' : 'Q₂') + '），E = Q/(1.38+r₀)³',
      '条件   T = ' + fx(T, 1) + ' °C (' + fx(res.T_K, 2) + ' K)，P = ' + fmtP(P) + ' GPa（仅标注）',
      '数据   N = ' + data.rows.length + '，误差 ' + errLabel('m2') + '，dof = ' + res.fit.dof,
      '质量   χ²/dof = ' + fx(res.fit.chi2red, 4) + '，RMSWD = ' + fx(Math.sqrt(res.fit.ssr / data.rows.length), 4) +
      '，R²(log₁₀D) = ' + fx(res.stats.r2_log, 5),
      '收敛   ' + (res.fit.optimalityVerified ? '最优性已验证' : '未达最优，请检查数据') + (res.fit.boundHit ? '｜警告：参数触界' : ''),
      '生成   ' + TOOL + ' v' + VER + '  ' + stamp()
    ].join('\n');
    $(pfx + '_stats').innerHTML = statsTable(pfx, [
      ['数据点数 N', String(data.rows.length)],
      ['自由度 dof', String(res.fit.dof)],
      ['加权 χ²', fx(res.fit.ssr, 4)],
      ['χ²/dof', fx(res.fit.chi2red, 4)],
      ['RMSWD', fx(Math.sqrt(res.fit.ssr / data.rows.length), 4)],
      ['R²(log₁₀D)', fx(res.stats.r2_log, 5)],
      ['RMS(log₁₀D)', fx(res.stats.rms_log, 4)],
      ['约束常数 Q', String(Q) + ' ×10⁻²¹ J'],
      ['约束强度 indi_var', sig(res.indiVar, 6)],
      ['温度 T', fx(T, 1) + ' °C = ' + fx(res.T_K, 2) + ' K'],
      ['误差标度', absSigma ? '绝对 1σ（True）' : '按 χ² 缩放（False）'],
      ['求解器', 'LM + GN 抛光，迭代 ' + res.fit.iters + ' 次，判据 ' + res.fit.reason]
    ]) + '<div class="tags" style="padding:8px 10px">' + convergenceTags(res.fit) + '</div>';
    renderPreview(pfx, data, res);
    drawM2Charts(res, data, Q);
    setBadge(pfx, '已计算', 'ok'); setStatus('计算完成 · Q=' + Q, 'ok');
  }

  function drawM2Charts(res, data, Q) {
    var riMin = Math.min.apply(null, data.rows.map(function (r) { return r.ri; }));
    var riMax = Math.max.apply(null, data.rows.map(function (r) { return r.ri; }));
    var xlo = Math.min(0.8, riMin - 0.05), xhi = Math.max(1.22, riMax + 0.05);
    var curve = [], n = 260;
    for (var i = 0; i <= n; i++) {
      var x = xlo + (xhi - xlo) * i / n;
      curve.push({ x: x, y: res.pred.length ? ZR.makeModelC1(res.indiVar).eval(x, res.fit.p) : NaN });
    }
    drawMainChart($('m2_chart'), {
      points: data.rows.map(function (r) { return { x: r.ri, y: r.di, ey: r.s1, c: cssVar('--pt') }; }),
      curves: [{ pts: curve, c: cssVar('--curve') }],
      xRange: [xlo, xhi],
      boxes: ['D₀ = ' + fx(res.D0, 3) + ' ± ' + fx(res.dD0, 3),
        'r₀ = ' + fx(res.r0, 4) + ' ± ' + fx(res.dr0, 4) + ' Å',
        'E  = ' + fx(res.E_GPa, 1) + ' ± ' + fx(res.dE_GPa, 1) + ' GPa',
        'Q  = ' + Q],
      topleft: [fmtP(Number($('m2_P').value)) + ' GPa']
    });
    drawResidChart($('m2_resid'), data.rows.map(function (r, i) {
      return { x: r.ri, r: (r.di - res.pred[i]) / (res.sigmaMode.sigma[i] || 1), c: cssVar('--curve') };
    }), '加权残差 (D_obs − D_calc)/σ', [1, 2], '参考线 ±1σ / ±2σ');
  }

  /* ========================================================= ③ 温度计 */
  function detectThermoMaps(pfx) {
    var t = ST[pfx].table, s = ST[pfx].maps;
    fillSelect($(pfx + '_mapRi'), t, 'ri', false);
    if (!t.nCol) { s.samples = []; return; }
    var numeric = {};
    for (var i = 0; i < t.nCol; i++) {
      var nNum = 0;
      t.rows.forEach(function (r) { if (numCell(r[i]) !== null) nNum++; });
      numeric[i] = t.rows.length ? nNum / t.rows.length : 0;
    }
    if (!s.inited) {
      var pick = -1;
      if (t.header) {
        for (var c = 0; c < t.nCol; c++) if (isRadiusCol(t, c)) { pick = c; break; }
      }
      if (pick < 0) { for (var c2 = 0; c2 < t.nCol; c2++) if (numeric[c2] > 0.9 && isRadiusCol(t, c2)) { pick = c2; break; } }
      if (pick < 0) pick = 0;
      $(pfx + '_mapRi').value = String(pick);
      s.inited = true;
    }
    s.ri = Number($(pfx + '_mapRi').value);
    s.samples = [];
    for (var i2 = 0; i2 < t.nCol; i2++) {
      if (i2 === s.ri) continue;
      if (!(numeric[i2] > 0.5)) continue;
      s.samples.push(i2);
    }
    $(pfx + '_samples').textContent = s.samples.length
      ? s.samples.map(function (i3) { return colTitle(t, i3); }).join('、')
      : '（未识别到样品列）';
  }

  function extractThermo(pfx) {
    var t = ST[pfx].table, s = ST[pfx].maps, out = { radii: [], columns: {}, issues: [], headers: [] };
    if (!t.rows.length) { out.issues.push(['e', '没有解析到数据行。']); return out; }
    if (!s.samples.length) { out.issues.push(['e', '未识别到样品列（半径列之外至少需要一个数值列）。']); return out; }
    var rows = [];
    t.rows.forEach(function (r) {
      var ri = numCell(r[s.ri]);
      if (ri === null) return;
      rows.push({ ri: ri, r: r });
    });
    out.radii = rows.map(function (x) { return x.ri; });
    s.samples.forEach(function (ci) {
      var name = colTitle(t, ci), vals = [];
      rows.forEach(function (x) { var v = numCell(x.r[ci]); vals.push(v); });
      out.columns[name] = vals;
      out.headers.push(name);
    });
    if (rows.length < 3) out.issues.push(['e', '只有 ' + rows.length + ' 个半径数据点，反演温度至少需要 3 个。']);
    else if (rows.length < 6) out.issues.push(['w', '半径数据点较少（' + rows.length + '），温度误差可能不可靠。']);
    Object.keys(out.columns).forEach(function (k) {
      var v = out.columns[k], bad = 0;
      v.forEach(function (x) { if (x === null || !(x > 0)) bad++; });
      if (bad) out.issues.push(['e', '样品「' + k + '」有 ' + bad + ' 个 D 值缺失或 ≤ 0，无法反演。']);
    });
    out.rows = rows;
    return out;
  }

  function computeM3() {
    var pfx = 'm3', st = ST[pfx];
    refreshTable(pfx);
    detectThermoMaps(pfx);
    var data = extractThermo(pfx);
    var msgs = data.issues.slice();
    var fatal = msgs.some(function (m) { return m[0] === 'e'; });
    if (fatal) {
      setMsgs(pfx, msgs); renderPreviewThermo(pfx, data, null, null);
      $(pfx + '_report').textContent = '数据不足，无法反演温度。';
      setBadge(pfx, '数据不足', 'err'); setStatus('数据不足', 'err'); st.res = null; return;
    }
    var Q = Number($(pfx + '_Q').value), r0 = Number($(pfx + '_r0').value);
    var d0m = $(pfx + '_d0').value, absSigma = $(pfx + '_abs').value === 'abs1';
    var res;
    try {
      res = ZR.fitThermo({
        radii: data.radii, columns: data.columns, Q: Q, r0: r0,
        d0Model: d0m, absoluteSigma: absSigma
      });
    } catch (e) {
      msgs.push(['e', '反演失败：' + e.message]); setMsgs(pfx, msgs);
      setBadge(pfx, '反演失败', 'err'); setStatus('反演失败', 'err'); return;
    }
    res.samples.forEach(function (s) {
      if (s.fit.boundHit) msgs.push(['w', '样品「' + s.sample + '」的温度顶在边界上，结果不可用。']);
      if (!s.fit.optimalityVerified) msgs.push(['w', '样品「' + s.sample + '」未达最优，解可能不唯一。']);
    });
    setMsgs(pfx, msgs);
    st.res = res; st.data = data;
    // 温度计是无权重拟合（原脚本不给 σ），残差用对数域表示才有物理意义，
    // 因此这里报 RMS(log₁₀D) 与最大偏差，而不是容易被误读的 χ²/dof。
    var rows = res.samples.map(function (s) {
      var mx = 0;
      data.radii.forEach(function (_, k) {
        var ob = data.columns[s.sample][k], dc = s.pred[k];
        if (ob > 0 && dc > 0) mx = Math.max(mx, Math.abs(Math.log10(ob) - Math.log10(dc)));
      });
      return { s: s, maxLog: mx };
    });
    $(pfx + '_report').textContent = [
      '── REE 锆石–熔体温度计反演结果 ──────────────────',
      '模型   Q = ' + Q + '，r₀ = ' + r0 + ' Å，D₀(T) = ' + res.d0Label,
      '公式   D_i = exp(A/T + B)·exp[(k/T)·B(r_i,r₀)/(1.38+r₀)³]，k = −4πN_A·Q/R',
      '',
      padW('样品', 16) + padW('T (K)', 21) + padW('T (°C)', 21) + padW('RMS(log₁₀D)', 14) + '最大|Δlog₁₀D|',
      rows.map(function (r) {
        var s = r.s;
        return padW(s.sample, 16) + padW(fx(s.T_K, 2) + ' ± ' + fx(s.dT_K, 2), 21) +
          padW(fx(s.T_C, 2) + ' ± ' + fx(s.dT_K, 2), 21) + padW(fx(s.stats.rms_log, 4), 14) + fx(r.maxLog, 4);
      }).join('\n'),
      '',
      '数据   N = ' + data.radii.length + ' 个半径点，' + res.samples.length + ' 个样品',
      '误差   1σ 由协方差矩阵给出（' + (absSigma ? 'absolute_sigma=True' : '按 χ² 缩放') + '），仅反映数据点分散度，不是真实地质不确定度',
      '生成   ' + TOOL + ' v' + VER + '  ' + stamp()
    ].join('\n');
    $(pfx + '_stats').innerHTML = '<table class="data"><thead><tr><th>样品</th><th>T (K)</th><th>±1σ</th><th>T (°C)</th><th>±1σ</th><th>RMS(log₁₀D)</th><th>最大|Δlog₁₀D|</th><th>dof</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var s = r.s;
        return '<tr><td>' + esc(s.sample) + '</td><td>' + fx(s.T_K, 2) + '</td><td>' + fx(s.dT_K, 2) + '</td><td>' +
          fx(s.T_C, 2) + '</td><td>' + fx(s.dT_K, 2) + '</td><td>' + fx(s.stats.rms_log, 4) + '</td><td>' +
          fx(r.maxLog, 4) + '</td><td>' + s.fit.dof + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="hint" style="padding:8px 2px 0">温度计是无权重拟合（原脚本不提供 σ），所以不报 χ²/dof，' +
      '改报对数域残差 RMS 与最大偏差 —— 后者约等于「曲线偏离数据点几个 dex」。</p>';
    renderPreviewThermo(pfx, data, res, null);
    renderThermoSensitivity(data.radii, data.columns, Q, r0, d0m);
    drawM3Charts(res, data);
    setBadge(pfx, res.samples.length + ' 个样品', 'ok');
    setStatus('反演完成 · ' + res.samples.length + ' 个样品', 'ok');
  }
  function pad(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
  }
  /** 等宽字体下 CJK 占两列，按显示宽度补空格 */
  function dispW(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6);
      w += wide ? 2 : 1;
    }
    return w;
  }
  function padW(s, n) {
    s = String(s);
    var w = dispW(s);
    while (w < n) { s += ' '; w++; }
    return s;
  }
  function renderPreviewThermo(pfx, data, res, _x) {
    var box = $(pfx + '_stats');
    if (!data.radii || !data.radii.length) { box.innerHTML = '<p class="hint" style="padding:10px">暂无数据</p>'; return; }
    var h = '<table class="data"><thead><tr><th>#</th><th>ri (Å)</th>';
    data.headers.forEach(function (n) { h += '<th>' + esc(n) + '</th>'; });
    h += res ? '<th>最大 |Δlog₁₀D|</th>' : '';
    h += '</tr></thead><tbody>';
    data.radii.forEach(function (ri, i) {
      h += '<tr><td>' + (i + 1) + '</td><td>' + ri.toFixed(3) + '</td>';
      data.headers.forEach(function (n) {
        var v = data.columns[n][i];
        h += '<td>' + (v == null ? '—' : (v < 0.01 ? v.toExponential(3) : v.toPrecision(5))) + '</td>';
      });
      if (res) {
        var dmax = 0;
        res.samples.forEach(function (s) {
          var dc = s.pred[i], ob = data.columns[s.sample][i];
          if (ob > 0 && dc > 0) dmax = Math.max(dmax, Math.abs(Math.log10(dc) - Math.log10(ob)));
        });
        h += '<td>' + dmax.toFixed(3) + '</td>';
      }
      h += '</tr>';
    });
    box.innerHTML = h + '</tbody></table>';
  }

  function drawM3Charts(res, data) {
    var riMin = Math.min.apply(null, data.radii), riMax = Math.max.apply(null, data.radii);
    var xlo = Math.min(0.8, riMin - 0.04), xhi = Math.max(1.22, riMax + 0.04);
    var pts = [], curves = [], legend = [];
    res.samples.forEach(function (s, i) {
      var c = PALETTE[i % PALETTE.length];
      data.radii.forEach(function (r, k) { if (data.columns[s.sample][k] > 0) pts.push({ x: r, y: data.columns[s.sample][k], c: c }); });
      var arr = [], n = 200;
      for (var t = 0; t <= n; t++) {
        var x = xlo + (xhi - xlo) * t / n;
        arr.push({ x: x, y: ZR.forwardThermo([x], s.T_K, res.r0, res.Q, res.d0Model)[0] });
      }
      curves.push({ pts: arr, c: c });
      legend.push({ c: c, label: s.sample + '  T = ' + fx(s.T_C, 1) + ' °C' });
    });
    drawMainChart($('m3_chart'), {
      points: pts, curves: curves, xRange: [xlo, xhi], legend: legend,
      boxes: ['模型 Q = ' + res.Q + '，r₀ = ' + res.r0 + ' Å',
        'D₀(T) = ' + res.d0Label]
    });
    var rp = [];
    res.samples.forEach(function (s, i) {
      var c = PALETTE[i % PALETTE.length];
      data.radii.forEach(function (r, k) {
        var ob = data.columns[s.sample][k], dc = s.pred[k];
        if (ob > 0 && dc > 0) rp.push({ x: r, r: Math.log10(ob) - Math.log10(dc), c: c });
      });
    });
    drawResidChart($('m3_resid'), rp, 'Δlog₁₀D = log₁₀D_obs − log₁₀D_calc', [0.1, 0.2], '参考线 ±0.1 / ±0.2 dex');
  }

  /* ============================================================== 导出 */
  function exportCSV(pfx) {
    var st = ST[pfx], res = st.res;
    if (!res) return;
    var rows = [];
    if (pfx === 'm3') {
      rows.push(['样品', 'T (K)', '± 1σ (K)', 'T (°C)', '± 1σ (°C)', 'RMS(log10D)', '最大|Δlog10D|', 'dof']);
      res.samples.forEach(function (s) {
        var mxr = 0;
        st.data.radii.forEach(function (_, k) {
          var ob = st.data.columns[s.sample][k], dc = s.pred[k];
          if (ob > 0 && dc > 0) mxr = Math.max(mxr, Math.abs(Math.log10(ob) - Math.log10(dc)));
        });
        rows.push([s.sample, fx(s.T_K, 3), fx(s.dT_K, 3), fx(s.T_C, 3), fx(s.dT_K, 3), fx(s.stats.rms_log, 5), fx(mxr, 5), s.fit.dof]);
      });
      rows.push([]);
      rows.push(['模型参数', 'Q=' + res.Q, 'r0=' + res.r0, 'D0(T)=' + res.d0Label]);
      rows.push([]);
      rows.push(['#', 'ri (Å)'].concat(st.data.headers.map(function (n) { return n + ' 实测'; })));
      st.data.radii.forEach(function (r, i) {
        rows.push([i + 1, r.toFixed(4)].concat(st.data.headers.map(function (n) { return fx(st.data.columns[n][i], 6); })));
      });
      rows.push([]);
      rows.push(['#', 'ri (Å)'].concat(res.samples.map(function (s) { return s.sample + ' 计算'; })));
      st.data.radii.forEach(function (r, i) {
        rows.push([i + 1, r.toFixed(4)].concat(res.samples.map(function (s) { return fx(s.pred[i], 6); })));
      });
      download('REE温度计结果_' + fileStamp() + '.csv', toCSV(rows), 'text/csv;charset=utf-8');
      return;
    }
    var cond = pfx === 'm1'
      ? [['T (°C)', fx($('m1_T').value, 2)], ['P (GPa)', fmtP(Number($('m1_P').value))], ['误差含义', errLabel('m1')]]
      : [['T (°C)', fx($('m2_T').value, 2)], ['P (GPa)', fmtP(Number($('m2_P').value))], ['Q', fx($('m2_Q').value, 0)], ['误差含义', errLabel('m2')]];
    rows.push(['参数', '估计值', '± 1σ', '单位']);
    if (pfx === 'm1') {
      rows.push(['D0', fx(res.D0, 4), fx(res.dD0, 4), '']);
      rows.push(['r0', fx(res.r0, 5), fx(res.dr0, 5), 'Å']);
      rows.push(['E', fx(res.E_GPa, 2), fx(res.dE_GPa, 2), 'GPa']);
      rows.push(['E_fit（内部形状参数）', fx(res.Efit, 6), fx(res.dEfit, 6), '']);
    } else {
      rows.push(['D0', fx(res.D0, 4), fx(res.dD0, 4), '']);
      rows.push(['r0', fx(res.r0, 5), fx(res.dr0, 5), 'Å']);
      rows.push(['E（由 Q 推出）', fx(res.E_GPa, 2), fx(res.dE_GPa, 2), 'GPa']);
    }
    rows.push([]);
    rows.push(['统计量', '数值']);
    rows.push(['N', st.data.rows.length]);
    rows.push(['dof', res.fit.dof]);
    rows.push(['加权 χ²', fx(res.fit.ssr, 6)]);
    rows.push(['χ²/dof', fx(res.fit.chi2red, 6)]);
    rows.push(['RMSWD', fx(Math.sqrt(res.fit.ssr / st.data.rows.length), 6)]);
    rows.push(['R²(log10D)', fx(res.stats.r2_log, 6)]);
    rows.push(['RMS(log10D)', fx(res.stats.rms_log, 6)]);
    rows.push([]);
    cond.forEach(function (c) { rows.push(c); });
    rows.push([]);
    rows.push(['#', '元素', 'ri (Å)', 'D 实测', '1σ', 'D 计算', '加权残差', 'log10D 残差']);
    st.data.rows.forEach(function (r, i) {
      rows.push([i + 1, r.el, r.ri.toFixed(4), fx(r.di, 8), fx(r.s1, 8), fx(res.pred[i], 8),
        fx((r.di - res.pred[i]) / (res.sigmaMode.sigma[i] || 1), 4),
        fx(Math.log10(r.di) - Math.log10(res.pred[i]), 4)]);
    });
    download((pfx === 'm1' ? '自由拟合结果_' : '约束拟合结果_') + fileStamp() + '.csv', toCSV(rows), 'text/csv;charset=utf-8');
  }
  function fileStamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }
  function exportJSON(pfx) {
    var st = ST[pfx], res = st.res;
    if (!res) return;
    var o = {
      tool: TOOL, version: VER, generated: stamp(), module: res.module,
      input: pfx === 'm3'
        ? { radii: st.data.radii, columns: st.data.columns, Q: res.Q, r0: res.r0, d0Model: res.d0Model }
        : {
          T_C: Number($(pfx + '_T').value), P_GPa: Number($(pfx + '_P').value),
          Q: pfx === 'm2' ? Number($(pfx + '_Q').value) : undefined,
          errMode: $(pfx + '_errmode').value,
          absoluteSigma: $(pfx + '_abs').value === 'abs1',
          data: st.data.rows
        },
      result: {}, solver: {
        algorithm: 'bounded Levenberg-Marquardt + Gauss-Newton polish (analytic Jacobian)',
        convergence: res.fit ? { iters: res.fit.iters, reason: res.fit.reason, optimalityVerified: res.fit.optimalityVerified, maxSSRimprove: res.fit.maxImprove, windowRel: res.fit.optWindow } : undefined
      },
      provenance: '算法移植自 Streicher et al. (2023, GCA 346, 54-64) 配套代码'
    };
    if (pfx === 'm3') {
      o.result.samples = res.samples.map(function (s) {
        return { sample: s.sample, T_K: s.T_K, dT_K: s.dT_K, T_C: s.T_C, chi2red: s.fit.chi2red, rms_log: s.stats.rms_log, dof: s.fit.dof };
      });
    } else {
      o.result = {
        D0: res.D0, dD0: res.dD0, r0: res.r0, dr0: res.dr0, E_GPa: res.E_GPa, dE_GPa: res.dE_GPa,
        chi2: res.fit.ssr, dof: res.fit.dof, chi2red: res.fit.chi2red,
        r2_log: res.stats.r2_log, rms_log: res.stats.rms_log
      };
      if (pfx === 'm1') { o.result.E_fit = res.Efit; o.result.E_conv_factor = res.conv; }
      o.points = st.data.rows.map(function (r, i) {
        return { element: r.el, ri: r.ri, D_obs: r.di, sigma: r.s1, D_calc: res.pred[i] };
      });
    }
    download((pfx === 'm1' ? '自由拟合' : (pfx === 'm2' ? '约束拟合' : '温度计')) + '_' + fileStamp() + '.json', JSON.stringify(o, null, 2), 'application/json');
  }
  function copyReport(pfx) {
    var txt = $(pfx + '_report').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { setStatus('已复制结果到剪贴板', 'ok'); },
        function () { fallbackCopy(txt); });
    } else fallbackCopy(txt);
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); setStatus('已复制结果', 'ok'); } catch (e) { setStatus('复制失败，请手工选择文本', 'warn'); }
    ta.remove();
  }
  function exportPNG(pfx) {
    var main = $(pfx + '_chart'), resid = $(pfx + '_resid');
    if (!main.width) return;
    var pad = 16;
    var W = Math.max(main.width, resid.width) + pad * 2;
    var H = main.height + resid.height + pad * 3;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    ctx.fillStyle = cssVar('--panel'); ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = cssVar('--text'); ctx.font = '600 15px -apple-system, "Segoe UI", "Microsoft YaHei"';
    ctx.fillText(TOOL + ' · ' + (pfx === 'm1' ? '自由晶格应变拟合' : pfx === 'm2' ? '约束拟合（锆石）' : 'REE 温度计') + ' · ' + stamp(), pad, pad + 6);
    ctx.drawImage(main, pad, pad + 18);
    ctx.drawImage(resid, pad, pad + 18 + main.height + pad);
    c.toBlob(function (b) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = (pfx === 'm3' ? '温度计图表_' : '拟合图表_') + fileStamp() + '.png';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
  }

  /* ============================================================ 事件绑定 */
  var timers = {};
  function debounce(key, fn, ms) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(fn, ms || 220);
  }
  function bindPane(pfx, compute) {
    var ta = textareaOf(pfx);
    // 内容变化 -> 重新自动识别列映射；手工改下拉框则保留用户选择
    ta.addEventListener('input', function () { ST[pfx].maps.inited = false; debounce(pfx, compute); });
    ['mapEl', 'mapRi', 'mapDi', 'mapS'].forEach(function (k) {
      var el = $(pfx + '_' + k);
      if (el) el.addEventListener('change', function () { ST[pfx].maps.inited = true; compute(); });
    });
    ['T', 'P', 'Q', 'r0', 'errmode', 'abs', 'd0'].forEach(function (k) {
      var el = $(pfx + '_' + k);
      if (el) el.addEventListener('change', compute);
    });
    var calc = $(pfx + '_calc');
    if (calc) calc.addEventListener('click', compute);
    var clr = $(pfx + '_clear');
    if (clr) clr.addEventListener('click', function () { ta.value = ''; ST[pfx].maps.inited = false; compute(); });
    var dsel = $(pfx + '_demo');
    if (dsel) dsel.addEventListener('change', function () { applyDemo(pfx, dsel.value); });
    var fr = $(pfx + '_fillri');
    if (fr) fr.addEventListener('click', function () { fillRadii(pfx, compute); });
    var rt = $(pfx + '_readTP');
    if (rt) rt.addEventListener('click', function () { readTP(pfx, compute); });
    var cp = $(pfx + '_copy'); if (cp) cp.addEventListener('click', function () { copyReport(pfx); });
    var cs = $(pfx + '_csv'); if (cs) cs.addEventListener('click', function () { exportCSV(pfx); });
    var js = $(pfx + '_json'); if (js) js.addEventListener('click', function () { exportJSON(pfx); });
    var pn = $(pfx + '_png'); if (pn) pn.addEventListener('click', function () { exportPNG(pfx); });
    var pr = $(pfx + '_print'); if (pr) pr.addEventListener('click', function () { window.print(); });
    bindDrop(pfx, compute);
  }
  function bindDrop(pfx, compute) {
    var zone = $(pfx + '_drop'), input = $(pfx + '_file');
    if (!zone || !input) return;
    zone.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { if (input.files[0]) loadFile(pfx, input.files[0], compute); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('hot'); });
    });
    zone.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(pfx, f, compute);
    });
  }
  /* ============================================== 示例数据集（含真值） */
  var DEMO_DEFS = [
    { key: 'bb', mods: ['m1', 'm2'], label: 'Burnham & Berry (2012) 实验 · 温度已知',
      note: '实验数据（13 个元素，1295 °C，≈1 atm）。温度独立已知 ⇒ 可用模块③反向检验：反演应回到 ≈1568 K。' },
    { key: 'syn_a', mods: ['m1', 'm2'], label: '合成 A · 中温 / 中等 E（真值已知）' },
    { key: 'syn_b', mods: ['m1', 'm2'], label: '合成 B · 低温 / 高 E（真值已知）' },
    { key: 'syn_c', mods: ['m1', 'm2'], label: '合成 C · 高温 / 低 E（真值已知）' },
    { key: 'whitehouse', mods: ['m3'], label: 'Whitehouse & Kamber (2002) 自然样品（模型失效案例）' },
    { key: 'thermo_syn', mods: ['m3'], label: '合成 · 三个已知温度样品（真值已知）' }
  ];
  function demoByKey(k) {
    for (var i = 0; i < DEMO_DEFS.length; i++) if (DEMO_DEFS[i].key === k) return DEMO_DEFS[i];
    return null;
  }
  function fillDemoSelect(pfx) {
    var sel = $(pfx + '_demo');
    if (!sel) return;
    sel.innerHTML = DEMO_DEFS.filter(function (d) { return d.mods.indexOf(pfx) >= 0; })
      .map(function (d) { return '<option value="' + d.key + '">' + esc(d.label) + '</option>'; }).join('');
  }
  function applyDemo(pfx, key) {
    var sel = $(pfx + '_demo'), ta = textareaOf(pfx), note = '';
    var def = demoByKey(key);
    if (sel && sel.value !== key) sel.value = key;
    if (key === 'bb') {
      ta.value = 'Element\tri\tDi\t1s\tT [C]\tP [GPa]\n' + DEMO_LATTICE.rows.map(function (r) {
        return [r.el, r.ri.toFixed(3), r.di, r.s1, DEMO_LATTICE.T_C, DEMO_LATTICE.P_GPa].join('\t');
      }).join('\n');
      if ($(pfx + '_T')) $(pfx + '_T').value = DEMO_LATTICE.T_C;
      if ($(pfx + '_P')) $(pfx + '_P').value = DEMO_LATTICE.P_GPa;
      note = def ? def.note : '';
    } else if (key === 'whitehouse') {
      var cols = Object.keys(DEMO_PARTITION.columns);
      ta.value = 'Radii\t' + cols.join('\t') + '\n' + DEMO_PARTITION.radii.map(function (r, i) {
        return [r.toFixed(3)].concat(cols.map(function (c) { return DEMO_PARTITION.columns[c][i]; })).join('\t');
      }).join('\n');
      note = WH_SOURCE.note;
    } else if (key === 'thermo_syn') {
      var sy = DEMO_THERMO_SYN, cs = Object.keys(sy.columns);
      ta.value = 'Radii\t' + cs.join('\t') + '\n' + sy.radii.map(function (r, i) {
        return [r.toFixed(3)].concat(cs.map(function (c) { return sy.columns[c][i].toPrecision(8); })).join('\t');
      }).join('\n');
      if ($(pfx + '_Q')) $(pfx + '_Q').value = String(sy.Q);
      if ($(pfx + '_r0')) $(pfx + '_r0').value = String(sy.r0);
      if ($(pfx + '_d0')) $(pfx + '_d0').value = sy.d0Model;
      var tv = Object.keys(sy.truth).map(function (k) {
        return k + ' = ' + (sy.truth[k] - 273.15).toFixed(0) + ' °C';
      }).join('，');
      note = sy.note + '　真值：' + tv + '　→ 反演结果应该回到这些温度。';
    } else {
      var i, sp = null;
      for (i = 0; i < DEMO_SERIES.length; i++) if (DEMO_SERIES[i].key === key) sp = DEMO_SERIES[i];
      if (!sp) return;
      ta.value = 'Element\tri\tDi\t1s\n' + sp.rows.map(function (r) {
        return [r.el, r.ri.toFixed(3), r.di.toPrecision(8), r.s1.toPrecision(6)].join('\t');
      }).join('\n');
      if ($(pfx + '_T')) $(pfx + '_T').value = sp.T_C;
      note = sp.note + '　→ 拟合结果应接近这组真值。';
    }
    var nb = $(pfx + '_demoNote');
    if (nb) nb.textContent = note || '—';
    ST[pfx].maps.inited = false;
    ({ m1: computeM1, m2: computeM2, m3: computeM3 }[pfx])();
    setStatus('已载入 ' + (def ? def.label : key), 'ok');
  }
  function loadFile(pfx, file, compute) {
    var name = file.name.toLowerCase();
    var cb = function (text) {
      textareaOf(pfx).value = text;
      ST[pfx].maps.inited = false;
      compute();
      setStatus('已读取 ' + file.name + '（' + text.split('\n').filter(function (l) { return l.trim(); }).length + ' 行）', 'ok');
    };
    var ta = textareaOf(pfx), ul = $(pfx + '_msgs');
    if (/\.(xlsx|xlsm)$/.test(name)) {
      file.arrayBuffer().then(function (buf) {
        return xlsxToTSV(new Uint8Array(buf));
      }).then(cb).catch(function (e) {
        ul.innerHTML = '<li class="e">' + esc('xlsx 读取失败：' + e.message) + '</li>';
        ul.insertAdjacentHTML('beforeend', '<li class="i">可在 Excel 中"另存为 CSV UTF-8"后重新拖入。</li>');
      });
    } else if (/\.xls$/.test(name)) {
      ul.innerHTML = '<li class="e">旧版 .xls 不支持，请在 Excel 中另存为 .xlsx 或 .csv。</li>';
    } else {
      var rd = new FileReader();
      rd.onload = function () { cb(String(rd.result).replace(/^\ufeff/, '')); };
      rd.readAsText(file, 'utf-8');
    }
  }
  function fillRadii(pfx, compute) {
    var t = ST[pfx].table, s = ST[pfx].maps;
    if (!t.rows.length) return;
    var map = R_SHANNON_VIII.radii;
    if (pfx === 'm3') {
      // 表头是元素名：把半径列填成 Shannon 值
      var head = t.colNames[s.ri];
      var v = map[String(head).replace(/[0-9+\s]/g, '')];
      if (v == null) { setStatus('无法从表头「' + head + '」识别元素', 'warn'); return; }
      var lines = textareaOf(pfx).value.split('\n');
      // 简单替换：把「表头行」改成 半径 值写进数据（不改名，只提示）
      setStatus('表头「' + head + '」对应 Shannon VIII 半径 ' + v + ' Å —— 请直接把该列数值改为 ' + v, 'warn');
      return;
    }
    if (s.el < 0) { setStatus('需要先指定元素列', 'warn'); return; }
    var lines2 = textareaOf(pfx).value.replace(/\r\n?/g, '\n').split('\n');
    var delim = (lines2[0].match(/\t/g) || []).length ? '\t' : ((lines2[0].match(/,/g) || []).length ? ',' : null);
    var hasHeader = t.header !== null;
    var start = hasHeader ? 1 : 0, filled = 0, unknown = [];
    var out = [];
    var bodyIdx = 0;
    for (var i = 0; i < lines2.length; i++) {
      if (i < start || lines2[i].trim() === '') { out.push(lines2[i]); continue; }
      var cells = delim === null ? lines2[i].trim().split(/\s+/) : splitCSV(lines2[i], delim);
      var el = String(cells[s.el] || '').trim().replace(/[0-9+\s]/g, '');
      var key = el.charAt(0).toUpperCase() + el.slice(1).toLowerCase();
      if (map[key] != null) {
        var need = cells.length;
        while (cells.length <= s.ri) cells.push('');
        cells[s.ri] = String(map[key]);
        filled++;
      } else if (el) unknown.push(el);
      out.push(delim === null ? cells.join('\t') : cells.join(delim));
      bodyIdx++;
    }
    textareaOf(pfx).value = out.join('\n');
    ST[pfx].maps.inited = false;
    compute();
    setStatus('已按 Shannon VIII 半径补全 ' + filled + ' 行' + (unknown.length ? '（未识别：' + unknown.join('/') + '）' : ''), unknown.length ? 'warn' : 'ok');
  }
  function readTP(pfx, compute) {
    var t = ST[pfx].table, s = ST[pfx].maps;
    var got = [];
    if (s.tCol >= 0) {
      for (var i = 0; i < t.rows.length; i++) {
        var v = numCell(t.rows[i][s.tCol]);
        if (v !== null) { $(pfx + '_T').value = v; got.push('T=' + v + ' °C'); break; }
      }
    }
    if (s.pCol >= 0 && $(pfx + '_P')) {
      for (var k = 0; k < t.rows.length; k++) {
        var v2 = numCell(t.rows[k][s.pCol]);
        if (v2 !== null) { $(pfx + '_P').value = v2; got.push('P=' + v2 + ' GPa'); break; }
      }
    }
    setStatus(got.length ? '已从表格读取 ' + got.join('，') : '表格里未找到 T [C] / P [GPa] 列', got.length ? 'ok' : 'warn');
    compute();
  }

  /* ============================================================== 自检 */
  var SELFTEST_REFS = {
    free: { D0: 3.468870, r0: 0.956220, E: 614.4841 },
    con6489: { D0: 3.155339, r0: 0.947240, E: 514.8190 },
    con7827: { D0: 3.467523, r0: 0.956179, E: 613.8711 },
    thermo: { '6489_0.93_streicher2023': { 'D(Sample 1)': 966.0260, 'D(Sample 2)': 951.4242 } }
  };
  function runSelfTest() {
    var out = [], pass = 0, fail = 0;
    function T(tag, got, want, tol) {
      var rel = Math.abs(got - want) / Math.max(Math.abs(want), 1e-300);
      if (rel <= tol) { pass++; out.push('  ✓ ' + tag + '   ' + got + '  (rel ' + rel.toExponential(1) + ')'); }
      else { fail++; out.push('  ✗ ' + tag + '   got=' + got + ' want=' + want + ' rel=' + rel.toExponential(2)); }
    }
    try {
      var ri = DEMO_LATTICE.rows.map(function (r) { return r.ri; });
      var di = DEMO_LATTICE.rows.map(function (r) { return r.di; });
      var s1 = DEMO_LATTICE.rows.map(function (r) { return r.s1; });
      var f1 = ZR.fitFree({ ri: ri, di: di, s1: s1, T_C: DEMO_LATTICE.T_C, errMode: 'abs', absoluteSigma: true });
      T('自由拟合 D0', f1.D0, SELFTEST_REFS.free.D0, 1e-6);
      T('自由拟合 r0', f1.r0, SELFTEST_REFS.free.r0, 1e-6);
      T('自由拟合 E(GPa)', f1.E_GPa, SELFTEST_REFS.free.E, 1e-6);
      out.push('    最优性验证: ' + (f1.fit.optimalityVerified ? '通过' : '未通过') + '，最大 SSR 改进 ' + f1.fit.maxImprove.toExponential(1));
      f1.fit.optimalityVerified ? pass++ : fail++;

      var f2 = ZR.fitConstrained({ ri: ri, di: di, s1: s1, T_C: DEMO_LATTICE.T_C, Q: 6489, errMode: 'abs', absoluteSigma: true });
      T('约束拟合 Q₁ D0', f2.D0, SELFTEST_REFS.con6489.D0, 1e-6);
      T('约束拟合 Q₁ r0', f2.r0, SELFTEST_REFS.con6489.r0, 1e-6);
      T('约束拟合 Q₁ E', f2.E_GPa, SELFTEST_REFS.con6489.E, 1e-6);
      var f2b = ZR.fitConstrained({ ri: ri, di: di, s1: s1, T_C: DEMO_LATTICE.T_C, Q: 7827, errMode: 'abs', absoluteSigma: true });
      T('约束拟合 Q₂ E', f2b.E_GPa, SELFTEST_REFS.con7827.E, 1e-6);

      var f3 = ZR.fitThermo({
        radii: DEMO_PARTITION.radii, columns: DEMO_PARTITION.columns, Q: 6489, r0: 0.93,
        d0Model: 'streicher2023', absoluteSigma: false
      });
      var ref3 = SELFTEST_REFS.thermo['6489_0.93_streicher2023'];
      f3.samples.forEach(function (s) { T('温度计 ' + s.sample, s.T_K, ref3[s.sample], 1e-6); });

      // 正演 -> 反演闭合
      var back = ZR.fitThermo({
        radii: DEMO_PARTITION.radii, columns: { closed: ZR.forwardThermo(DEMO_PARTITION.radii, 1500, 0.93, 6489, 'streicher2023') },
        Q: 6489, r0: 0.93, d0Model: 'streicher2023', absoluteSigma: false
      });
      T('温度计闭合 1500 K', back.samples[0].T_K, 1500, 1e-8);

      // 三个面板端到端：载入示例 -> 自动计算
      fillDemoSelect('m1'); fillDemoSelect('m2'); fillDemoSelect('m3');
      applyDemo('m1', 'bb');
      applyDemo('m2', 'bb');
      applyDemo('m3', 'whitehouse');

      // 每个标签页可切换
      var tabs = document.querySelectorAll('nav.tabs button');
      var okTabs = 0;
      Array.prototype.forEach.call(tabs, function (b) {
        try { b.click(); okTabs++; } catch (e) { }
      });
      (okTabs === tabs.length) ? pass++ : fail++;
      out.push('  ' + (okTabs === tabs.length ? '✓' : '✗') + ' 标签页切换 ' + okTabs + '/' + tabs.length);
      // 回到「① 自由拟合」：图表在可见状态下才会按真实宽度重绘
      Array.prototype.forEach.call(tabs, function (b) {
        if (b.getAttribute('data-tab') === 'm1') b.click();
      });

      var painted = 0, asked = 0, sizes = [];
      ['m1_chart', 'm1_resid', 'm2_chart', 'm2_resid', 'm3_chart', 'm3_resid'].forEach(function (id) {
        asked++;
        var c = $(id);
        if (!c || !c.width) return;
        var r = c.getBoundingClientRect();
        var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        var nz = 0;
        for (var i = 3; i < d.length; i += 4 * 97) if (d[i] !== 0) nz++;
        if (nz > 20) { painted++; sizes.push(id + ' ' + Math.round(r.width) + '×' + Math.round(r.height) + ' css/' + c.width + '×' + c.height + ' px'); }
        else sizes.push(id + ' 空白');
      });
      (painted === asked) ? pass++ : fail++;
      out.push('  ' + (painted === asked ? '✓' : '✗') + ' 图表已绘制 ' + painted + '/' + asked + '  [' + sizes.join('; ') + ']');

      var rep1 = $('m1_report').textContent, rep3 = $('m3_report').textContent;
      var okRep = rep1.indexOf('D₀') >= 0 && rep1.indexOf('E') >= 0 && rep3.indexOf('T (K)') >= 0;
      okRep ? pass++ : fail++;
      out.push('  ' + (okRep ? '✓' : '✗') + ' 结果文本已生成');

      // 数值表与图表一致性：拟合值 = 模型重算值
      var st = ST.m1.res, mx = 0;
      st.rows.forEach(function (r, i) { mx = Math.max(mx, Math.abs(ZR.MODEL_FREE.eval(r.ri, st.fit.p) - st.pred[i])); });
      (mx === 0) ? pass++ : fail++;
      out.push('  ' + (mx === 0 ? '✓' : '✗') + ' 图表与结果表数值一致（最大差 ' + mx + '）');
    } catch (e) {
      fail++;
      out.push('  ✗ 自检抛异常: ' + (e && e.message));
    }
    var head = (fail === 0 ? 'SELFTEST PASS ' : 'SELFTEST FAIL ') + pass + '/' + (pass + fail);
    document.title = head;
    var div = $('selftestOut');
    if (div) div.innerHTML = '<b>' + head + '</b>\n' + esc(out.join('\n'));
    setStatus(head, fail === 0 ? 'ok' : 'err');
    return { pass: pass, fail: fail, log: out.join('\n') };
  }


  /* ============================================ 验证结果（validate.py 产出） */
  function copyText(txt, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { setStatus(okMsg, 'ok'); },
        function () { fallbackCopy(txt); });
    } else fallbackCopy(txt);
  }
  function vtTitle(t) { return '<div class="vt">' + t + '</div>'; }

  function renderValidation() {
    var box = $('valBox');
    if (!box) return;
    if (typeof VALIDATION === 'undefined' || !VALIDATION.reverse) {
      box.innerHTML = '<p class="hint">验证数据未载入。请在 webgui 目录依次运行 <code>python validate.py</code>、' +
        '<code>python make_demos.py</code>，再重新构建。</p>';
      return;
    }
    var V = VALIDATION, h = [];
    if (V.meta && V.meta.note) h.push('<p class="hint">' + esc(V.meta.note) + '</p>');

    // ---- A1 反向检验 ----
    var bb = V.reverse.burnham_berry_2012;
    h.push(vtTitle('A1 · 反向检验：Burnham &amp; Berry (2012) 实验，温度 ' + fx(bb.T_known_C, 0) +
      ' °C = ' + fx(bb.T_known_K, 2) + ' K（独立已知）'));
    h.push('<table class="data"><thead><tr><th>Q</th><th>r₀ (Å)</th><th>D₀(T) 关系</th><th>反演 T (K)</th>' +
      '<th>±1σ</th><th>与实验温度之差</th></tr></thead><tbody>');
    Object.keys(bb.thermo_log).forEach(function (k) {
      var v = bb.thermo_log[k], p = k.split('_');
      h.push('<tr' + (Math.abs(v.bias_K) < 30 ? ' class="g"' : '') + '><td>' + p[0] + '</td><td>' + p[1] +
        '</td><td>' + p[2] + '</td><td>' + fx(v.T_K, 1) + '</td><td>' + fx(v.dT_K, 1) + '</td><td>' +
        (v.bias_K > 0 ? '+' : '') + fx(v.bias_K, 1) + ' K</td></tr>');
    });
    h.push('</tbody></table>');
    var dk = bb.thermo_log['6489_0.93_streicher2023'], sp = V.sensitivity.thermo_model_spread;
    if (dk) {
      h.push('<div class="note">默认参数（Q₁ + r₀ = 0.93 Å + Streicher 的 D₀(T)）反演得到 <b>' + fx(dk.T_K, 1) +
        ' K</b>，与实验温度相差 <b>' + (dk.bias_K > 0 ? '+' : '') + fx(dk.bias_K, 1) + ' K</b>。' +
        '但 8 种参数组合整体跨度 <b>' + fx(sp.span_K, 0) + ' K</b>（' + fx(sp.min_bias_K, 0) + ' ～ +' +
        fx(sp.max_bias_K, 0) + ' K）—— <b>误差预算由模型常数的选择主导，不是数据点</b>。' +
        '把 Rubatto 的 D₀(T) 关系用在这种干体系高温实验上会偏 −150～−220 K，所以 D₀(T) 关系必须与体系匹配。</div>');
    }
    var fr = bb.free;
    h.push('<p class="hint">同一份数据的晶格应变拟合：D₀ = ' + fx(fr.D0, 3) + ' ± ' + fx(fr.dD0, 3) +
      '，r₀ = ' + fx(fr.r0, 4) + ' ± ' + fx(fr.dr0, 4) + ' Å，E = ' + fx(fr.E_GPa, 1) + ' ± ' + fx(fr.dE_GPa, 1) +
      ' GPa；RMS(log₁₀D) = ' + fx(fr.rms_log, 3) + ' dex（≈ ' + fx(Math.pow(10, fr.rms_log), 2) + ' 倍），' +
      'corr(r₀,E) = ' + fx(fr.corr_r0_E, 2) + '。</p>');

    // ---- A2 反面案例 ----
    h.push(vtTitle('A2 · 反面案例：Whitehouse &amp; Kamber (2002) 自然样品（该文已知模型失效）'));
    h.push('<table class="data"><thead><tr><th>样品</th><th>D₀</th><th>r₀ (Å)</th><th>E (GPa)</th>' +
      '<th>RMS(log₁₀D)</th><th>最大偏差</th><th>La–Pr 最大偏差</th></tr></thead><tbody>');
    Object.keys(V.natural.samples).forEach(function (k) {
      var r = V.natural.samples[k];
      h.push('<tr class="bl"><td>' + esc(k) + '</td><td>' + fx(r.D0, 0) + (r.D0 > 1999 ? ' ⚠顶界' : '') +
        '</td><td>' + fx(r.r0, 4) + '</td><td>' + fx(r.E_GPa, 0) + '</td><td>' + fx(r.rms_log, 2) +
        '</td><td>' + fx(r.max_log, 2) + ' dex（' + fx(Math.pow(10, r.max_log), 0) + ' 倍）</td><td>' +
        fx(r.lree_max_log, 2) + ' dex</td></tr>');
    });
    h.push('</tbody></table>');
    h.push('<div class="note warn">这两件样品上，自由拟合的 D₀ 直接顶到搜索上界 2000、r₀ 掉到 0.83–0.85 Å' +
      '（锆石位点半径本应 0.93–0.96 Å）—— <b>模型在这份数据上根本不成立</b>。' +
      '工具的应对是：给出「触及参数边界」警告、把 LREE 高达 1.4 dex 的残差画在残差图上，' +
      '而不是输出一个看似漂亮的拟合。这正是这套界面最该看的地方。</div>');

    // ---- B 蒙特卡洛 ----
    h.push(vtTitle('B · 蒙特卡洛误差标定（合成数据、真值已知，每组 400 次重复）'));
    h.push('<table class="data"><thead><tr><th>数据集</th><th>噪声</th><th>参数</th><th>相对偏差</th>' +
      '<th>报出的 1σ</th><th>1σ 覆盖率</th><th>2σ 覆盖率</th></tr></thead><tbody>');
    Object.keys(V.montecarlo.free).forEach(function (k) {
      var g = V.montecarlo.free[k];
      ['D0', 'r0', 'E_GPa'].forEach(function (p) {
        var r = g.res[p];
        h.push('<tr><td>' + esc(g.label) + '</td><td>' + fx(g.noise * 100, 0) + '%</td><td>' + p +
          '</td><td>' + (r.bias_pct > 0 ? '+' : '') + fx(r.bias_pct, 1) + '%</td><td>' + sig(r.mean_err, 3) +
          '</td><td>' + fx(r.cov1, 2) + '</td><td>' + fx(r.cov2, 2) + '</td></tr>');
      });
    });
    h.push('</tbody></table>');
    h.push('<p class="hint">覆盖率的目标值是 1σ → 0.68、2σ → 0.95。可以看到报出的误差基本诚实：' +
      '偏差都在 ±0.5% 以内，1σ 覆盖率 0.65–0.73，2σ 覆盖率 0.94–0.97。</p>');

    h.push('<table class="data"><thead><tr><th>温度计真值 T</th><th>噪声 5%：偏差 / RMSE / 1σ 覆盖率</th>' +
      '<th>10%</th><th>20%</th></tr></thead><tbody>');
    var seen = {};
    Object.keys(V.montecarlo.thermo).forEach(function (k) { seen[k.split('_')[0]] = 1; });
    Object.keys(seen).forEach(function (tk) {
      h.push('<tr><td>' + tk.replace('C', ' K') + '</td>');
      ['5', '10', '20'].forEach(function (n) {
        var v = V.montecarlo.thermo[tk + '_' + n];
        h.push('<td>' + (v ? (v.bias_K > 0 ? '+' : '') + fx(v.bias_K, 1) + ' K / ' + fx(v.rmse_K, 1) +
          ' K / ' + fx(v.cov1, 2) : '—') + '</td>');
      });
      h.push('</tr>');
    });
    h.push('</tbody></table>');
    h.push('<p class="hint">温度计反演的偏差随温度和噪声缓慢增大（1573 K、20% 噪声时 +4.5 K），覆盖率仍在 0.66–0.69。</p>');

    h.push('<table class="data"><thead><tr><th>模型误用情形</th><th>真值 T</th><th>平均反演 T</th><th>偏差</th></tr></thead><tbody>');
    Object.keys(V.montecarlo.thermo_mismodel).forEach(function (k) {
      var v = V.montecarlo.thermo_mismodel[k];
      h.push('<tr class="bl"><td>' + esc(k) + '</td><td>' + fx(v.truth_K, 0) + ' K</td><td>' + fx(v.mean_K, 1) +
        ' K</td><td>' + (v.bias_K > 0 ? '+' : '') + fx(v.bias_K, 1) + ' K</td></tr>');
    });
    h.push('</tbody></table>');

    // ---- C 敏感性 ----
    h.push(vtTitle('C · 敏感性：什么在决定你的误差'));
    h.push('<table class="data"><thead><tr><th>用到的点数</th><th>半径跨度 (Å)</th><th>r₀ (Å)</th>' +
      '<th>±1σ(r₀)</th><th>E (GPa)</th><th>±1σ(E)</th><th>corr(r₀,E)</th></tr></thead><tbody>');
    V.sensitivity.radius_span.forEach(function (r) {
      if (r.degenerate) h.push('<tr class="bl"><td>' + r.n + '</td><td>' + fx(r.span, 3) +
        '</td><td colspan="5">病态：参数不可辨识（D₀、r₀ 顶在边界上）</td></tr>');
      else h.push('<tr><td>' + r.n + '</td><td>' + fx(r.span, 3) + '</td><td>' + fx(r.r0, 4) + '</td><td>' +
        fx(r.dr0, 4) + '</td><td>' + fx(r.E_GPa, 1) + '</td><td>' + fx(r.dE_GPa, 1) + '</td><td>' +
        fx(r.corr_r0_E, 2) + '</td></tr>');
    });
    h.push('</tbody></table>');
    h.push('<p class="hint">r₀ 与 E 高度相关（这里 corr ≈ 0.67–0.81），点数越少误差越大；' +
      '点子太少或半径集中在一小段时，拟合会变成病态 —— 界面会给「触及参数边界」警告。</p>');
    h.push('<table class="data"><thead><tr><th>同一数据的权重方式</th><th>线性域不加权（原脚本）</th>' +
      '<th>对数域等权</th><th>差值</th></tr></thead><tbody>');
    Object.keys(V.sensitivity.weighting_effect).forEach(function (k) {
      var v = V.sensitivity.weighting_effect[k];
      h.push('<tr><td>' + esc(k) + '</td><td>' + fx(v.linear, 1) + ' K</td><td>' + fx(v.log, 1) + ' K</td><td>' +
        (v.log - v.linear > 0 ? '+' : '') + fx(v.log - v.linear, 1) + ' K</td></tr>');
    });
    h.push('</tbody></table>');
    h.push('<p class="hint">权重方式本身也会带来 −55～+53 K 的系统差异 —— 这是方法选择，不是数据误差。</p>');
    box.innerHTML = h.join('');
  }

  function renderLitRefs() {
    var box = $('litBox'), std = $('stdBox');
    if (!box) return;
    if (typeof LIT_REF === 'undefined') { box.textContent = '（未载入）'; return; }
    var h = ['<p class="hint">' + esc(LIT_REF.note) + '</p>'];
    h.push('<table class="data"><thead><tr><th>数据集</th><th>DOI</th><th>实验条件</th><th>获取情况</th><th>说明</th></tr></thead><tbody>');
    LIT_REF.items.forEach(function (it) {
      h.push('<tr><td>' + esc(it.cite) + '</td><td class="mono" style="font-size:11px">' + esc(it.doi) +
        '</td><td>' + esc(String(it.T_C)) + ' °C' + (it.P_GPa != null ? ' / ' + esc(String(it.P_GPa)) + ' GPa' : '') +
        '</td><td>' + esc(it.status) + '</td><td style="text-align:left">' + esc(it.note) + '</td></tr>');
    });
    h.push('</tbody></table>');
    h.push('<p class="hint">拿到 PDF 后，把 Table 里的 D(REE) 复制进模块③（列名写样品名、温度填实验值）就能立刻做同样的反向检验。</p>');
    box.innerHTML = h.join('');
    if (std) std.innerHTML = '<p class="hint">' + esc(LIT_REF.stds) + '</p>';
  }

  /* ============================================ 浓度 -> 分配系数 D 小工具 */
  function parseConc(text) {
    var out = [];
    text.replace(/\r\n?/g, '\n').split('\n').forEach(function (ln) {
      if (!ln.trim()) return;
      var parts = ln.trim().split(/[\s,\t]+/), name = null, val = null;
      parts.forEach(function (p) {
        var v = numCell(p);
        if (v === null) { if (name === null && p.trim() !== '') name = p.trim(); }
        else val = v;
      });
      if (val !== null) out.push({ name: name, v: val });
    });
    return out;
  }
  function computeConcD() {
    var zr = parseConc($('cv_zr').value), mt = parseConc($('cv_melt').value);
    var out = $('cv_out'), msg = $('cv_msg');
    if (!zr.length || !mt.length) {
      out.textContent = '请把锆石浓度与熔体（全岩）浓度各粘一栏。';
      if (msg) msg.textContent = '—';
      return;
    }
    var n = Math.min(zr.length, mt.length), map = R_SHANNON_VIII.radii;
    var lines = ['Radii\tD(zircon/melt)'], rows = [], noRi = [], zero = 0, bad = [];
    for (var i = 0; i < n; i++) {
      var nm = (zr[i].name || mt[i].name || '').replace(/[0-9+\s]/g, '');
      var key = nm ? nm.charAt(0).toUpperCase() + nm.slice(1).toLowerCase() : '';
      var ri = key ? map[key] : null;
      var D = mt[i].v === 0 ? NaN : zr[i].v / mt[i].v;
      if (mt[i].v === 0) zero++;
      if (!isFinite(D) || D <= 0) { bad.push(i + 1); continue; }
      rows.push({ name: nm || ('#' + (i + 1)), ri: ri, D: D });
      if (ri == null) noRi.push(nm || ('#' + (i + 1)));
      else lines.push(ri.toFixed(3) + '\t' + D.toPrecision(8));
    }
    var h = ['<table class="data"><thead><tr><th>元素</th><th>锆石 (ppm)</th><th>熔体/全岩 (ppm)</th>' +
      '<th>ri (Å)</th><th>D = 锆石/熔体</th></tr></thead><tbody>'];
    rows.forEach(function (r, i) {
      h.push('<tr><td>' + esc(r.name) + '</td><td>' + sig(zr[i].v, 4) + '</td><td>' + sig(mt[i].v, 4) +
        '</td><td>' + (r.ri == null ? '—' : fx(r.ri, 3)) + '</td><td>' + sig(r.D, 5) + '</td></tr>');
    });
    out.innerHTML = rows.length ? h.join('') + '</tbody></table>' : '没有可用的配对。';
    out.setAttribute('data-copied', lines.join('\n'));
    var m = ['已配对 ' + rows.length + ' 个元素'];
    if (rows.length - noRi.length > 0) m.push('其中 ' + (rows.length - noRi.length) + ' 个已按 Shannon VIII 半径补好，可直接粘进模块③');
    if (noRi.length) m.push('未识别半径：' + noRi.join('/'));
    if (zero) m.push('有 ' + zero + ' 个熔体浓度为 0');
    if (bad.length) m.push('跳过第 ' + bad.join(',') + ' 行（D 无效）');
    if (msg) msg.textContent = m.join('；');
  }
  function bindConcentrationTool() {
    var run = $('cv_run');
    if (!run) return;
    run.addEventListener('click', computeConcD);
    var cp = $('cv_copy');
    if (cp) cp.addEventListener('click', function () {
      var txt = $('cv_out').getAttribute('data-copied');
      if (!txt) { setStatus('先点「算 D」', 'warn'); return; }
      copyText(txt, '已复制 ri + D 两列，可直接粘进模块③');
    });
  }

  /* ================================== 温度计：8 种参数组合的敏感性（实时） */
  function renderThermoSensitivity(radii, columns, curQ, curR0, curD0) {
    var box = $('m3_sens');
    if (!box) return;
    var combs = [], i;
    var qs = [6489, 7827], r0s = [0.93, 0.95], ms = ['streicher2023', 'rubatto2007'];
    for (var a = 0; a < qs.length; a++) for (var b = 0; b < r0s.length; b++) for (var c = 0; c < ms.length; c++)
      combs.push({ Q: qs[a], r0: r0s[b], m: ms[c] });
    var names = Object.keys(columns), out = [], err = 0;
    try {
      combs.forEach(function (cm) {
        var r = ZR.fitThermo({ radii: radii, columns: columns, Q: cm.Q, r0: cm.r0,
          d0Model: cm.m, absoluteSigma: false });
        out.push({ cm: cm, r: r });
      });
    } catch (e) { err = 1; }
    if (err || !out.length) { box.innerHTML = '<p class="hint">敏感性表计算失败。</p>'; return; }
    var h = ['<table class="data"><thead><tr><th>Q</th><th>r₀ (Å)</th><th>D₀(T) 关系</th>' +
      names.map(function (n) { return '<th>' + esc(n) + ' (K)</th>'; }).join('') + '</tr></thead><tbody>'];
    out.forEach(function (o) {
      var isCur = (o.cm.Q === curQ && Math.abs(o.cm.r0 - curR0) < 1e-9 && o.cm.m === curD0);
      h.push('<tr' + (isCur ? ' class="g"' : '') + '><td>' + o.cm.Q + '</td><td>' + o.cm.r0 + '</td><td>' +
        o.cm.m + (isCur ? ' ←当前' : '') + '</td>' +
        o.r.samples.map(function (s) { return '<td>' + fx(s.T_K, 1) + '</td>'; }).join('') + '</tr>');
    });
    h.push('</tbody></table>');
    // 跨度
    var sp = names.map(function (n, i) {
      var v = out.map(function (o) { return o.r.samples[i].T_K; });
      return Math.max.apply(null, v) - Math.min.apply(null, v);
    });
    h.push('<p class="hint">同一份数据在 8 种参数组合下的温差：' +
      sp.map(function (x, i) { return esc(names[i]) + ' ' + fx(x, 0) + ' K'; }).join('，') +
      ' —— 这就是「模型常数选择」带来的不确定度，通常远大于拟合本身给出的 ±1σ。</p>');
    box.innerHTML = h.join('');
  }

  /* ================================================================ 启动 */
  function init() {
    ST.m1 = { table: { rows: [], nCol: 0, colNames: [] }, maps: { inited: false }, res: null };
    ST.m2 = { table: { rows: [], nCol: 0, colNames: [] }, maps: { inited: false }, res: null };
    ST.m3 = { table: { rows: [], nCol: 0, colNames: [] }, maps: { inited: false }, res: null };

    Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function (x) { x.classList.remove('active'); });
        Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        $('pane-' + b.getAttribute('data-tab')).classList.add('active');
        // 切换后重画（canvas 在隐藏时测量宽度会得到 0）
        var p = b.getAttribute('data-tab');
        if (p === 'm1' && ST.m1.res) drawM1Charts(ST.m1.res, ST.m1.data);
        if (p === 'm2' && ST.m2.res) drawM2Charts(ST.m2.res, ST.m2.data, Number($('m2_Q').value));
        if (p === 'm3' && ST.m3.res) drawM3Charts(ST.m3.res, ST.m3.data);
        try { window.scrollTo(0, 0); } catch (e) { }
      });
    });
    // 总览页的「开始 →」按钮
    Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (btn) {
      btn.addEventListener('click', function () {
        var want = btn.getAttribute('data-goto');
        Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function (b) {
          if (b.getAttribute('data-tab') === want) b.click();
        });
      });
    });
    $('btnTheme').addEventListener('click', function () {
      document.body.classList.toggle('light');
      ['m1', 'm2', 'm3'].forEach(function (p) {
        var st = ST[p];
        if (st.res && st.data) {
          if (p === 'm1') drawM1Charts(st.res, st.data);
          if (p === 'm2') drawM2Charts(st.res, st.data, Number($('m2_Q').value));
          if (p === 'm3') drawM3Charts(st.res, st.data);
        }
      });
    });
    $('btnSelftest').addEventListener('click', runSelfTest);
    $('btnSelftest2').addEventListener('click', runSelfTest);

    bindPane('m1', computeM1);
    bindPane('m2', computeM2);
    bindPane('m3', computeM3);

    // 初始载入示例，让用户一打开就能看到可用的结果
    fillDemoSelect('m1'); fillDemoSelect('m2'); fillDemoSelect('m3');
    applyDemo('m1', 'bb');
    applyDemo('m2', 'bb');
    applyDemo('m3', 'whitehouse');
    renderValidation();
    renderLitRefs();
    bindConcentrationTool();
    var h = location.hash || '';
    if (h.indexOf('tab=') >= 0) {
      var want = /tab=(\w+)/.exec(h)[1];
      Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function (b) {
        if (b.getAttribute('data-tab') === want) b.click();
      });
    }
    if (h.indexOf('selftest') >= 0) setTimeout(runSelfTest, 60);
    else setStatus('就绪 · 已载入示例数据', 'ok');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.__ZRAPP = { runSelfTest: runSelfTest, ST: ST };
})();
