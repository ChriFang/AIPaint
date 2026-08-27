'use strict';
/**
 * 会话编排的测试。两件事必须钉死，因为它们都只在多轮之间才显形：
 *  1. 按轮次给 thinking / tool_choice —— 收尾轮开思考是纯烧钱，留着工具是死循环入口；
 *  2. 场景只在工具真的成功时才发一次 scene 事件，失败轮一个字节都不动。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const M = require('../src/shared/scene.js');
const SESSION = require('../src/agent/session.js');
const TOOLS = require('../src/agent/tools.js');
const DS = require('../src/agent/deepseek.js');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT); // fixturePath 走 process.cwd()

function measure(text, shape) {
  const size = shape.fontSize || 24;
  let w = 0;
  for (const ch of String(text)) w += ch.charCodeAt(0) > 0x2e7f ? size : size * 0.5;
  return w;
}

function cfg(extra) {
  return Object.assign({
    apiKey: '', model: 'deepseek-v4-pro', baseUrl: 'https://example.invalid',
    strict: false, maxRounds: 8, reasoningEffort: 'medium', streamReasoning: true,
    requestTimeoutMs: 5000, maxConcurrent: 2,
    transport: 'fixture', fixtureDir: 'test/fixtures/session', fixtureName: '',
    record: false, debug: false
  }, extra || {});
}

const BLANK = M.validateScene({ width: 800, height: 600, background: '#ffffff', shapes: [] }).scene;

async function run(conf, extra) {
  const events = [];
  const controller = new AbortController();
  const out = await SESSION.run(conf, Object.assign({
    text: '画一张季度回顾标题页',
    scene: BLANK,
    selection: [],
    baseRevision: 3,
    measure: measure,
    signal: controller.signal
  }, extra || {}), (event, data) => events.push({ event, data }));
  return { out, events, of: (name) => events.filter((e) => e.event === name).map((e) => e.data) };
}

test('两轮闭环：第一轮出图，第二轮说话收尾', async () => {
  const { out, events, of } = await run(cfg());
  assert.equal(out.stats.rounds, 2, '干净结果之后应该只再来一轮说话');
  assert.equal(out.stats.applied, 1);

  const scenes = of('scene');
  assert.equal(scenes.length, 1, '场景只能应用一次');
  assert.equal(scenes[0].revision, 4, 'revision 从 baseRevision 往上走');
  assert.equal(scenes[0].baseRevision, 3);
  assert.equal(scenes[0].scene.shapes.length, 2);
  assert.deepEqual(scenes[0].notes, [], '这张版面应该是干净的：' + JSON.stringify(scenes[0].notes));
  assert.equal(scenes[0].touchedIds.length, 2);
  assert.equal(scenes[0].refit, false);

  // 思考走自己的一路事件：不混进正文，也不缺席
  assert.equal(of('delta').some((d) => /页边距|内容宽/.test(d.text)), false, '思考不能混进正文');
  assert.match(of('reasoning').map((r) => r.text).join(''), /页边距/, '思考过程要发出来');
  assert.ok(of('reasoning').every((r) => r.round === 1), '思考要带轮次，面板按轮次分块');
  const phases = of('status').filter((s) => s.phase);
  assert.ok(phases.some((s) => /规划版面/.test(s.text)));
  assert.equal(phases.length, 1, '阶段提示一轮只发一条 —— 面板是原地改写的');
  assert.ok(out.stats.reasoningChars > 20);
  assert.match(out.text, /季度回顾/);

  const order = events.map((e) => e.event);
  assert.deepEqual(order.filter((e) => e === 'tool_start' || e === 'tool_result'), ['tool_start', 'tool_result']);
  assert.ok(order.indexOf('tool_result') < order.indexOf('scene'));
});

test('AGENT_STREAM_REASONING=0：思考不外发，但阶段提示还在', async () => {
  const { out, of } = await run(cfg({ streamReasoning: false }));
  assert.equal(of('reasoning').length, 0, '关掉之后一个字都不许出去');
  assert.ok(of('status').some((s) => s.phase && /规划版面/.test(s.text)),
    '沉默十几秒总得有个交代，这条不能跟着一起没了');
  assert.ok(out.stats.reasoningChars > 20, '只是没外发，思考照样发生并计入日志');
});

test('tool_start 只发语义预览，原始参数不出服务端', async () => {
  const { of } = await run(cfg());
  const start = of('tool_start')[0];
  assert.equal(start.name, 'set_scene');
  assert.match(start.preview, /重画整幅：2 个图形，画布 800×600/);
  assert.ok(!/\{|"type"/.test(start.preview), '预览里不该有 JSON');
});

/** 假客户端：正文必须走 onDelta 吐出来，和真客户端一样 */
function say(opts, content) {
  if (content && opts.onDelta) opts.onDelta(content);
  return { message: { role: 'assistant', content: content }, usage: null, finishReason: 'stop', reasoningChars: 0 };
}

