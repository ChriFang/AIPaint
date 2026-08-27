'use strict';
/**
 * 面板层的测试。浏览器代码本来是这套实现里唯一没被覆盖的部分，而它恰好装着两处
 * 最容易坏的逻辑：SSE 帧解析（切在任意字节上都得对）和应用顺序
 * （loadScene → 补量 → 设选中 → commit，顺序错了 ⌘Z 就丢选中）。
 *
 * 做法是把 public/js/agent.js 丢进 vm，喂一个刚够用的假 window。
 * 不引 jsdom：这里要验的是我们的控制流，不是 DOM 实现。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.resolve(__dirname, '../public/js/agent.js'), 'utf8');
// imagefile.js 在真页面里排在 agent.js 之前（ui.js 的插图也用它）。
// 两个都是挂 window 的 IIFE，所以拼起来跑和分两个 <script> 等价。
const HELPER = fs.readFileSync(path.resolve(__dirname, '../public/js/imagefile.js'), 'utf8');

function makeEl(tag) {
  const el = {
    tagName: tag, className: '', textContent: '', hidden: false, disabled: false,
    type: '', title: '', value: '', placeholder: '', childNodes: [], handlers: {},
    focused: false, files: null, clicks: 0,
    scrollHeight: 100, scrollTop: 100, clientHeight: 100,
    focus() { el.focused = true; },
    // 真 DOM 的 click() 会同步跑一遍监听器；附件那两个隐藏 input 就靠它被触发
    click() { el.clicks += 1; el.fire('click'); },
    addEventListener(name, fn) { (el.handlers[name] = el.handlers[name] || []).push(fn); },
    appendChild(child) { child.parentNode = el; el.childNodes.push(child); return child; },
    removeChild(child) {
      const i = el.childNodes.indexOf(child);
      if (i >= 0) el.childNodes.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    get firstChild() { return el.childNodes[0] || null; },
    fire(name, ev) {
      const list = el.handlers[name] || [];
      for (const fn of list) fn.call(el, Object.assign({ preventDefault() {}, stopPropagation() {} }, ev || {}));
    }
  };
  el.classList = {
    contains(c) { return el.className.split(/\s+/).indexOf(c) >= 0; },
    add(c) { if (!el.classList.contains(c)) el.className = (el.className + ' ' + c).trim(); },
    remove(c) { el.className = el.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
    toggle(c, on) { if (on) el.classList.add(c); else el.classList.remove(c); }
  };
  el.parentNode = null;
  return el;
}

/**
 * canvas 只有两件事被用到：drawImage（缩放）和 toDataURL（重编码）。
 * 两种格式给不同长度的假字节，于是「PNG 和 JPEG 各编一次取小的」那条分支是真的被走过的。
 */
function makeCanvas() {
  const cv = makeEl('canvas');
  cv.width = 0;
  cv.height = 0;
  cv.getContext = () => ({ drawImage(img, x, y, w, h) { cv.drew = [w, h]; } });
  cv.toDataURL = (mime, q) => {
    const n = Math.max(4, Math.round(cv.width * cv.height / 100));
    return mime === 'image/jpeg'
      ? 'data:image/jpeg;base64,' + 'J'.repeat(n) + '=='
      : 'data:image/png;base64,' + 'P'.repeat(n * 3) + '==';
  };
  return cv;
}

/** 测试用的假 File。宽高编进 data URL，于是它走的是和真代码一样的那条路 */
function fakeFile(o) {
  return {
    name: o.name, type: o.type || '', size: o.size == null ? 1024 : o.size,
    __url: 'data:' + (o.type || 'image/png') + ';base64,IMG' + (o.w || 0) + 'x' + (o.h || 0),
    __text: o.text == null ? '' : o.text,
    __failRead: Boolean(o.failRead)
  };
}

function imageFile(name, w, h, size) {
  return fakeFile({ name: name, type: 'image/png', w: w, h: h, size: size });
}

function textFile(name, text, type) {
  return fakeFile({ name: name, type: type || 'text/plain', text: text });
}

const IDS = ['chat-panel', 'chat-log', 'chat-form', 'chat-input', 'chat-send', 'chat-hint',
  'btn-agent-stop', 'btn-mode-toggle', 'undo', 'redo', 'btn-clear', 'btn-import-json',
  'btn-agent-settings', 'agent-settings', 'cfg-form', 'cfg-base-url', 'cfg-api-key',
  'cfg-note', 'cfg-cancel', 'cfg-save',
  'chat-atts', 'btn-chat-plus', 'chat-menu', 'btn-att-image', 'btn-att-doc',
  'file-chat-image', 'file-chat-doc'];

const DEFAULT_BASE = 'https://api.deepseek.com';
const KEY_DOTS = '••••••••••••';
/** 凭证端点的默认回放：没配过 key，.env 还不存在 */
const CRED = {
  baseUrl: DEFAULT_BASE, baseUrlDefault: DEFAULT_BASE, hasApiKey: false, apiKeyMasked: '',
  fromEnvFile: false, envPath: '/tmp/aipaint/.env', envExists: false
};

