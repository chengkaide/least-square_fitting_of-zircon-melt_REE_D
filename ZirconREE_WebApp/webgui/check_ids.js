/* check_ids.js -- 静态检查：app.js 里 $('xxx') 引用的每个 id 都必须在 template.html 中存在
 * 用法: node webgui/check_ids.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const HERE = __dirname;
const tpl = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
const app = fs.readFileSync(path.join(HERE, 'src', 'app.js'), 'utf8');

const ids = new Set();
for (const m of tpl.matchAll(/id="([^"]+)"/g)) ids.add(m[1]);

// app.js 里 'xxx' 形式的字面量：动态拼接的行内字符串单独列出
const used = new Set();
for (const m of app.matchAll(/\$\('([^']+)'\)/g)) used.add(m[1]);

// 动态 id：pfx + '_' + suffix
const dyn = new Set();
for (const m of app.matchAll(/'(\w+)'\)\]|ids\s*=\s*\{([^}]+)\}/g)) { }
const suffixes = ['_badge', '_report', '_stats', '_bigvals', '_msgs', '_preview', '_data', '_file', '_drop',
  '_calc', '_clear', '_copy', '_csv', '_json', '_png', '_print', '_demo1', '_demo2', '_fillri', '_readTP',
  '_mapEl', '_mapRi', '_mapDi', '_mapS', '_errmode', '_abs', '_T', '_P', '_Q', '_r0', '_d0', '_samples',
  '_chart', '_resid'];
const pfxs = ['m1', 'm2', 'm3'];
for (const p of pfxs) for (const s of suffixes) dyn.add(p + s);

const missing = [...used].filter(id => !ids.has(id) && !dyn.has(id));
const unused = [...ids].filter(id => !used.has(id) && !dyn.has(id) && !/^(pane-|selftestOut|statusPill|selftestCard)/.test(id));

console.log('template.html 中的 id 数:', ids.size);
console.log('app.js 直接引用的 id 数:', used.size);
if (missing.length) { console.log('\n❌ app.js 引用了不存在的 id:'); missing.forEach(m => console.log('   - ' + m)); }
else console.log('\n✅ app.js 引用的 id 全部存在于 template.html');

if (unused.length) { console.log('\n提示：template 中存在但 app.js 未引用的 id（可能是纯样式用）:'); unused.forEach(m => console.log('   - ' + m)); }
process.exit(missing.length ? 1 : 0);