test('按轮次给 thinking 和 tool_choice：出图轮开、收尾轮关', async () => {
  const seen = [];
  const real = DS.streamChatCompletion;
  DS.streamChatCompletion = async (conf, opts) => {
    seen.push({ thinking: opts.thinking, toolChoice: opts.toolChoice, tools: opts.tools.length });
    if (seen.length === 1) {
      return {
        message: { role: 'assistant', content: null, tool_calls: [{
          id: 'c1', type: 'function', function: { name: 'set_scene', arguments: JSON.stringify({
            width: 800, height: 600, background: '#ffffff',
            shapes: [{ type: 'rect', x: 20, y: 20, w: 200, h: 100, fill: '#123456' }]
          }) }
        }] },
        usage: { prompt_tokens: 10, completion_tokens: 20 }, finishReason: 'tool_calls', reasoningChars: 99
      };
    }
    return say(opts, '画好了。');
  };
  try {
    const { out } = await run(cfg());
    assert.equal(out.stats.rounds, 2);
    assert.deepEqual(seen[0], { thinking: true, toolChoice: 'auto', tools: 3 });
    assert.deepEqual(seen[1], { thinking: false, toolChoice: 'none', tools: 3 },
      '收尾轮必须关思考、掐掉工具');
    assert.equal(out.stats.promptTokens, 10);
    assert.equal(out.stats.reasoningChars, 99);
  } finally {
    DS.streamChatCompletion = real;
  }
});

test('轮次用尽时强制收尾，不抛异常', async () => {
  const real = DS.streamChatCompletion;
  const seen = [];
  DS.streamChatCompletion = async (conf, opts) => {
    seen.push(opts.toolChoice);
    if (opts.toolChoice === 'none') return say(opts, '只能到这了。');
    return { message: { role: 'assistant', content: null, tool_calls: [{
      id: 'c' + seen.length, type: 'function',
      // 每轮都留下一个 note（整个在画布外），于是永远不 clean
      function: { name: 'set_scene', arguments: JSON.stringify({
        width: 800, height: 600, background: '#ffffff',
        shapes: [{ type: 'rect', x: 2000, y: 2000, w: 50, h: 50, fill: '#123456' }]
      }) }
    }] }, reasoningChars: 0 };
  };
  try {
    const { out, of } = await run(cfg({ maxRounds: 3 }));
    assert.equal(out.stats.rounds, 3);
    assert.deepEqual(seen, ['auto', 'auto', 'none'], '最后一轮强制说话');
    assert.equal(out.text, '只能到这了。');
    assert.ok(of('scene').every((s) => s.notes.length > 0), '有 notes 就不算干净');
  } finally {
    DS.streamChatCompletion = real;
  }
});