/** 假 window + 假 Store/View/UI。calls 按发生顺序记账，顺序本身就是断言对象 */
function boot(opts) {
  const options = opts || {};
  const els = {};
  for (const id of IDS) els[id] = makeEl('div');
  const appEl = makeEl('div');
  appEl.className = 'app';

  const calls = [];
  const store = {
    state: {
      scene: { width: 800, height: 600, background: '#ffffff', shapes: [] },
      selection: ['old'], tool: 'rect'
    },
    historyIndex: 3,
    loadScene(scene, o) {
      calls.push('loadScene:resetHistory=' + (o ? o.resetHistory : undefined));
      store.state.scene = scene;
      store.state.selection = [];
      return options.warnings || [];
    },
    commit() {
      calls.push('commit:selection=' + store.state.selection.join('|'));
      store.historyIndex += 1;
    },
    shapeById(id) {
      return store.state.scene.shapes.filter((s) => s.id === id)[0] || null;
    },
    historyDepth() { return { index: store.historyIndex, total: store.historyIndex + 1 }; },
    setTool(t) { calls.push('setTool:' + t); store.state.tool = t; }
  };

  const win = {
    Store: store,
    View: { refreshSize() { calls.push('refreshSize'); }, fit() { calls.push('fit'); } },
    UI: { remeasureMissingTexts() { calls.push('remeasure'); }, sync() { calls.push('sync'); } },
    TextDecoder: TextDecoder,
    AbortController: AbortController,
    crypto: { randomUUID() { return 'sess-panel-0001'; } },
    requestAnimationFrame(fn) { setImmediate(fn); },
    // 附件读取用的两个浏览器 API。agent.js 一律走 global.XXX 就是为了能在这儿换掉
    FileReader: function FileReader() {
      const self = this;
      this.result = null;
      function deliver(value) {
        setImmediate(() => {
          if (value == null) { if (self.onerror) self.onerror(); return; }
          self.result = value;
          if (self.onload) self.onload();
        });
      }
      this.readAsDataURL = (file) => deliver(file.__failRead ? null : file.__url);
      this.readAsText = (file) => deliver(file.__failRead ? null : file.__text);
    },
    Image: function Image() {
      const self = this;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      let src = '';
      Object.defineProperty(this, 'src', {
        get() { return src; },
        set(v) {
          src = String(v);
          const m = /IMG(\d+)x(\d+)$/.exec(src);
          setImmediate(() => {
            if (!m) { if (self.onerror) self.onerror(); return; }
            self.naturalWidth = Number(m[1]);
            self.naturalHeight = Number(m[2]);
            if (self.onload) self.onload();
          });
        }
      });
    },
    localStorage: (function () {
      const map = new Map(Object.entries(options.storage || {}));
      return {
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); calls.push('ls:' + k + '=' + v); },
        map: map
      };
    }())
  };

  const docHandlers = {};
  win.document = {
    getElementById(id) { return els[id] || null; },
    createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeEl(tag); },
    querySelector(sel) { return sel === '.app' ? appEl : null; },
    addEventListener(name, fn) { docHandlers[name] = fn; }
  };

  const fetches = [];
  win.fetch = function (url, init) {
    fetches.push({ url: String(url), init: init || null });
    if (String(url).indexOf('/api/agent/config') === 0) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(Object.assign({
          model: 'deepseek-v4-pro', hasApiKey: true, strict: false, maxRounds: 8, reasoningEffort: 'medium'
        }, options.config || {}))
      });
    }
    if (String(url).indexOf('/api/agent/credentials') === 0) {
      if (init && init.method === 'POST') {
        const saved = options.credSave || { status: 200, body: { ok: true, envPath: CRED.envPath,
          baseUrl: DEFAULT_BASE, hasApiKey: true, apiKeyMasked: 'sk-tes…cdef', model: 'deepseek-v4-pro' } };
        return Promise.resolve({
          ok: saved.status < 400, status: saved.status, json: () => Promise.resolve(saved.body)
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(Object.assign({}, CRED, options.cred || {}))
      });
    }
    if (options.reply) return options.reply(init);
    return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: '没有回放数据' }) });
  };

  vm.runInNewContext(HELPER + '\n' + CODE, { window: win, console: console }, { filename: 'agent.js' });
  // agent.js 排在 ui.js 之后加载，所以它的 DOMContentLoaded 也执行在后
  docHandlers.DOMContentLoaded();

  return {
    win: win, els: els, app: appEl, calls: calls, store: store, fetches: fetches,
    lines() { return els['chat-log'].childNodes.map((n) => n.className + '|' + n.textContent); },
    // 思考块的文字在子节点里（假 DOM 不会往上冒 textContent），所以单独取
    thinks() {
      return els['chat-log'].childNodes.filter((n) => n.className === 'think').map((n) => ({
        head: n.childNodes[0].textContent, body: n.childNodes[1].textContent, open: n.open
      }));
    },
    send(text) { els['chat-input'].value = text; els['chat-form'].fire('submit'); },
    /** 走真实路径：给隐藏 input 塞 files 再 fire change，和用户在文件对话框里点确定一样 */
    attach(files, kind) {
      const input = els[kind === 'doc' ? 'file-chat-doc' : 'file-chat-image'];
      input.files = files;
      input.fire('change');
    },
    chips() {
      return els['chat-atts'].childNodes.map((c) => ({
        name: c.childNodes[0].textContent,
        meta: c.childNodes[1].textContent,
        disabled: c.childNodes[2].disabled
      }));
    }
  };
}

/** 让所有已就绪的微任务/setImmediate 跑完 */
async function settle(times) {
  for (let i = 0; i < (times || 24); i++) await new Promise((r) => setImmediate(r));
}

