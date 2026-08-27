'use strict';
/**
 * .env 读改写的测试。这文件里躺着一把能花钱的 key，所以三件事必须由测试盯着：
 * 换行注入被拒、其他行不被动、权限是 0600。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipaint-env-'));
process.env.AIPAINT_ENV_FILE = path.join(dir, '.env');
const ENV = require('../src/agent/env-file.js');

const FILE = process.env.AIPAINT_ENV_FILE;
function write(text) { fs.writeFileSync(FILE, text); }
function read() { return fs.readFileSync(FILE, 'utf8'); }

test.beforeEach(() => { try { fs.unlinkSync(FILE); } catch { /* 本来就没有 */ } });
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('parse：认 export 前缀和引号，不认注释和垃圾行', () => {
  const v = ENV.parse([
    '# 注释',
    'DEEPSEEK_API_KEY=sk-plain',
    'export DEEPSEEK_BASE_URL="https://x.example/v1"',
    "QUOTED='a b'",
    '这行不是变量',
    ''
  ].join('\n'));
  assert.deepEqual(v, {
    DEEPSEEK_API_KEY: 'sk-plain',
    DEEPSEEK_BASE_URL: 'https://x.example/v1',
    QUOTED: 'a b'
  });
});

test('文件不存在时 read() 不抛，patch() 直接建出来', () => {
  const before = ENV.read();
  assert.equal(before.exists, false);
  assert.deepEqual(before.values, {});
  ENV.patch({ DEEPSEEK_API_KEY: 'sk-new' });
  assert.equal(read(), 'DEEPSEEK_API_KEY=sk-new\n');
});

test('改写只动命中的那一行，注释和别人的变量原样保留', () => {
  write('# 我的配置\nOTHER=keep-me\nDEEPSEEK_API_KEY=sk-old\n\n# 尾注释\n');
  ENV.patch({ DEEPSEEK_API_KEY: 'sk-new' });
  assert.equal(read(), '# 我的配置\nOTHER=keep-me\nDEEPSEEK_API_KEY=sk-new\n\n# 尾注释\n');
});

test('值为 null 就删掉那一行；undefined 表示没传，原样留着', () => {
  write('DEEPSEEK_API_KEY=sk-old\nDEEPSEEK_BASE_URL=https://old.example\n');
  ENV.patch({ DEEPSEEK_BASE_URL: null, DEEPSEEK_API_KEY: undefined });
  assert.equal(read(), 'DEEPSEEK_API_KEY=sk-old\n');
});

test('换行注入被拒，且文件一个字节都不改', () => {
  write('DEEPSEEK_API_KEY=sk-old\n');
  assert.throws(
    () => ENV.patch({ DEEPSEEK_API_KEY: 'sk-x\nNODE_OPTIONS=--require /tmp/evil.js' }),
    /不能包含换行/
  );
  assert.equal(read(), 'DEEPSEEK_API_KEY=sk-old\n', '写之前就该拒掉，不能先截断再写');
});

test('写出来的文件是 0600', { skip: process.platform === 'win32' }, () => {
  ENV.patch({ DEEPSEEK_API_KEY: 'sk-perm' });
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
});

test('一次追加两个键：中间不夹空行；追加到有内容的文件才隔一行', () => {
  ENV.patch({ DEEPSEEK_BASE_URL: 'https://x.example/v1', DEEPSEEK_API_KEY: 'sk-new' });
  assert.equal(read(), 'DEEPSEEK_BASE_URL=https://x.example/v1\nDEEPSEEK_API_KEY=sk-new\n');

  write('OTHER=keep-me');   // 故意没有末尾换行
  ENV.patch({ A: '1', B: '2' });
  assert.equal(read(), 'OTHER=keep-me\n\nA=1\nB=2\n');
});

test('带空格的值加引号，再 parse 回来还是原值', () => {
  ENV.patch({ WEIRD: 'a b#c"d' });
  assert.equal(ENV.parse(read()).WEIRD, 'a b#c"d');
});

test('mask 只露头尾，中间一律省略', () => {
  assert.equal(ENV.mask('sk-abcdefghijklmnop'), 'sk-abc…mnop');
  assert.equal(ENV.mask('short'), 'sh…');
  assert.equal(ENV.mask(''), '');
});