test('连续两轮同一类错误就停，场景一个字节都没动', async () => {
  const { out, of } = await run(cfg({ fixtureDir: 'test/fixtures/reject' }));
  assert.equal(out.stats.applied, 0);
  assert.equal(of('scene').length, 0, '失败轮不能发 scene');
  assert.equal(out.stats.rounds, 2);
  assert.ok(out.stuck);
  const errs = of('error');
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /连续两轮/);
  assert.match(errs[0].message, /unknown_field/);

  const results = of('tool_result');
  assert.equal(results[0].ok, false);
  assert.equal(results[0].problems[0].code, 'unknown_field');
  assert.match(results[0].problems[0].hint, /rotationDeg/, 'problems 要能直接指导下一轮');
});

test('中断信号让循环立刻停下', async () => {
  const controller = new AbortController();
  controller.abort(new Error('用户点了停止'));
  const events = [];
  const out = await SESSION.run(cfg(), {
    text: '画点什么', scene: BLANK, selection: [], baseRevision: 0,
    measure: measure, signal: controller.signal
  }, (event, data) => events.push({ event, data }));
  assert.equal(out.stats.rounds, 0);
  assert.equal(events.length, 0);
});

test('选中项透传进提示，未知 id 被过滤', async () => {
  const sc = M.validateScene({
    width: 400, height: 300, background: '#ffffff',
    shapes: [{ id: 'keep', type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#111111' }]
  }).scene;
  const PROMPT = require('../src/agent/prompt.js');
  const ctx = { scene: sc, srcRefs: {}, selection: ['keep'] };
  const msg = PROMPT.userMessage('把它改成红色', ctx);
  assert.match(msg.content, /用户当前选中：keep/);
  assert.match(msg.content, /把它改成红色/);

  const real = DS.streamChatCompletion;
  let captured = null;
  DS.streamChatCompletion = async (conf, opts) => {
    captured = opts.messages;
    return say(opts, '好');
  };
  try {
    await SESSION.run(cfg(), {
      text: 'x', scene: sc, selection: ['keep', 'ghost'], baseRevision: 0,
      measure: measure, signal: new AbortController().signal
    }, () => {});
    assert.match(captured[1].content, /用户当前选中：keep/);
    assert.ok(!captured[1].content.includes('ghost'), '不存在的 id 不能进提示');
  } finally {
    DS.streamChatCompletion = real;
  }
});

test('系统提示从字段表生成，规则和字段都在里面', () => {
  const PROMPT = require('../src/agent/prompt.js');
  const sys = PROMPT.systemPrompt();
  assert.match(sys, /rotationDeg/);
  assert.match(sys, /- rect：必填 x y w h/);
  assert.match(sys, /- text：必填 x y text/);
  assert.ok(!/- rect：.*\brotation\b(?!Deg)/.test(sys), '不能出现 rotation 字段');
  assert.match(sys, /path \+ smooth:false/);
  assert.match(sys, /配方 B · 三栏卡片/);
  assert.match(sys, /#0f172a|ink/);
});

test('未知工具名和坏参数都变成可回喂的 problems，不抛异常', () => {
  const ctx = { scene: BLANK, srcRefs: {}, selection: [], measure: measure };
  const a = TOOLS.execute({ id: '1', function: { name: 'draw_everything', arguments: '{}' } }, ctx);
  assert.equal(a.ok, false);
  assert.equal(a.result.problems[0].code, 'bad_enum');

  const b = TOOLS.execute({ id: '2', function: { name: 'set_scene', arguments: '{"width":800,' } }, ctx);
  assert.equal(b.result.problems[0].code, 'bad_json');

  const c = TOOLS.execute({ id: '3', function: { name: 'edit_scene', arguments: '{"ops":{}}' } }, ctx);
  assert.equal(c.result.problems[0].code, 'missing');

  const d = TOOLS.execute({ id: '4', function: { name: 'get_scene', arguments: '' } }, ctx);
  assert.equal(d.ok, true);
  assert.equal(d.clean, false, 'get_scene 是读操作，不能把闸门打开');
  assert.match(d.result.scene, /画布 800×600/);
  assert.equal(JSON.stringify(ctx.scene), JSON.stringify(BLANK));
});