/** 把 SSE 文本切成固定大小的字节块。onChunk 用来在指定位置注入外部改动 */

function makeBody(text, chunkSize, onChunk) {
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  return {
    getReader() {
      return {
        read() {
          if (pos >= bytes.length) return Promise.resolve({ done: true, value: undefined });
          const value = bytes.slice(pos, Math.min(bytes.length, pos + chunkSize));
          pos += value.length;
          if (onChunk) onChunk(pos);
          return Promise.resolve({ done: false, value: value });
        }
      };
    }
  };
}

const SCENE = {
  revision: 4,
  baseRevision: 3,
  scene: {
    width: 800, height: 600, background: '#0f172a',
    shapes: [
      { id: 't1', type: 'rect', x: 40, y: 40, w: 720, h: 8, fill: '#4c8dff' },
      { id: 't2', type: 'text', x: 40, y: 96, w: 420, h: 52, text: '季度回顾', fontSize: 40 }
    ]
  },
  touchedIds: ['t1', 't2', 'ghost'],
  warnings: [],
  notes: ['文字 t2 距右边距只有 12px'],
  refit: false
};

/** 一整条服务端会发的事件流。末尾故意不留空行 —— 尾部冲刷不是可选项 */
function stream(extra) {
  const frames = [
    'event: open\ndata: ' + JSON.stringify({ sessionId: 'sess-panel-0001', model: 'deepseek-v4-pro', baseRevision: 3 }),
    'event: status\ndata: ' + JSON.stringify({ text: '正在规划版面…', phase: true }),
    'event: reasoning\ndata: ' + JSON.stringify({ text: '先算版面：页边距 40，', round: 1 }),
    ': ping',
    'event: reasoning\ndata: ' + JSON.stringify({ text: '内容宽 720。', round: 1 }),
    'event: tool_start\ndata: ' + JSON.stringify({ name: 'set_scene', preview: '重画整幅：2 个图形，画布 800×600' }),
    'event: tool_result\ndata: ' + JSON.stringify({ name: 'set_scene', ok: true, summary: '已重画：2 个图形', notes: [], problems: [] }),
    'event: scene\ndata: ' + JSON.stringify(SCENE),
    'event: delta\ndata: ' + JSON.stringify({ text: '好了，' }),
    'event: delta\ndata: ' + JSON.stringify({ text: '深色底的季度回顾标题页。' }),
    'event: done\ndata: ' + JSON.stringify(Object.assign({ revision: 4, applied: 1, rounds: 2, stuck: false, ms: 1234 }, extra || {}))
  ];
  return frames.join('\n\n');
}

const SSE_OK = { ok: true, status: 200 };

function replyWith(text, chunkSize, onChunk) {
  return () => Promise.resolve(Object.assign({}, SSE_OK, { body: makeBody(text, chunkSize, onChunk) }));
}

test('默认 AI 模式：藏工具栏靠 class，画布取景重算，工具复位到 select', async () => {
  const p = boot();
  await settle();
  assert.ok(p.app.classList.contains('ai-mode'));
  assert.equal(p.els['btn-mode-toggle'].textContent, '手动编辑');
  assert.ok(p.calls.indexOf('setTool:select') >= 0, 'AI 模式下留着画笔工具会剩个十字光标');
  assert.ok(p.calls.indexOf('refreshSize') < p.calls.indexOf('fit'), 'fit 之前必须先刷新 cssW/cssH');
  assert.equal(p.els['chat-hint'].textContent, 'deepseek-v4-pro');
});

test('切到手动编辑：class 摘掉、按钮文案反转、模式写进 localStorage', async () => {
  const p = boot();
  await settle();
  p.els['btn-mode-toggle'].fire('click');
  await settle();
  assert.equal(p.app.classList.contains('ai-mode'), false);
  assert.equal(p.els['btn-mode-toggle'].textContent, 'AI 模式');
  assert.equal(p.win.localStorage.getItem('aipaint:mode:v1'), 'manual');
  assert.equal(p.calls.filter((c) => c === 'fit').length, 2, '每次切模式都要重新取景');
});

test('localStorage 记着手动模式就按手动启动', async () => {
  const p = boot({ storage: { 'aipaint:mode:v1': 'manual' } });
  await settle();
  assert.equal(p.app.classList.contains('ai-mode'), false);
});

