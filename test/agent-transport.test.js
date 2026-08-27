'use strict';
/**
 * SSE 帧循环的测试。真正会坏的地方只有一处：分块边界。
 * 所以这里把同一份 fixture 用 1..N 字节的块长各回放一遍 —— 1 字节意味着
 * 每个 UTF-8 序列、每个 \n\n、每个 data: 行都被切开，结果必须完全一致。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const DS = require('../src/agent/deepseek.js');
const TC = require('../src/agent/tool-calls.js');

const ROOT = path.resolve(__dirname, '..');

function cfg(extra) {
  return Object.assign({
    apiKey: '', model: 'deepseek-v4-pro', baseUrl: 'https://example.invalid',
    strict: false, maxRounds: 8, reasoningEffort: 'medium',
    requestTimeoutMs: 5000, maxConcurrent: 2,
    transport: 'fixture', fixtureDir: 'test/fixtures', fixtureName: '',
    record: false, debug: false
  }, extra || {});
}

/** fixturePath 用 process.cwd()，测试可能从任何目录跑起来 */
function inRoot(fn) {
  const before = process.cwd();
  process.chdir(ROOT);
  try { return fn(); } finally { process.chdir(before); }
}

async function replay(fixture, chunkSize) {
  const before = process.env.AIPAINT_AGENT_FIXTURE_CHUNK;
  if (chunkSize) process.env.AIPAINT_AGENT_FIXTURE_CHUNK = String(chunkSize);
  // 块长在模块加载时读一次，改环境变量要重新加载模块
  const mod = chunkSize ? loadFresh() : DS;
  const deltas = [];
  const reasoning = [];
  try {
    const res = await inRoot(() => mod.streamChatCompletion(cfg(), {
      messages: [{ role: 'user', content: 'hi' }],
      fixture: fixture,
      onDelta: (t) => deltas.push(t),
      onReasoning: (t) => reasoning.push(t)
    }));
    return Object.assign(res, { deltas, reasoning });
  } finally {
    if (before == null) delete process.env.AIPAINT_AGENT_FIXTURE_CHUNK;
    else process.env.AIPAINT_AGENT_FIXTURE_CHUNK = before;
  }
}

function loadFresh() {
  const id = require.resolve('../src/agent/deepseek.js');
  delete require.cache[id];
  const mod = require('../src/agent/deepseek.js');
  delete require.cache[id]; // 别把改过块长的实例留给下一个测试
  return mod;
}

test('思考轮：reasoning 单独出口，tool_call 分片重组成合法 JSON', async () => {
  const res = await replay('thinking-tool');
  assert.equal(res.deltas.length, 0, 'reasoning 绝不能混进 onDelta');
  assert.ok(res.reasoning.length >= 2);
  assert.ok(res.reasoningChars > 20);
  assert.equal(res.message.content, null);
  assert.equal(res.message.tool_calls.length, 1);

  const call = res.message.tool_calls[0];
  assert.equal(call.id, 'call_0_layout', 'id 后到也要补上');
  assert.equal(call.function.name, 'set_scene');
  const args = JSON.parse(call.function.arguments);
  assert.equal(args.width, 800);
  assert.equal(args.shapes.length, 2);
  assert.equal(args.shapes[1].text, '季度回顾');

  assert.equal(res.finishReason, 'tool_calls');
  assert.equal(res.usage.total_tokens, 1600);
});

test('收尾轮：只有正文，尾部帧不带空行也要冲刷出 usage', async () => {
  const res = await replay('final-text');
  assert.equal(res.reasoning.length, 0);
  assert.equal(res.deltas.length, 3);
  assert.equal(res.message.content, res.deltas.join(''));
  assert.match(res.message.content, /季度回顾/);
  assert.ok(!res.message.tool_calls);
  assert.equal(res.finishReason, 'stop');
  assert.equal(res.usage.total_tokens, 1643, '最后一帧没有 \\n\\n，全靠尾部冲刷');
});

test('分块边界：1/2/3/13/64 字节切开，结果必须逐字节一致', async () => {
  const golden = await replay('thinking-tool', 4096);
  for (const size of [1, 2, 3, 13, 64]) {
    const res = await replay('thinking-tool', size);
    assert.equal(JSON.stringify(res.message), JSON.stringify(golden.message), 'chunk=' + size);
    assert.equal(res.reasoning.join(''), golden.reasoning.join(''), 'chunk=' + size + ' 的 reasoning 不一致');
  }
});

