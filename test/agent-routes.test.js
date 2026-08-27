'use strict';
/**
 * HTTP 层的测试。单测覆盖不到的东西全在这里：
 * SSE 头、事件顺序、Origin/参数校验、单飞 409。
 *
 * 尤其是「连接是否还活着」的判定 —— 这只有真起一个 server 才会暴露：
 * express.json 读完 body 就会让 req 流 emit 'close'，中断监听必须挂在 res 上。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
process.env.AIPAINT_AGENT_TRANSPORT = 'fixture';
process.env.AIPAINT_AGENT_FIXTURE_DIR = 'test/fixtures/session';

const { app } = require('../server.js');
const SESSION = require('../src/agent/session.js');

let server;
let origin;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { if (server) server.close(); });

function body(extra) {
  return Object.assign({
    sessionId: 'sess-0001-abcd-efgh',
    text: '画一张季度回顾标题页',
    baseRevision: 7,
    selection: [],
    scene: { width: 800, height: 600, background: '#ffffff', shapes: [] }
  }, extra || {});
}

function post(payload, headers) {
  return fetch(origin + '/api/agent', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', Origin: origin }, headers || {}),
    body: JSON.stringify(payload)
  });
}

/** 把整条 SSE 响应解析成 [{event, data}] */
function parseSSE(text) {
  return text.split('\n\n').map((frame) => {
    const out = { event: '', data: null };
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) out.event = line.slice(7);
      else if (line.startsWith('data: ')) out.data = JSON.parse(line.slice(6));
    }
    return out;
  }).filter((e) => e.event);
}

test('POST /api/agent：SSE 头正确，事件顺序正确，场景只发一次', async () => {
  const res = await post(body());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');

  const events = parseSSE(await res.text());
  const names = events.map((e) => e.event);
  assert.equal(names[0], 'open');
  assert.equal(names[names.length - 1], 'done');
  assert.deepEqual(names.filter((n) => n === 'scene'), ['scene'], '场景只能应用一次');
  assert.ok(names.indexOf('tool_start') < names.indexOf('tool_result'));
  assert.ok(!names.includes('error'), JSON.stringify(events.find((e) => e.event === 'error')));

  const scene = events.find((e) => e.event === 'scene').data;
  assert.equal(scene.baseRevision, 7);
  assert.equal(scene.revision, 8);
  assert.equal(scene.scene.shapes.length, 2);
  assert.equal(scene.scene.shapes[1].type, 'text');
  assert.ok(scene.scene.shapes[1].w > 0, '文字尺寸由服务端度量烘进场景');

  const done = events.find((e) => e.event === 'done').data;
  assert.equal(done.applied, 1);
  assert.equal(done.rounds, 2);
  assert.equal(done.stuck, false);

  const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.match(text, /季度回顾/);
  assert.ok(!/页边距|内容宽/.test(text), '思考不能混进正文 delta');

  // 思考过程走自己的一路事件（面板折成可收起的一块），正文和它互不污染
  const think = events.filter((e) => e.event === 'reasoning').map((e) => e.data.text).join('');
  assert.match(think, /页边距/);
  assert.ok(events.some((e) => e.event === 'status' && e.data.phase), '阶段提示要标成临时的');
});

test('Origin 和 Host 不一致就拒绝', async () => {
  const res = await post(body(), { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /跨站/);
});

test('参数校验：缺 text / 缺 scene / sessionId 非法都是 400', async () => {
  for (const payload of [body({ text: '  ' }), body({ scene: null }), body({ sessionId: 'x' })]) {
    const res = await post(payload);
    assert.equal(res.status, 400, JSON.stringify(payload).slice(0, 60));
    assert.ok((await res.json()).error);
  }
  const big = await post(body({ text: 'a'.repeat(16001) }));
  assert.equal(big.status, 400);
});

test('同一会话单飞：正在跑的时候再来一次是 409', async () => {
  SESSION.begin('sess-busy-0001');
  try {
    const res = await post(body({ sessionId: 'sess-busy-0001' }));
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /正在生成/);
  } finally {
    SESSION.end('sess-busy-0001');
  }
});

test('GET /api/agent/config 不含 key 也不含 baseUrl', async () => {
  const res = await fetch(origin + '/api/agent/config', { headers: { Origin: origin } });
  const cfg = await res.json();
  assert.deepEqual(Object.keys(cfg).sort(), ['hasApiKey', 'maxRounds', 'model', 'reasoningEffort', 'strict']);
  assert.equal(typeof cfg.hasApiKey, 'boolean');
});