test('一轮完整会话：应用顺序固定，选中过滤不存在的 id，日志分类正确', async () => {
  const p = boot({ reply: replyWith(stream(), 8192) });
  await settle();
  p.send('画一张季度回顾标题页');
  await settle();

  const req = JSON.parse(p.fetches[1].init.body);
  assert.equal(p.fetches[1].url, '/api/agent');
  assert.equal(req.baseRevision, 0, '第一次发送时本地版本号是 0');
  assert.deepEqual(req.selection, ['old'], '选中要随请求发上去：「把这个改成红色」靠的是它');

  assert.deepEqual(p.calls.filter((c) => /loadScene|remeasure|commit/.test(c)), [
    'loadScene:resetHistory=false',
    'remeasure',
    'commit:selection=t1|t2'
  ], '顺序错了：先 commit 再设选中的话，⌘Z 回来选中就丢了');
  assert.equal(p.store.state.selection.join('|'), 't1|t2', 'ghost 不在场景里，必须被滤掉');

  const lines = p.lines();
  assert.match(lines[1], /^msg msg-u\|画一张季度回顾标题页$/);
  assert.ok(!lines.some((l) => /正在规划版面/.test(l)), '阶段提示是临时的，画完还挂着就像卡住了');
  assert.ok(lines.some((l) => /^msg msg-s tool\|重画整幅/.test(l)));
  assert.ok(lines.some((l) => /^msg msg-s tool\|已重画：2 个图形/.test(l)), '工具成功也要有个结果行');
  assert.ok(lines.some((l) => /^msg msg-note\|文字 t2/.test(l)), 'auditScene 的提示要露出来');
  const said = lines.filter((l) => /^msg msg-a/.test(l));
  assert.equal(said.length, 1, '流式正文只能有一条气泡');
  assert.equal(said[0], 'msg msg-a|好了，深色底的季度回顾标题页。');
  assert.match(p.els['chat-hint'].textContent, /已应用 1 次改动/);
  assert.match(p.els['chat-hint'].textContent, /2 轮/);

  const think = p.thinks();
  assert.equal(think.length, 1, '一轮思考一块');
  assert.equal(think[0].body, '先算版面：页边距 40，内容宽 720。', '思考过程要原样打出来');
  assert.equal(think[0].head, '思考过程 · ' + think[0].body.length + ' 字',
    '结束后是完成态，字数得和正文一致 —— 折起来之后只剩这个标题');
  assert.equal(think[0].open, true, '默认展开，限高交给 CSS');
});

test('切在任意字节上结果都一样：1/3/7 字节一块 == 一整块', async () => {
  const whole = boot({ reply: replyWith(stream(), 8192) });
  await settle();
  whole.send('画一张季度回顾标题页');
  await settle();
  const want = {
    lines: whole.lines(), calls: whole.calls.slice(),
    scene: whole.store.state.scene, thinks: whole.thinks()
  };

  for (const size of [1, 3, 7]) {
    const p = boot({ reply: replyWith(stream(), size) });
    await settle();
    p.send('画一张季度回顾标题页');
    await settle(80);
    assert.deepEqual(p.lines(), want.lines, size + ' 字节一块时日志不一样了');
    assert.deepEqual(p.thinks(), want.thinks, size + ' 字节一块时思考文本不一样了');
    assert.deepEqual(p.calls, want.calls, size + ' 字节一块时控制流不一样了');
    assert.deepEqual(p.store.state.scene, want.scene);
  }
});

test('阶段提示只活在思考期间：出结果就撤掉', async () => {
  const text = stream();
  const toolAt = new TextEncoder().encode(text.slice(0, text.indexOf('event: tool_start'))).length;
  const snaps = [];
  const hook = { fn: null };
  const p = boot({ reply: replyWith(text, 16, (pos) => { if (hook.fn) hook.fn(pos); }) });
  await settle();
  hook.fn = function (pos) { snaps.push({ pos: pos, lines: p.lines() }); };
  p.send('画一张季度回顾标题页');
  await settle(60);

  const during = snaps.filter((s) => s.pos <= toolAt);
  assert.ok(during.some((s) => s.lines.some((l) => /^msg msg-s phase\|正在规划版面/.test(l))),
    '思考期间必须有个交代，不然十几秒的沉默像卡死');
  assert.ok(snaps[snaps.length - 1].lines.every((l) => !/正在规划版面/.test(l)), '结束时不能还挂着');
  const think = p.thinks();
  assert.equal(think.length, 1);
  assert.equal(think[0].body, '先算版面：页边距 40，内容宽 720。');
});

test('连接断在半路：阶段提示照样撤掉，思考块盖上完成态', async () => {
  const text = stream();
  const cut = text.slice(0, text.indexOf('event: tool_start'));   // 思考完就断
  const p = boot({ reply: replyWith(cut, 8192) });
  await settle();
  p.send('画一张季度回顾标题页');
  await settle();
  assert.ok(p.lines().every((l) => !/正在规划版面/.test(l)), '流没跑完也不能留下临时提示');
  assert.match(p.thinks()[0].head, /^思考过程 · /, '半路断开也得是完成态，不能永远「思考中…」');
  assert.equal(p.els['chat-hint'].textContent, 'deepseek-v4-pro', 'done 没来过，别把「生成中…」留着');
});

test('revision 守卫：生成期间场景被改过就不应用，点「仍然应用」才落盘', async () => {
  const text = stream();
  const sceneAt = new TextEncoder().encode(text.slice(0, text.indexOf('event: scene'))).length;
  const hook = { fn: null };
  const p = boot({ reply: replyWith(text, 16, (pos) => { if (hook.fn) hook.fn(pos); }) });
  await settle();

  let bumped = false;
  hook.fn = function (pos) {
    if (bumped || pos < sceneAt) return;
    bumped = true;
    p.store.historyIndex += 1;   // 另一个标签页 / 拖拽导入 / ⌘Z：总之场景动了
  };
  p.send('画一张季度回顾标题页');
  await settle(60);

  assert.ok(bumped, '钩子没触发，这条测试什么都没验到');
  assert.equal(p.calls.filter((c) => /loadScene|commit/.test(c)).length, 0, 'last-write-wins 会静默毁掉用户的编辑');
  const conflict = p.els['chat-log'].childNodes.filter((n) => /msg-e/.test(n.className))[0];
  assert.ok(conflict, '必须给出一条明确的拒绝');
  assert.match(conflict.textContent, /场景已被手动修改/);

  const btn = conflict.childNodes[0];
  assert.equal(btn.tagName, 'button');
  assert.equal(btn.textContent, '仍然应用');
  btn.fire('click');
  assert.deepEqual(p.calls.filter((c) => /loadScene|remeasure|commit/.test(c)), [
    'loadScene:resetHistory=false', 'remeasure', 'commit:selection=t1|t2'
  ]);
  assert.equal(btn.disabled, true, '别让人点两次');
});