test('找不到 fixture 报错而不是静默返回空', async () => {
  await assert.rejects(() => inRoot(() => DS.streamChatCompletion(cfg(), {
    messages: [], fixture: 'nope-does-not-exist'
  })), /找不到 fixture/);
});

test('http 传输缺 key 时立刻失败，不发请求', async () => {
  await assert.rejects(() => DS.streamChatCompletion(cfg({ transport: 'http' }), { messages: [] }),
    /DEEPSEEK_API_KEY/);
});

test('buildBody：thinking 两个方向都显式发，顶层不是 extra_body', () => {
  const on = JSON.parse(DS.buildBody(cfg(), [{ role: 'user', content: 'x' }], [{ a: 1 }], 'auto', true));
  assert.deepEqual(on.thinking, { type: 'enabled' });
  assert.equal(on.reasoning_effort, 'medium');
  assert.equal(on.stream, true);
  assert.deepEqual(on.stream_options, { include_usage: true });
  assert.equal(on.tool_choice, 'auto');
  assert.ok(!on.extra_body);

  const off = JSON.parse(DS.buildBody(cfg(), [], null, null, false));
  assert.deepEqual(off.thinking, { type: 'disabled' });
  assert.ok(!('reasoning_effort' in off), '关思考时不该带 effort');
  assert.ok(!('tools' in off));
});

/* ── tool-calls.js：直接对着上游网关咬过的那几种畸形写 ─────────────────── */

test('filterValidToolCalls 丢掉缺 id/缺名/重复/参数非法的调用', () => {
  const res = TC.filterValidToolCalls([
    { id: 'a', type: 'function', function: { name: 'set_scene', arguments: '{"width":1}' } },
    { id: '', function: { name: 'set_scene', arguments: '{}' } },
    { id: 'b', function: { name: '', arguments: '{}' } },
    { id: 'a', function: { name: 'set_scene', arguments: '{}' } },
    { id: 'c', function: { name: 'edit_scene', arguments: '{"ops":[' } },
    { id: 'd', function: { name: 'get_scene', arguments: '' } },
    null
  ]);
  assert.deepEqual(res.valid.map((t) => t.id), ['a', 'd'], '无参调用是合法的');
  assert.equal(res.droppedReasons.length, 5);
});

test('dropOrphanToolMessages：没有结果的 tool_calls 必须摘掉', () => {
  const res = TC.dropOrphanToolMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '我来画', tool_calls: [{ id: 'x', function: { name: 'set_scene', arguments: '{}' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'y', function: { name: 'set_scene', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'zzz', content: '孤儿' }
  ]);
  assert.equal(res.messages.length, 2, '无正文又无结果的 assistant 整条丢掉');
  assert.equal(res.messages[1].content, '我来画');
  assert.ok(!res.messages[1].tool_calls, '留着必被上游拒');
  assert.ok(res.droppedToolCallIds.includes('zzz'));
});

test('dropOrphanToolMessages：配得上的一对原样保留，部分应答只留应答的那些', () => {
  const pair = [
    { role: 'assistant', content: null, tool_calls: [
      { id: 'x', function: { name: 'set_scene', arguments: '{}' } },
      { id: 'y', function: { name: 'get_scene', arguments: '{}' } }
    ] },
    { role: 'tool', tool_call_id: 'x', content: '{"ok":true}' }
  ];
  const res = TC.dropOrphanToolMessages(pair);
  assert.equal(res.messages.length, 2);
  assert.deepEqual(res.messages[0].tool_calls.map((t) => t.id), ['x']);
  assert.equal(res.messages[1].role, 'tool');
});

test('getToolCallDeltaIndex：没有 index 时靠 id / 上一个是否已完整来判断', () => {
  assert.equal(TC.getToolCallDeltaIndex([], { function: { name: 'a' } }), 0);
  const one = [{ id: 'a', type: 'function', function: { name: 'set_scene', arguments: '{}' } }];
  assert.equal(TC.getToolCallDeltaIndex(one, { id: 'a', function: { arguments: 'x' } }), 0);
  assert.equal(TC.getToolCallDeltaIndex(one, { function: { arguments: 'x' } }), 0, '纯参数分片接着上一个');
  assert.equal(TC.getToolCallDeltaIndex(one, { id: 'b', function: { name: 'get_scene' } }), 1, '新身份要开新槽');
});
