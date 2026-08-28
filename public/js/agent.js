/**
 * AI 绘图面板：把用户的一句话变成一次 /api/agent 的 SSE 会话，
 * 再把服务端算好的场景落进 Store。
 *
 * 三条硬约束，写的时候别绕开：
 * 1. 绝不 Store.on()。store.js 没有反注册，而拖拽时每次 pointermove 都 emit。
 *    要读场景就现读 Store.state.scene，要写就走 Store.loadScene。
 * 2. 应用顺序是固定的：loadScene(resetHistory:false) → 补量文字 → 设选中 → commit。
 *    先 commit 再设选中，选中就不在快照里，⌘Z 回来会丢。
 * 3. 服务端度量出来的文字尺寸就是导出用的那一份，只补缺失，绝不全量重测。
 *
 * 本文件排在 ui.js 之后加载，于是自己的 DOMContentLoaded 也注册在后、执行在后 ——
 * 跑到这里 View.init 已经完成，refreshSize/fit 可以直接调。
 */
(function (global) {
  'use strict';
  var Store = global.Store;
  var View = global.View;

  var MODE_KEY = 'aipaint:mode:v1';
  var SCENE_KEY = 'aipaint:scene:v1';   // store.js 的持久化键，这里只读
  var MAX_LOG = 400;

  var els = {};
  var dlg = {};          // 配置浮层的节点。缺了只关掉这个功能，面板照常能用
  var dlgOk = false;
  var cfg = { hasApiKey: false, model: '', maxRounds: 8 };
  var mode = 'ai';
  var run = null;        // 正在进行的会话：{ controller, streamEl, applied }
  var guard = null;      // 发送那一刻的场景指纹
  var revision = 0;      // 本地场景版本号，随请求发给服务端并在 scene 事件里回显
  var sessionId = uuid();

  function $(id) { return global.document.getElementById(id); }

  function uuid() {
    var c = global.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function app() { return global.document.querySelector('.app'); }

  /* ---------- 会话日志 ---------- */

  /** 粘底滚动：必须在改动之前测，本来就在底部才跟着走 */
  function keepBottom(fn) {
    var log = els.log;
    var bottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    fn();
    if (bottom) log.scrollTop = log.scrollHeight;
  }

  function append(el) {
    keepBottom(function () {
      els.log.appendChild(el);
      while (els.log.childNodes.length > MAX_LOG) els.log.removeChild(els.log.firstChild);
    });
    return el;
  }

  /** 一律 textContent + white-space:pre-wrap：不引 markdown 库，从构造上没有 XSS */
  function msg(cls, text) {
    var el = global.document.createElement('div');
    el.className = cls;
    el.textContent = text;
    return append(el);
  }

  function sys(text) { return msg('msg msg-s', text); }
  function tool(text) { return msg('msg msg-s tool', text); }
  function note(text) { return msg('msg msg-note', text); }
  function hint(text) { els.hint.textContent = text; }

  /** 给日志里的消息挂一个按钮：出错时告诉用户能干什么，比只报错有用 */
  function action(box, label, fn) {
    var btn = global.document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', function () { fn(btn); });
    box.appendChild(btn);
    return btn;
  }

  function fail(text) {
    if (run && run.streamEl) run.streamEl.classList.remove('streaming');
    settled();
    msg('msg msg-e', text);
  }

  /* ---------- 阶段提示与思考过程 ---------- */

  /**
   * 阶段提示（status 带 phase）是临时的：一次会话只占一行、原地改写，
   * 一旦有正文或工具动作就撤掉 —— 否则「正在规划版面…」会在画完之后继续挂在
   * 日志里，看起来像卡住了。不带 phase 的 status 是事实陈述，照旧留着。
   */
  function phase(text) {
    if (!run) { sys(text); return; }
    if (run.phaseEl && run.phaseEl.parentNode === els.log) { run.phaseEl.textContent = text; return; }
    run.phaseEl = msg('msg msg-s phase', text);
  }

  function clearPhase() {
    if (!run || !run.phaseEl) return;
    if (run.phaseEl.parentNode === els.log) els.log.removeChild(run.phaseEl);
    run.phaseEl = null;
  }

  /** 折起来之后还得看得出这块是什么、有多长，所以字数写进标题 */
  function thinkLabel(done) {
    var round = run.thinkRound > 1 ? '（第 ' + run.thinkRound + ' 轮）' : '';
    run.thinkHead.textContent = (done ? '思考过程' : '思考中…') + round + ' · ' + run.thinkChars + ' 字';
  }

  function newThink(round) {
    var box = global.document.createElement('details');
    box.className = 'think';
    box.open = true;
    var head = global.document.createElement('summary');
    var body = global.document.createElement('div');
    body.className = 'think-body';
    box.appendChild(head);
    box.appendChild(body);
    run.thinkEl = box;
    run.thinkHead = head;
    run.thinkBody = body;
    run.thinkRound = round;
    run.thinkChars = 0;
    thinkLabel(false);
    append(box);
  }

  /**
   * 思考过程：一轮一块。<details> 默认展开、CSS 限高、内层自己跟到底部 ——
   * 长思考在 360px 宽的面板里是一整屏墙，限高加可折叠比“全铺开”能读。
   * 服务端要关掉这条流是 AGENT_STREAM_REASONING=0，那时只剩上面的阶段提示。
   */
  function think(text, round) {
    if (!text || !run) return;
    if (!run.thinkEl || run.thinkRound !== round) newThink(round);
    run.thinkChars += text.length;
    keepBottom(function () {
      run.thinkBody.textContent += text;
      thinkLabel(false);
      run.thinkBody.scrollTop = run.thinkBody.scrollHeight;   // 限高之后内层也得跟到底
    });
  }

  /** 这一轮的思考结束了：只改标题。内容留着 —— 用户要的就是能看见它 */
  function sealThink() {
    if (run && run.thinkEl) thinkLabel(true);
  }

  /** 有正文或工具动作 = 规划阶段过去了：撤掉阶段提示、给思考块盖上完成态。
   *  刻意不碰 streamEl 的 streaming 类 —— 每个 delta 都会走到这里，
   *  在这儿摘光标会让它在第二个 chunk 就消失。 */
  function settled() {
    clearPhase();
    sealThink();
  }

  /* ---------- 竞态守卫 ---------- */

  /**
   * 发送那一刻的场景指纹。两项：撤销栈位置抓本标签页的手动提交（含拖拽导入、⌘Z），
   * localStorage 里场景 JSON 的长度抓另一个标签页的改动。
   * 只留长度不留整串 —— 带 6MB base64 的场景不该在内存里多一份拷贝；
   * 代价是「长度恰好没变」的改动会漏检，这是刻意的取舍。
   */
  function stamp() {
    var raw = '';
    try { raw = global.localStorage.getItem(SCENE_KEY) || ''; } catch (err) { raw = ''; }
    return { index: Store.historyDepth().index, size: raw.length };
  }

  function sameStamp(a, b) {
    return !!a && !!b && a.index === b.index && a.size === b.size;
  }

  /* ---------- 应用场景 ---------- */

  function commitScene(data) {
    var warnings = Store.loadScene(data.scene, { resetHistory: false });
    if (global.UI && global.UI.remeasureMissingTexts) global.UI.remeasureMissingTexts();
    Store.state.selection = (data.touchedIds || []).filter(function (id) {
      return !!Store.shapeById(id);
    });
    Store.commit();
    revision = data.revision;
    guard = stamp();
    if (run) { run.applied += 1; lockDoc(true); }   // commit 触发的 UI.sync 会把撤销键放回来
    if (data.refit) refit();
    if (warnings.length) {
      note('本地校验修正了 ' + warnings.length + ' 处：' + warnings[0]);
    }
    var notes = data.notes || [];
    for (var i = 0; i < notes.length; i++) note(notes[i]);
  }

  function applyScene(data) {
    if (sameStamp(stamp(), guard)) { commitScene(data); return; }
    var box = msg('msg msg-e', '场景已被手动修改，AI 结果未应用。');
    action(box, '仍然应用', function (btn) {
      btn.disabled = true;
      commitScene(data);
      sys('已用 AI 结果覆盖当前场景');
    });
  }

  /**
   * fit() 读的 cssW/cssH 只在 render() 顶部的 resize() 里刷新，所以要等一帧、
   * 而且先 refreshSize 再 fit。ResizeObserver 只保证 backing store 是对的。
   */
  function refit() {
    global.requestAnimationFrame(function () { View.refreshSize(); View.fit(); });
  }

  /* ---------- SSE ---------- */

  /**
   * 帧循环：按 \n\n 切，最后一段回写缓冲（它可能被切在中间），done 之后冲刷尾部。
   * 服务端最后一帧后面不一定有空行，尾部冲刷不是可选项。
   */
  async function readSSE(res, onEvent) {
    var reader = res.body.getReader();
    var decoder = new global.TextDecoder();
    var buffer = '';
    for (;;) {
      var step = await reader.read();
      if (step.value) buffer += decoder.decode(step.value, { stream: true });
      var frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (var i = 0; i < frames.length; i++) handleFrame(frames[i], onEvent);
      if (step.done) break;
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleFrame(buffer, onEvent);
  }

  function handleFrame(frame, onEvent) {
    var name = '';
    var raw = '';
    var lines = frame.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('event: ') === 0) name = line.slice(7).trim();
      else if (line.indexOf('data: ') === 0) raw += line.slice(6);
      // ': ping' 这类注释帧直接落地不管
    }
    if (!name) return;
    var data = null;
    if (raw) { try { data = JSON.parse(raw); } catch (err) { return; } }
    onEvent(name, data || {});
  }

  function onEvent(name, data) {
    if (name === 'open') {
      hint((data.model || cfg.model) + ' · 生成中…');
    } else if (name === 'status') {
      if (data.phase) phase(data.text || '');
      else sys(data.text || '');
    } else if (name === 'reasoning') {
      think(data.text || '', data.round || 1);
    } else if (name === 'delta') {
      settled();
      stream(data.text || '');
    } else if (name === 'tool_start') {
      settled();
      tool(data.preview || data.name || '');
    } else if (name === 'tool_result') {
      if (data.ok) tool(data.summary || '');
      else note('模型自查未通过（' + (data.problems || []).length + ' 处），正在修正：' + (data.summary || ''));
    } else if (name === 'scene') {
      applyScene(data);
    } else if (name === 'error') {
      if (data.aborted) sys('已中断，画布保持在上一次应用的状态');
      else fail(data.message || '生成失败');
    } else if (name === 'done') {
      finish(data);
    }
  }

  function stream(text) {
    if (!text || !run) return;
    if (!run.streamEl) run.streamEl = msg('msg msg-a streaming', '');
    keepBottom(function () { run.streamEl.textContent += text; });
  }

  function finish(data) {
    if (run) run.done = true;
    if (run && run.streamEl) run.streamEl.classList.remove('streaming');
    settled();
    if (data.stuck) note('模型没能自己改对，已停下。换个说法或说得更具体一点再试。');
    var parts = [cfg.model || 'deepseek'];
    parts.push(data.applied ? '已应用 ' + data.applied + ' 次改动' : '画布未改动');
    if (data.rounds) parts.push(data.rounds + ' 轮');
    if (data.ms) parts.push((data.ms / 1000).toFixed(1) + 's');
    hint(parts.join(' · '));
  }

  /* ---------- 附件 ---------- */

  /**
   * 附件有两个互不相干的用途，别把它们混成一件事：
   *  - 图片会被服务端注册成一个新的 srcRef（up1、up2…），于是模型能把它摆进画布 ——
   *    这是「AI 画的图里能有真实照片」的唯一途径；
   *  - 文本会被拼进这一轮的提示，当资料用。
   * 两者都只跟着这一次请求走：发出去就清空，不在会话里累积。
   */
  var MAX_ATTS = 4;
  var MAX_IMG_CHARS = 3 * 1024 * 1024;    // 压缩后的 data URL，和服务端那道校验同一个数
  var MAX_DOC_CHARS = 12000;
  var NO_TEXT_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z)$/i;

  var att = {};          // 附件相关节点。缺了只关掉这个功能，面板照常能用
  var attOk = false;
  var atts = [];         // 当前挂着的附件，最多 MAX_ATTS 个

  function isImage(file) { return /^image\//.test(file.type || ''); }

  /** 二进制当文本读出来是一屏乱码，还会白烧 token。NUL 和控制字符是最省事的判据 */
  function looksBinary(text) {
    return /[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 2000));
  }

  /** 压缩规则和「为什么一律重编码」都在 imagefile.js 里；这儿只把它拼成协议要的形状 */
  function readImage(file) {
    return global.ImageFile.downscale(file).then(function (out) {
      if (out.dataUrl.length > MAX_IMG_CHARS) {
        throw new Error('压到 ' + out.w + '×' + out.h + ' 还是太大，请先自己压一下');
      }
      return {
        kind: 'image', name: file.name || '图片', mime: out.mime,
        dataUrl: out.dataUrl, w: out.w, h: out.h
      };
    });
  }

  function readDoc(file) {
    return new Promise(function (resolve, reject) {
      if (NO_TEXT_RE.test(file.name || '')) {
        reject(new Error('PDF / Word / Excel 这类格式读不了，先另存成 .txt 或 .md'));
        return;
      }
      var reader = new global.FileReader();
      reader.onerror = function () { reject(new Error('读不出这个文件')); };
      reader.onload = function () {
        var raw = String(reader.result || '');
        if (!raw.trim()) { reject(new Error('文件是空的')); return; }
        if (looksBinary(raw)) { reject(new Error('这看起来不是纯文本文件')); return; }
        var cut = raw.length > MAX_DOC_CHARS;
        resolve({
          kind: 'text', name: file.name || '文件', mime: file.type || 'text/plain',
          text: cut ? raw.slice(0, MAX_DOC_CHARS) : raw, truncated: cut
        });
      };
      reader.readAsText(file);
    });
  }

  async function addFiles(list) {
    if (!attOk || run || !list) return;
    var files = [];
    for (var i = 0; i < list.length; i++) files.push(list[i]);
    for (var j = 0; j < files.length; j++) {
      var f = files[j];
      if (atts.length >= MAX_ATTS) { note('附件最多 ' + MAX_ATTS + ' 个，剩下的没加上。'); break; }
      // 上限跟压缩器共用一个数：图片和文本都在读之前先拦一道，别让 40MB 进 FileReader
      var cap = global.ImageFile.MAX_SRC_BYTES;
      if (f.size > cap) {
        note(f.name + '：文件太大（' + (f.size / 1048576).toFixed(1) + 'MB），上限 ' +
          (cap / 1048576) + 'MB。');
        continue;
      }
      try {
        atts.push(await (isImage(f) ? readImage(f) : readDoc(f)));
      } catch (err) {
        note((f.name || '附件') + '：' + (err && err.message ? err.message : String(err)));
      }
      renderAtts();
    }
    renderAtts();
  }

  function dropAtt(a) {
    var i = atts.indexOf(a);
    if (i >= 0) atts.splice(i, 1);
    renderAtts();
  }

  function chip(a) {
    var box = global.document.createElement('span');
    box.className = 'chat-att';
    var name = global.document.createElement('span');
    name.className = 'name';
    name.textContent = a.name;
    var meta = global.document.createElement('span');
    meta.className = 'meta';
    meta.textContent = a.kind === 'image'
      ? a.w + '×' + a.h
      : (a.truncated ? '前 ' + a.text.length + ' 字' : a.text.length + ' 字');
    var x = global.document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = '移除';
    x.disabled = !!run;
    x.addEventListener('click', function () { dropAtt(a); });
    box.appendChild(name);
    box.appendChild(meta);
    box.appendChild(x);
    return box;
  }

  /** 整条重画。附件最多 4 个，没有增量更新的必要 */
  function renderAtts() {
    if (!attOk) return;
    while (att.strip.firstChild) att.strip.removeChild(att.strip.firstChild);
    for (var i = 0; i < atts.length; i++) att.strip.appendChild(chip(atts[i]));
    att.strip.hidden = atts.length === 0;
    var full = atts.length >= MAX_ATTS;
    att.plus.disabled = !!run || full;
    att.plus.title = full ? '附件已达上限（' + MAX_ATTS + ' 个）' : '添加文件和工具';
    if (att.plus.disabled) closeMenu();
  }

  function openMenu() { if (attOk && !att.plus.disabled) att.menu.hidden = false; }
  function closeMenu() { if (attOk) att.menu.hidden = true; }

  function pick(input) {
    closeMenu();
    input.click();
  }

  /**
   * 附件是可选功能：节点缺了就只把 ＋ 藏掉，面板照常能用。
   * 不把这些 id 塞进 els —— init() 那句 `for (var k in els) if (!els[k]) return;` 是全有全无的，
   * 往里加一个 id 就等于给整个面板加一个新的静默失效条件。
   */
  function initAtts() {
    att = {
      strip: $('chat-atts'), plus: $('btn-chat-plus'), menu: $('chat-menu'),
      mImg: $('btn-att-image'), mDoc: $('btn-att-doc'),
      fImg: $('file-chat-image'), fDoc: $('file-chat-doc')
    };
    attOk = true;
    for (var a in att) if (!att[a]) attOk = false;
    if (!global.ImageFile) attOk = false;   // 压缩器没加载上，图片这条路就是断的
    if (!attOk) {
      if (att.plus) att.plus.hidden = true;
      return;
    }

    att.plus.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (att.menu.hidden) openMenu(); else closeMenu();
    });
    att.mImg.addEventListener('click', function () { pick(att.fImg); });
    att.mDoc.addEventListener('click', function () { pick(att.fDoc); });
    // value 每次都要清掉，否则连着选同一个文件不会再触发 change
    att.fImg.addEventListener('change', function () { addFiles(att.fImg.files); att.fImg.value = ''; });
    att.fDoc.addEventListener('change', function () { addFiles(att.fDoc.files); att.fDoc.value = ''; });
    // 点别处收起来。＋ 自己的 click 已经 stopPropagation，所以不会开完立刻被关掉
    global.document.addEventListener('click', function () { closeMenu(); });
    att.plus.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); }
    });

    // 两个零成本入口。剪贴板里有图就当上传：截图 → ⌘V 是最顺的一条路
    els.input.addEventListener('paste', function (ev) {
      var files = ev.clipboardData && ev.clipboardData.files;
      if (!files || !files.length) return;
      var imgs = [];
      for (var i = 0; i < files.length; i++) if (isImage(files[i])) imgs.push(files[i]);
      if (!imgs.length) return;
      ev.preventDefault();
      addFiles(imgs);
    });
    els.panel.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    els.panel.addEventListener('drop', function (ev) {
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (!files || !files.length) return;
      ev.preventDefault();
      addFiles(files);
    });

    closeMenu();     // 标记里就是 hidden 的，这儿只是把它当不变式钉住
    renderAtts();
  }

  /* ---------- 发送 ---------- */

  var DOC_BTNS = ['undo', 'redo', 'btn-clear', 'btn-import-json'];

  /** 生成期间禁掉会改场景的文档级控件。画布本身由 .app.ai-busy 的 pointer-events 挡住 */
  function lockDoc(on) {
    for (var i = 0; i < DOC_BTNS.length; i++) {
      var b = $(DOC_BTNS[i]);
      if (b) b.disabled = on;
    }
  }

  function setBusy(on) {
    app().classList.toggle('ai-busy', on);
    els.stop.hidden = !on;
    els.stop.disabled = false;
    els.send.textContent = on ? '■' : '↑';
    els.send.title = on ? '停止生成' : '发送';
    if (els.send.setAttribute) els.send.setAttribute('aria-label', on ? '停止生成' : '发送');
    if (els.send.classList) els.send.classList.toggle('is-stop', on);
    els.send.disabled = on || !cfg.hasApiKey;
    lockDoc(on);
    renderAtts();                                                // 生成期间不许改附件
    if (!on && global.UI && global.UI.sync) global.UI.sync();   // 把撤销键的状态交还给 ui.js
  }

  async function send(text, files) {
    if (run) return;
    var controller = new global.AbortController();
    run = {
      controller: controller, streamEl: null, applied: 0, done: false,
      phaseEl: null,                                  // 临时的阶段提示，结束时撤掉
      thinkEl: null, thinkHead: null, thinkBody: null, thinkRound: 0, thinkChars: 0
    };
    guard = stamp();
    msg('msg msg-u', text);
    if (files.length) sys('附件：' + files.map(function (a) { return a.name; }).join('、'));
    setBusy(true);
    try {
      var requestBody = {
        sessionId: sessionId,
        text: text,
        baseRevision: revision,
        selection: Store.state.selection.slice(),
        scene: Store.state.scene,
        attachments: files
      };
      var selectedModel = els.model ? els.model.value : '';
      if (selectedModel && selectedModel !== cfg.model) requestBody.model = selectedModel;
      var res = await global.fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      if (!res.ok || !res.body) {
        var info = null;
        try { info = await res.json(); } catch (err) { info = null; }
        fail((info && info.error) || ('请求失败：HTTP ' + res.status));
        return;
      }
      await readSSE(res, onEvent);
    } catch (err) {
      // 自己 abort 的话服务端那条 error 事件是收不到的（socket 已经断了），
      // 所以「已中断」这句话必须由本地补上
      if (controller.signal.aborted) sys('已中断，画布保持在上一次应用的状态');
      else fail('连接中断：' + (err && err.message ? err.message : String(err)));
    } finally {
      if (!run.done) hint(cfg.model || ''); // 状态行由 CSS 隐藏模型名称
      settled();                              // 连接断在半路时也不能留下「正在规划版面…」
      run = null;
      setBusy(false);
    }
  }

  function submit() {
    var text = els.input.value.trim();
    if (run) return;
    if (!text) {
      if (atts.length) note('说一句要用这些附件做什么，再发送。');
      return;
    }
    // 发送键这时候是灰的，但 Enter 走的是这条路，所以拦一次并顺手把配置弹出来
    if (!cfg.hasApiKey) {
      askForKey('还没配置模型 API key，先填一下。');
      openSettings();
      return;
    }
    els.input.value = '';
    // 附件只跟着这一次请求走。和输入框同时清空：语义一致，也不会在下一轮被重复计费
    var files = atts.slice();
    atts.length = 0;
    renderAtts();
    send(text, files);
  }

  /* ---------- 模式切换 ---------- */

  /**
   * 入口只有这一个控件，所以没有跨控件状态同步的问题。
   * 藏的是左侧工具栏和右侧属性面板；顶栏整条留着 —— 画布尺寸、撤销、缩放、导出
   * 在 agent 驱动时同样有意义。而且只能用 CSS 藏：ui.js 在注册监听之前无保护地取
   * 约 35 个 id，删掉任何一个节点都会让 init() 抛出，结果是一块没有监听的死画布。
   */
  function setMode(next) {
    mode = next === 'manual' ? 'manual' : 'ai';
    app().classList.toggle('ai-mode', mode === 'ai');
    els.toggle.textContent = mode === 'ai' ? '手动编辑' : 'AI 模式';
    els.toggle.title = mode === 'ai' ? '调出手动编辑工具' : '回到 AI 绘图';
    if (mode === 'ai') Store.setTool('select');   // 免得手动模式选的画笔留着十字光标
    try { global.localStorage.setItem(MODE_KEY, mode); } catch (err) { /* 隐私模式忽略 */ }
    refit();                                      // 面板出现/消失让 .stage 变宽变窄
  }

  /* ---------- 模型配置 ---------- */

  var CRED_URL = '/api/agent/credentials';
  var needKey = [];   // 「还没配置 key」那几条提示。前提没了就得撤掉
  var defBase = 'https://api.deepseek.com';   // 服务端给的默认地址，保存时用来判「等于默认」

  /**
   * 已配置时放进 key 输入框的一串定长圆点。这样「已经配好了」看得见，而 DOM 里
   * 又不出现真 key，连掩码都不出现。保存时原样等于它就当「不改」；聚焦即清空，
   * 所以不会攒成「圆点 + 新字符」；万一还是漏出去，服务端的字符白名单也会直接拒掉。
   */
  var KEY_DOTS = '••••••••••••';

  function cfgNote(text, cls) {
    dlg.note.textContent = text;
    dlg.note.className = 'modal-note' + (cls ? ' ' + cls : '');
  }

  /** 缺 key 的提示 + 「现在配置」按钮，记下来好在配好之后撤掉 */
  function askForKey(text) {
    var box = msg('msg msg-e', text);
    if (dlgOk) action(box, '现在配置', openSettings);
    needKey.push(box);
    return box;
  }

  /** 配好了就把那几条红字撤掉 —— 留在日志里只会让人以为没存上 */
  function clearAskForKey() {
    for (var i = 0; i < needKey.length; i++) {
      var box = needKey[i];
      if (box && box.parentNode === els.log) els.log.removeChild(box);
    }
    needKey.length = 0;
  }

  /** 有没有 key 决定发送键和状态行两处，判断只留一份 */
  function applyKeyState() {
    els.hint.classList.toggle('warn', !cfg.hasApiKey);
    els.send.disabled = !cfg.hasApiKey || !!run;
    hint(cfg.hasApiKey ? cfg.model : '未配置模型 API key，点这里配置');
    if (cfg.hasApiKey) clearAskForKey();
  }

  /**
   * 打开就去拉一次当前配置。地址明文回填（包括默认值）—— 一眼看得出现在到底在打哪个
   * 端点。key 只回填成一串圆点：真 key 和掩码都不进 DOM，也就不可能被「原样保存」
   * 当成新 key 写回 .env。
   */
  async function openSettings() {
    if (!dlgOk) return;
    dlg.wrap.hidden = false;
    dlg.key.value = '';
    cfgNote('正在读取当前配置…', '');
    dlg.base.focus();

    var info;
    try {
      info = await (await global.fetch(CRED_URL)).json();
    } catch (err) {
      cfgNote('读不到当前配置：' + (err && err.message ? err.message : String(err)), 'err');
      return;
    }
    if (dlg.wrap.hidden) return;   // 请求飞行期间被关掉了，别再往上写

    defBase = info.baseUrlDefault || defBase;
    dlg.base.placeholder = defBase;
    dlg.base.value = info.baseUrl || defBase;
    dlg.key.value = info.hasApiKey ? KEY_DOTS : '';
    dlg.key.placeholder = info.hasApiKey ? '留空表示不改' : 'sk-…';
    if (info.hasApiKey && !info.fromEnvFile) {
      // shell 里的变量盖过文件，这时候写 .env 是白写，必须说清楚
      cfgNote('当前 key 来自 shell 环境变量，优先级比 .env 高。要用文件里的值，得先在 shell 里 unset DEEPSEEK_API_KEY 再重启。', 'err');
    } else {
      cfgNote((info.hasApiKey ? 'key 已配置，不动它就直接保存。' : '') +
        '保存后立即生效，不用重启。文件按 0600 写，只有你自己能读。', '');
    }
  }

  function closeSettings() {
    if (!dlgOk) return;
    dlg.wrap.hidden = true;
    dlg.key.value = '';   // 别把 key 留在 DOM 里
  }

  async function saveSettings() {
    if (!dlgOk || dlg.save.disabled) return;
    // 等于默认地址就当没填：.env 里不留一行等于默认值的配置。
    // 圆点没被动过就是「不改 key」，服务端收到空串会绕开原来那行。
    var base = dlg.base.value.trim();
    var key = dlg.key.value === KEY_DOTS ? '' : dlg.key.value.trim();
    dlg.save.disabled = true;
    cfgNote('正在写入…', '');
    try {
      var res = await global.fetch(CRED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: base === defBase ? '' : base, apiKey: key })
      });
      var info = null;
      try { info = await res.json(); } catch (err) { info = null; }
      if (!res.ok || !info || !info.ok) {
        cfgNote((info && info.error) || ('保存失败：HTTP ' + res.status), 'err');
        return;
      }
      cfg.hasApiKey = !!info.hasApiKey;
      cfg.model = info.model || cfg.model;
      applyKeyState();
      closeSettings();
      sys('凭证已写入 ' + info.envPath + '，已生效。当前：' + info.baseUrl +
        (info.hasApiKey ? ' · key ' + info.apiKeyMasked : ''));
    } catch (err) {
      cfgNote('保存失败：' + (err && err.message ? err.message : String(err)), 'err');
    } finally {
      dlg.save.disabled = false;
    }
  }

  /* ---------- 启动 ---------- */

  async function loadConfig() {
    try {
      var res = await global.fetch('/api/agent/config');
      var info = await res.json();
      cfg.hasApiKey = !!info.hasApiKey;
      cfg.model = info.model || '';
      setModelOptions([cfg.model], cfg.model);
      cfg.maxRounds = info.maxRounds || 8;
    } catch (err) {
      cfg.hasApiKey = false;
    }
    applyKeyState();
    loadModels();
    if (!cfg.hasApiKey) {
      askForKey('还没配置模型 API key，AI 绘图暂时用不了。\n填一下就能开始，也可以点顶栏「手动编辑」自己画。');
    }
  }

  function setModelOptions(models, selected) {
    if (!els.model) return;
    while (els.model.firstChild) els.model.removeChild(els.model.firstChild);
    var seen = {};
    models.forEach(function (id) {
      if (!id || seen[id]) return;
      seen[id] = true;
      var option = global.document.createElement('option');
      option.value = id;
      option.textContent = id;
      els.model.appendChild(option);
    });
    if (selected) els.model.value = selected;
    els.model.disabled = els.model.options.length === 0;
  }

  async function loadModels() {
    if (!els.model) return;
    try {
      els.model.disabled = true;
      var res = await global.fetch('/api/agent/models');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var info = await res.json();
      var models = (info.data || []).map(function (item) {
        return typeof item === 'string' ? item : item && item.id;
      });
      setModelOptions(models, cfg.model);
    } catch (err) {
      setModelOptions([cfg.model], cfg.model);
    }
  }

  function init() {
    els = {
      panel: $('chat-panel'), log: $('chat-log'), form: $('chat-form'), input: $('chat-input'),
      send: $('chat-send'), hint: $('chat-hint'), stop: $('btn-agent-stop'), toggle: $('btn-mode-toggle')
    };
    for (var k in els) if (!els[k]) return;   // 结构缺了就整块不启动，绝不连累已经跑好的 ui.js
    els.model = $('chat-model');

    dlg = {
      wrap: $('agent-settings'), form: $('cfg-form'), base: $('cfg-base-url'), key: $('cfg-api-key'),
      note: $('cfg-note'), cancel: $('cfg-cancel'), save: $('cfg-save')
    };
    dlgOk = true;
    for (var d in dlg) if (!dlg[d]) dlgOk = false;

    var gear = $('btn-agent-settings');
    if (gear) {
      if (dlgOk) gear.addEventListener('click', openSettings);
      else gear.hidden = true;
    }
    if (dlgOk) {
      dlg.form.addEventListener('submit', function (ev) { ev.preventDefault(); saveSettings(); });
      dlg.cancel.addEventListener('click', closeSettings);
      // 一聚焦就把占位圆点清掉：接着打字得到的是纯粹的新 key，不会是「圆点 + 新字符」。
      // 清空之后原地不动地关掉浮层也无所谓 —— 空串和圆点都表示「不改」。
      dlg.key.addEventListener('focus', function () {
        if (dlg.key.value === KEY_DOTS) dlg.key.value = '';
      });
      // 点背景（不是卡片本身）关掉
      dlg.wrap.addEventListener('click', function (ev) { if (ev.target === dlg.wrap) closeSettings(); });
      // 焦点在浮层里时 Esc 关闭，并且不让这个键漏给 input.js 的画布快捷键
      dlg.wrap.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { ev.stopPropagation(); closeSettings(); }
      });
      els.hint.addEventListener('click', openSettings);
    }

    els.toggle.addEventListener('click', function () { setMode(mode === 'ai' ? 'manual' : 'ai'); });
    els.stop.addEventListener('click', function () {
      if (!run) return;
      els.stop.disabled = true;
      run.controller.abort();
    });
    els.send.addEventListener('click', function (ev) {
      if (!run) return;
      ev.preventDefault();
      els.stop.click();
    });
    els.form.addEventListener('submit', function (ev) { ev.preventDefault(); submit(); });
    els.input.addEventListener('keydown', function (ev) {
      // 输入法组合期间的 Enter 是在选字，不能当发送
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); }
    });

    initAtts();

    var saved = null;
    try { saved = global.localStorage.getItem(MODE_KEY); } catch (err) { saved = null; }
    setMode(saved === 'manual' ? 'manual' : 'ai');
    sys('说想画什么就行，例如「做一张 1200×675 的三栏产品对比图」。⇧Enter 换行。');
    loadConfig();
  }

  global.Agent = { mode: function () { return mode; }, sessionId: function () { return sessionId; } };
  global.document.addEventListener('DOMContentLoaded', init);
})(window);