test('生成期间：ai-busy 挂在 .app 上，撤销键被禁，结束后交还给 ui.js', async () => {
  const seen = [];
  const hook = { fn: null };
  const p = boot({ reply: replyWith(stream(), 64, (pos) => { if (hook.fn) hook.fn(pos); }) });
  await settle();
  hook.fn = function () {
    seen.push([p.app.classList.contains('ai-busy'), p.els.undo.disabled, p.els['chat-send'].disabled,
      p.els['btn-agent-stop'].hidden]);
  };
  p.send('画一张季度回顾标题页');
  await settle();
  assert.ok(seen.length > 0);
  assert.deepEqual(seen[0], [true, true, true, false], '生成中：画布上锁、撤销禁用、发送禁用、停止可见');
  assert.equal(p.app.classList.contains('ai-busy'), false);
  assert.equal(p.els.undo.disabled, false);
  assert.equal(p.els['btn-agent-stop'].hidden, true);
  assert.ok(p.calls.lastIndexOf('sync') > p.calls.lastIndexOf('commit:selection=t1|t2'),
    '撤销键的最终状态该由 ui.js 说，不该由面板说');
});

test('点停止：本地补一句「已中断」，画布一个字节都不动', async () => {
  const p = boot({
    reply: (init) => Promise.resolve({
      ok: true, status: 200,
      body: { getReader: () => ({ read: () => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));
        });
      }) }) }
    })
  });
  await settle();
  p.send('画一张季度回顾标题页');
  await settle();
  assert.equal(p.app.classList.contains('ai-busy'), true);

  p.els['btn-agent-stop'].fire('click');
  await settle();
  // 自己 abort 时服务端那条 error 事件是收不到的，这句话只能由本地补
  assert.ok(p.lines().some((l) => /msg-s\|已中断/.test(l)));
  assert.equal(p.calls.filter((c) => /loadScene|commit/.test(c)).length, 0);
  assert.equal(p.app.classList.contains('ai-busy'), false);
  assert.equal(p.els['chat-hint'].textContent, 'deepseek-v4-pro', '别把「生成中…」留在那儿');
});

test('HTTP 错误（409 单飞）原样显示服务端的话，不动画布', async () => {
  const p = boot({
    reply: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: '这个会话正在生成中' }) })
  });
  await settle();
  p.send('再来一张');
  await settle();
  assert.ok(p.lines().some((l) => /msg-e\|这个会话正在生成中/.test(l)));
  assert.equal(p.calls.filter((c) => /loadScene|commit/.test(c)).length, 0);
});

test('没配 API key：发送键锁死，输入不丢，也不会打 /api/agent', async () => {
  const p = boot({ config: { hasApiKey: false } });
  await settle();
  assert.equal(p.els['chat-send'].disabled, true);
  assert.ok(p.els['chat-hint'].classList.contains('warn'), '状态行得看起来像能点');
  assert.ok(p.lines().some((l) => /msg-e\|还没配置模型 API key/.test(l)), '要给配置提示，不是堆栈');
  p.send('画点什么');
  await settle();
  assert.equal(p.fetches.filter((f) => f.url === '/api/agent').length, 0, '没 key 就一次也别打模型端点');
  assert.equal(p.els['chat-input'].value, '画点什么', '话不能白说，得留在输入框里');
});

test('第二次发送带上服务端给的 revision，画布尺寸变了才重新取景', async () => {
  const big = JSON.parse(JSON.stringify(SCENE));
  big.revision = 5;
  big.baseRevision = 4;
  big.refit = true;
  const bodies = [stream(), stream().replace(JSON.stringify(SCENE), JSON.stringify(big))];
  const p = boot({ reply: () => Promise.resolve(Object.assign({}, SSE_OK, { body: makeBody(bodies.shift(), 8192) })) });
  await settle();
  p.send('第一张');
  await settle();
  const fitsBefore = p.calls.filter((c) => c === 'fit').length;
  p.send('把画布改成 1200×675');
  await settle();
  assert.equal(JSON.parse(p.fetches[1].init.body).baseRevision, 0);
  assert.equal(JSON.parse(p.fetches[2].init.body).baseRevision, 4, '第二轮要接着服务端给的 revision 往下走');
  assert.equal(p.calls.filter((c) => c === 'fit').length, fitsBefore + 1, 'refit 才重新取景，否则别动用户的视口');
});

/* ---------- 模型配置浮层 ---------- */

/** 打开浮层并等 GET 回来 */
async function openCfg(p) {
  p.els['chat-hint'].fire('click');
  await settle();
  return {
    wrap: p.els['agent-settings'], base: p.els['cfg-base-url'], key: p.els['cfg-api-key'],
    note: p.els['cfg-note'], save: p.els['cfg-save'], cancel: p.els['cfg-cancel']
  };
}

