'use strict';
/**
 * 凭证端点的测试。这两个端点碰的是一把能花钱的 key，所以盯三件事：
 * 原始 key 一个字节都不许出服务端、非法输入在写文件之前就被拒、跨站请求拒绝。
 *
 * 顺序有讲究：AIPAINT_ENV_FILE 和 chdir 都必须在 require('../server.js') 之前 ——
 * server.js 在加载时就会 process.loadEnvFile()，晚一步就读到仓库里真的 .env 了。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipaint-cred-'));
const FILE = path.join(dir, '.env');
process.env.AIPAINT_ENV_FILE = FILE;
process.chdir(dir);

const { app } = require('../server.js');

const KEY = 'sk-test-0123456789abcdef';
let server;
let origin;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 每个用例自己摆好起始状态，别依赖上一个用例留下的 */
function reset(envText) {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
  if (envText == null) { try { fs.unlinkSync(FILE); } catch { /* 本来就没有 */ } }
  else fs.writeFileSync(FILE, envText);
}
function readFile() { try { return fs.readFileSync(FILE, 'utf8'); } catch { return null; } }

function get(headers) {
  return fetch(origin + '/api/agent/credentials', {
    headers: Object.assign({ Origin: origin }, headers || {})
  });
}
function save(payload, headers) {
  return fetch(origin + '/api/agent/credentials', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', Origin: origin }, headers || {}),
    body: JSON.stringify(payload)
  });
}

test('GET：只回掩码，原始 key 在响应里一个字节都找不到', async () => {
  reset('DEEPSEEK_API_KEY=' + KEY + '\n');
  process.env.DEEPSEEK_API_KEY = KEY;

  const res = await get();
  const raw = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!raw.includes(KEY), '响应体里出现了原始 key');
  assert.ok(!raw.includes(KEY.slice(6, -4)), '掩码把中间段漏出去了');

  const body = JSON.parse(raw);
  assert.equal(body.hasApiKey, true);
  assert.equal(body.apiKeyMasked, 'sk-tes…cdef');
  assert.equal(body.envPath, FILE);
  assert.equal(body.envExists, true);
  assert.equal(body.fromEnvFile, true, 'key 和 .env 里的一致，界面才敢说改文件有用');
  assert.equal(body.baseUrlDefault, 'https://api.deepseek.com');
});

test('GET：key 来自 shell 而不是 .env 时 fromEnvFile 为 false', async () => {
  reset('# 只有注释\n');
  process.env.DEEPSEEK_API_KEY = KEY;
  const body = await (await get()).json();
  assert.equal(body.hasApiKey, true);
  assert.equal(body.fromEnvFile, false, '改 .env 对 shell 里的变量没用，这条得让界面说清楚');
});

test('POST：写进 .env，尾斜杠去掉，且不用重启就生效', async () => {
  reset('# 我的配置\nOTHER=keep-me\n');
  const res = await save({ baseUrl: 'https://x.example/v1/', apiKey: KEY });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.baseUrl, 'https://x.example/v1');
  assert.equal(body.hasApiKey, true);
  assert.ok(!JSON.stringify(body).includes(KEY));

  const text = readFile();
  assert.match(text, /^# 我的配置\nOTHER=keep-me\n/, '别人的行必须原样留着');
  assert.match(text, /\nDEEPSEEK_BASE_URL=https:\/\/x\.example\/v1\n/);
  assert.match(text, new RegExp('\\nDEEPSEEK_API_KEY=' + KEY + '\\n'));

  // config.load() 每次现读 process.env，所以就地更新 = 不用重启
  assert.equal(process.env.DEEPSEEK_API_KEY, KEY);
  const cfg = await (await fetch(origin + '/api/agent/config', { headers: { Origin: origin } })).json();
  assert.equal(cfg.hasApiKey, true, '存完就该能发了');
});

test('POST：baseUrl 传空 = 删掉那一行回到默认，key 传空 = 不碰原来那把', async () => {
  reset('DEEPSEEK_API_KEY=' + KEY + '\nDEEPSEEK_BASE_URL=https://old.example\n');
  process.env.DEEPSEEK_API_KEY = KEY;
  process.env.DEEPSEEK_BASE_URL = 'https://old.example';

  const body = await (await save({ baseUrl: '', apiKey: '' })).json();
  assert.equal(body.baseUrl, 'https://api.deepseek.com');
  assert.equal(body.hasApiKey, true);
  assert.equal(readFile(), 'DEEPSEEK_API_KEY=' + KEY + '\n');
  assert.equal(process.env.DEEPSEEK_BASE_URL, undefined);
  assert.equal(process.env.DEEPSEEK_API_KEY, KEY, '没填 key 就不许动已有的那把');
});

test('POST：非法输入一律 400，且文件一个字节都不动', async () => {
  const before = 'DEEPSEEK_API_KEY=' + KEY + '\n';
  const bad = [
    { baseUrl: 'https://x.example/v1?token=abc' },   // 带查询串
    { baseUrl: 'https://x.example/v1#frag' },
    { baseUrl: 'ftp://x.example' },
    { baseUrl: '不是 URL' },
    { baseUrl: 'https://x.example/\nHOST=evil' },
    { apiKey: 'sk-a"b\'c' },                          // 引号会破坏 .env 的一行一变量
    { apiKey: 'sk-x\nNODE_OPTIONS=--require /tmp/evil.js' },
    { apiKey: 'short' },                              // 太短，八成是填错了
    { apiKey: 'k'.repeat(513) }
  ];
  for (const payload of bad) {
    reset(before);
    process.env.DEEPSEEK_API_KEY = KEY;
    const res = await save(payload);
    assert.equal(res.status, 400, JSON.stringify(payload).slice(0, 60));
    assert.ok((await res.json()).error);
    assert.equal(readFile(), before, '拒绝要发生在写之前：' + JSON.stringify(payload).slice(0, 60));
  }
});

test('POST：一片空白且本来也没配过，就直接说什么都没填', async () => {
  reset(null);
  const res = await save({ baseUrl: '', apiKey: '' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /什么都没填/);
  assert.equal(readFile(), null, '这种情况连文件都不该建出来');
});

test('跨站请求进不来，GET 和 POST 都一样', async () => {
  reset(null);
  const g = await get({ Origin: 'http://evil.example' });
  assert.equal(g.status, 403);
  const p = await save({ apiKey: KEY }, { Origin: 'http://evil.example' });
  assert.equal(p.status, 403);
  assert.match((await p.json()).error, /跨站/);
  assert.equal(readFile(), null, '被拒的请求不许留下任何痕迹');
});