test('没配过的时候：地址明文预填默认值，key 框是空的', async () => {
  const p = boot({ config: { hasApiKey: false } });
  await settle();
  const d = await openCfg(p);

  assert.equal(d.wrap.hidden, false);
  assert.ok(p.fetches.some((f) => f.url === '/api/agent/credentials' && !f.init));
  assert.equal(d.base.placeholder, DEFAULT_BASE);
  assert.equal(d.base.value, DEFAULT_BASE, '明文写出来，一眼看得出在打哪个端点');
  assert.equal(d.key.value, '', '没配过就没什么可回填的');
  assert.equal(d.key.placeholder, 'sk-…');
  assert.ok(d.base.focused, '打开就该能直接打字');
});

test('已配置：地址明文回填，key 回填成圆点，掩码一处都不出现', async () => {
  const p = boot({ cred: { hasApiKey: true, apiKeyMasked: 'sk-tes…cdef', fromEnvFile: true,
    envExists: true, baseUrl: 'https://proxy.example/v1' } });
  await settle();
  const d = await openCfg(p);
  assert.equal(d.base.value, 'https://proxy.example/v1');
  assert.equal(d.key.value, KEY_DOTS, '密文占位，不是真 key 也不是掩码');
  assert.equal(d.key.placeholder, '留空表示不改');
  assert.ok(!/sk-/.test(d.key.value + '|' + d.key.placeholder + '|' + d.note.textContent),
    '掩码回填进输入框，一保存就会把 sk-tes…cdef 当成真 key 写回去');
  assert.equal(d.note.className, 'modal-note', 'key 就在 .env 里，没什么要警告的');
  assert.match(d.note.textContent, /不动它就直接保存/);
});

test('已配置后原样保存：key 送空串表示不改，等于默认的地址也不落盘', async () => {
  const p = boot({ cred: { hasApiKey: true, apiKeyMasked: 'sk-tes…cdef', fromEnvFile: true,
    envExists: true, baseUrl: DEFAULT_BASE } });
  await settle();
  const d = await openCfg(p);
  assert.equal(d.base.value, DEFAULT_BASE);
  p.els['cfg-form'].fire('submit');
  await settle();

  const post = p.fetches.filter((f) => f.url === '/api/agent/credentials' && f.init && f.init.method === 'POST')[0];
  assert.deepEqual(JSON.parse(post.init.body), { baseUrl: '', apiKey: '' },
    '什么都没动就什么都别改：圆点不是 key，默认地址不用写进 .env');
});

test('聚焦 key 框就把圆点清掉：打出来的是纯粹的新 key', async () => {
  const p = boot({ cred: { hasApiKey: true, apiKeyMasked: 'sk-tes…cdef', fromEnvFile: true, envExists: true } });
  await settle();
  const d = await openCfg(p);
  assert.equal(d.key.value, KEY_DOTS);

  d.key.fire('focus');
  assert.equal(d.key.value, '', '不清掉就会攒成「圆点 + 新字符」');
  d.key.value = 'sk-new-0123456789abcdef';
  p.els['cfg-form'].fire('submit');
  await settle();

  const post = p.fetches.filter((f) => f.url === '/api/agent/credentials' && f.init && f.init.method === 'POST')[0];
  assert.equal(JSON.parse(post.init.body).apiKey, 'sk-new-0123456789abcdef');
});

test('key 来自 shell 时明说写文件没用', async () => {
  const p = boot({ cred: { hasApiKey: true, apiKeyMasked: 'sk-she…llll', fromEnvFile: false, envExists: true } });
  await settle();
  const d = await openCfg(p);
  assert.match(d.note.className, /err/);
  assert.match(d.note.textContent, /shell/);
  assert.match(d.note.textContent, /unset/);
});

test('保存：POST 出去的是原始值，回来就解锁发送键，不用重启', async () => {
  const p = boot({ config: { hasApiKey: false } });
  await settle();
  const d = await openCfg(p);
  assert.equal(p.els['chat-send'].disabled, true);

  d.base.value = ' https://proxy.example/v1 ';
  d.key.value = ' sk-test-0123456789abcdef ';
  p.els['cfg-form'].fire('submit');
  await settle();

  const post = p.fetches.filter((f) => f.url === '/api/agent/credentials' && f.init && f.init.method === 'POST')[0];
  assert.ok(post, '没发出去');
  assert.deepEqual(JSON.parse(post.init.body), {
    baseUrl: 'https://proxy.example/v1', apiKey: 'sk-test-0123456789abcdef'
  }, '两边都要 trim：粘贴 key 时很容易带上空格');

  assert.equal(d.wrap.hidden, true, '存好了就关掉');
  assert.equal(d.key.value, '', '关掉时把 key 从 DOM 里清掉');
  assert.equal(p.els['chat-send'].disabled, false, '存完就该能发，不用重启');
  assert.equal(p.els['chat-hint'].textContent, 'deepseek-v4-pro');
  assert.equal(p.els['chat-hint'].classList.contains('warn'), false);
  assert.ok(!p.lines().some((l) => /还没配置模型 API key/.test(l)),
    '前提没了提示就得撤掉，留着只会让人以为没存上');
  assert.ok(p.lines().some((l) => /msg-s\|凭证已写入 \/tmp\/aipaint\/\.env/.test(l)));
  assert.ok(!p.lines().some((l) => /sk-test-0123456789abcdef/.test(l)), '日志里不许出现原始 key');
});

test('没 key 时按 Enter：提示只留一条能用的，配好之后一条不剩', async () => {
  const p = boot({ config: { hasApiKey: false } });
  await settle();
  p.send('画点什么');       // 发送键是灰的，但 Enter/submit 走的是另一条路
  await settle();
  p.send('再催一次');
  await settle();
  assert.equal(p.els['agent-settings'].hidden, false, '拦下来的同时该把配置弹出来');
  assert.ok(p.lines().filter((l) => /还没配置模型 API key/.test(l)).length >= 2);

  p.els['cfg-api-key'].value = 'sk-test-0123456789abcdef';
  p.els['cfg-form'].fire('submit');
  await settle();
  assert.equal(p.lines().filter((l) => /还没配置模型 API key/.test(l)).length, 0, '几条都得撤掉');
  assert.equal(p.els['chat-send'].disabled, false);
});

test('保存被服务端拒了：原样显示理由，浮层不关，还能改了再存', async () => {
  const p = boot({
    config: { hasApiKey: false },
    credSave: { status: 400, body: { error: 'apiKey 含不允许的字符（只接受字母数字和 _-.:+~/=）' } }
  });
  await settle();
  const d = await openCfg(p);
  d.key.value = 'sk-a"b';
  p.els['cfg-form'].fire('submit');
  await settle();

  assert.equal(d.wrap.hidden, false, '关掉的话用户就得从头再填一遍');
  assert.match(d.note.className, /err/);
  assert.match(d.note.textContent, /不允许的字符/);
  assert.equal(d.save.disabled, false, '得能改了再存');
  assert.equal(p.els['chat-send'].disabled, true, '没存进去就别解锁');
});

test('Esc 和点背景都能关掉，且不把按键漏给画布快捷键', async () => {
  const p = boot();
  await settle();
  const d = await openCfg(p);
  let leaked = true;
  d.wrap.fire('keydown', { key: 'Escape', stopPropagation() { leaked = false; } });
  assert.equal(d.wrap.hidden, true);
  assert.equal(leaked, false, 'Esc 漏给 input.js 会顺手把选中也取消掉');

  await openCfg(p);
  d.wrap.fire('click', { target: d.wrap });
  assert.equal(d.wrap.hidden, true);

  await openCfg(p);
  d.wrap.fire('click', { target: p.els['cfg-form'] });
  assert.equal(d.wrap.hidden, false, '点卡片里面不能关');
  d.cancel.fire('click');
  assert.equal(d.wrap.hidden, true);
});

test('齿轮按钮和状态行是同一个入口', async () => {
  const p = boot();
  await settle();
  p.els['btn-agent-settings'].fire('click');
  await settle();
  assert.equal(p.els['agent-settings'].hidden, false);
});

/* ---------- 附件 ---------- */

test('挂一张图：chip 显示压缩后的尺寸，body 带上 attachments，发出去就清空', async () => {
  const p = boot({ reply: replyWith(stream(), 8192) });
  await settle();
  p.attach([imageFile('ref.png', 4096, 1024)]);
  await settle();

  assert.deepEqual(p.chips(), [{ name: 'ref.png', meta: '2048×512', disabled: false }],
    '长边压到 2048，短边等比跟着走');
  assert.equal(p.els['chat-atts'].hidden, false);

  p.send('用这张图做一张海报');
  await settle();

  const req = JSON.parse(p.fetches[1].init.body);
  assert.equal(req.attachments.length, 1);
  assert.deepEqual(Object.keys(req.attachments[0]).sort(), ['dataUrl', 'h', 'kind', 'mime', 'name', 'w']);
  assert.equal(req.attachments[0].kind, 'image');
  assert.equal(req.attachments[0].w, 2048);
  assert.equal(req.attachments[0].h, 512);
  assert.equal(req.attachments[0].mime, 'image/jpeg', 'PNG 和 JPEG 各编一次，取小的那个');
  assert.ok(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(req.attachments[0].dataUrl),
    '发上去的必须是我们自己的编码器产出的字节，不是用户的原始文件');

  assert.deepEqual(p.chips(), [], '附件只跟着这一次请求走');
  assert.equal(p.els['chat-atts'].hidden, true);
  assert.ok(p.lines().some((l) => l === 'msg msg-s|附件：ref.png'), '日志里要留一条痕迹');
});

test('不带附件时 body 里是空数组，其余字段一个字节都不变', async () => {
  const p = boot({ reply: replyWith(stream(), 8192) });
  await settle();
  p.send('画一张标题页');
  await settle();
  const req = JSON.parse(p.fetches[1].init.body);
  assert.deepEqual(req.attachments, []);
  assert.deepEqual(Object.keys(req).sort(),
    ['attachments', 'baseRevision', 'scene', 'selection', 'sessionId', 'text']);
});

test('满 4 个之后 ＋ 禁用、多选里超出的部分给提示；删掉一个又能加', async () => {
  const p = boot();
  await settle();
  p.attach([imageFile('a.png', 100, 100), imageFile('b.png', 100, 100),
    imageFile('c.png', 100, 100), imageFile('d.png', 100, 100), imageFile('e.png', 100, 100)]);
  await settle();

  assert.deepEqual(p.chips().map((c) => c.name), ['a.png', 'b.png', 'c.png', 'd.png']);
  assert.equal(p.els['btn-chat-plus'].disabled, true);
  assert.ok(p.lines().some((l) => /附件最多 4 个/.test(l)), '静默丢掉第 5 个等于骗用户');

  p.els['chat-atts'].childNodes[1].childNodes[2].fire('click');
  assert.deepEqual(p.chips().map((c) => c.name), ['a.png', 'c.png', 'd.png']);
  assert.equal(p.els['btn-chat-plus'].disabled, false);
});

test('菜单：点 ＋ 开合，点菜单项收起并触发对应的隐藏 input', async () => {
  const p = boot();
  await settle();
  const menu = p.els['chat-menu'];
  assert.equal(menu.hidden, true, '默认收起');

  p.els['btn-chat-plus'].fire('click');
  assert.equal(menu.hidden, false);
  p.els['btn-chat-plus'].fire('click');
  assert.equal(menu.hidden, true, '再点一次收起');

  p.els['btn-chat-plus'].fire('click');
  p.els['btn-att-image'].fire('click');
  assert.equal(menu.hidden, true);
  assert.equal(p.els['file-chat-image'].clicks, 1);
  assert.equal(p.els['file-chat-doc'].clicks, 0, '两个入口不能串台');

  p.els['btn-chat-plus'].fire('click');
  p.els['btn-att-doc'].fire('click');
  assert.equal(p.els['file-chat-doc'].clicks, 1);

  p.els['btn-chat-plus'].fire('click');
  let leaked = true;
  p.els['btn-chat-plus'].fire('keydown', { key: 'Escape', stopPropagation() { leaked = false; } });
  assert.equal(menu.hidden, true);
  assert.equal(leaked, false, 'Esc 漏给 input.js 会顺手取消画布选中');
});

test('生成期间不许改附件：＋ 和 chip 上的 × 一起禁掉', async () => {
  let release = null;
  const p = boot({ reply: () => new Promise((r) => { release = r; }) });
  await settle();
  p.attach([imageFile('a.png', 100, 100)]);
  await settle();
  p.send('画一张海报');
  await settle();

  assert.equal(p.els['btn-chat-plus'].disabled, true);
  p.attach([imageFile('b.png', 100, 100)]);
  await settle();
  assert.deepEqual(p.chips(), [], '这一轮的附件已经发走了，生成中不能再挂新的');

  release(Object.assign({}, SSE_OK, { body: makeBody(stream(), 8192) }));
  await settle();
  assert.equal(p.els['btn-chat-plus'].disabled, false);
});

test('文本附件：超长截断，chip 上写明白', async () => {
  const p = boot({ reply: replyWith(stream(), 8192) });
  await settle();
  p.attach([textFile('notes.md', '要点'.repeat(9000))], 'doc');
  await settle();

  assert.deepEqual(p.chips(), [{ name: 'notes.md', meta: '前 12000 字', disabled: false }]);
  p.send('照这份提纲画');
  await settle();
  const a = JSON.parse(p.fetches[1].init.body).attachments[0];
  assert.equal(a.kind, 'text');
  assert.equal(a.text.length, 12000);
  assert.equal(a.truncated, true);
});

test('读不了的东西一律说清楚，不静默忽略', async () => {
  const p = boot();
  await settle();
  p.attach([textFile('spec.pdf', 'x'), textFile('bin.txt', 'a' + String.fromCharCode(0) + 'b'),
    textFile('empty.txt', '   '), imageFile('huge.png', 100, 100, 40 * 1024 * 1024)], 'doc');
  await settle();

  const log = p.lines().join('\n');
  assert.deepEqual(p.chips(), []);
  assert.ok(/spec\.pdf：PDF \/ Word \/ Excel/.test(log));
  assert.ok(/bin\.txt：这看起来不是纯文本文件/.test(log));
  assert.ok(/empty\.txt：文件是空的/.test(log));
  assert.ok(/huge\.png：文件太大（40\.0MB）/.test(log));
});

test('只挂了附件没打字：不发请求，但说一句为什么', async () => {
  const p = boot();
  await settle();
  p.attach([imageFile('a.png', 100, 100)]);
  await settle();
  p.send('');
  await settle();

  assert.equal(p.fetches.filter((f) => f.url === '/api/agent').length, 0);
  assert.ok(p.lines().some((l) => /说一句要用这些附件做什么/.test(l)));
  assert.deepEqual(p.chips().map((c) => c.name), ['a.png'], '附件不能被这次空发送吃掉');
});

test('粘贴和拖拽是同一条路：剪贴板里的图直接变附件，纯文字不拦', async () => {
  const p = boot();
  await settle();
  let prevented = 0;
  p.els['chat-input'].fire('paste', {
    clipboardData: { files: [imageFile('shot.png', 300, 200)] },
    preventDefault() { prevented += 1; }
  });
  await settle();
  assert.deepEqual(p.chips().map((c) => c.name), ['shot.png']);
  assert.equal(prevented, 1);

  p.els['chat-input'].fire('paste', {
    clipboardData: { files: [] }, preventDefault() { prevented += 1; }
  });
  await settle();
  assert.equal(prevented, 1, '纯文字粘贴必须原样落进输入框');

  p.els['chat-panel'].fire('drop', { dataTransfer: { files: [imageFile('drag.png', 300, 200)] } });
  await settle();
  assert.deepEqual(p.chips().map((c) => c.name), ['shot.png', 'drag.png']);
});
