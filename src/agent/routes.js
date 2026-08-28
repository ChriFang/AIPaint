'use strict';
/**
 * agent 的两个端点。
 *
 * 安全前提变了，所以这里必须加校验：server.js 绑 127.0.0.1 且无鉴权，
 * 当初最坏后果是渲一张 PNG；现在这个端点会花用户 API key 的钱，
 * 机器上任何进程、任何页面都能烧 token。跨域 JSON POST 事实上已被预检挡住，
 * 但那是「项目没设 CORS 头」的巧合，不是有意的防护 —— 于是显式校验 Origin/Host。
 */
const express = require('express');
const CONFIG = require('./config.js');
const SESSION = require('./session.js');
const ENV_FILE = require('./env-file.js');
const { createMeasure } = require('./measure.js');

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_TEXT = 16000;
const HEARTBEAT_MS = 15000;

/* 附件上限。宁可 400 也不静默丢弃：这个端点花的是用户 API key 的钱，
 * 一个悄悄被忽略的附件会让用户以为模型看过了，然后对着结果纳闷。 */
const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_CHARS = 3 * 1024 * 1024;      // 压缩后的 data URL；浏览器那边已经把长边压到 2048
const MAX_DOC_CHARS = 12000;                  // 和 desktop-tools 的截断口径一致
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;     // 整个数组序列化后的上限
const MAX_NAME = 200;
// 只收我们自己的 canvas 编码器能产出的三种；浏览器一律重编码，所以这不是在过滤用户的原文件
const IMAGE_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MODEL_RE = /^[\w.-]{1,120}$/;

function allowRemote() { return process.env.AIPAINT_AGENT_ALLOW_REMOTE === '1'; }

/** 同源判定：没有 Origin 的是非浏览器客户端（curl / 测试），放过；有就必须和 Host 一致 */
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === String(req.headers.host || ''); } catch { return false; }
}

function hostOk(req) {
  return allowRemote() || LOCAL_HOST_RE.test(String(req.headers.host || ''));
}

function guard(req, res) {
  if (!hostOk(req)) {
    res.status(403).json({ error: 'agent 端点只在本机可用（需要跨机访问请设 AIPAINT_AGENT_ALLOW_REMOTE=1）' });
    return false;
  }
  if (!originOk(req)) {
    res.status(403).json({ error: '跨站请求被拒绝' });
    return false;
  }
  return true;
}

/** SSE 写出器。连接断了之后所有 emit 静默丢弃 —— 上层不需要到处判断 */
function sseWriter(res) {
  let closed = false;
  const writer = {
    emit(event, data) {
      if (closed || res.writableEnded) return;
      try {
        res.write('event: ' + event + '\n');
        res.write('data: ' + JSON.stringify(data) + '\n\n');
      } catch (err) {
        closed = true;
      }
    },
    ping() { if (!closed && !res.writableEnded) { try { res.write(': ping\n\n'); } catch { closed = true; } } },
    close() { closed = true; }
  };
  return writer;
}

/**
 * 附件白名单校验。逐项拒绝而不是过滤掉坏的那几项 —— 用户看得见自己挂了几个附件，
 * 服务端偷偷少收一个就是在骗人。
 */
function badAttachments(list) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return 'attachments 必须是数组';
  if (list.length > MAX_ATTACHMENTS) return '附件最多 ' + MAX_ATTACHMENTS + ' 个';
  let bytes = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const at = 'attachments[' + i + ']';
    if (!a || typeof a !== 'object') return at + ' 必须是对象';
    if (a.kind !== 'image' && a.kind !== 'text') return at + '.kind 只能是 image 或 text';
    if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > MAX_NAME) return at + '.name 非法';
    if (a.kind === 'image') {
      if (typeof a.dataUrl !== 'string' || !IMAGE_URL_RE.test(a.dataUrl)) return at + '.dataUrl 必须是 png/jpeg/webp 的 base64 data URL';
      if (a.dataUrl.length > MAX_IMAGE_CHARS) return at + ' 图片过大（上限 ' + Math.round(MAX_IMAGE_CHARS / 1024 / 1024) + ' MB，请先压缩）';
      if (!isPixel(a.w) || !isPixel(a.h)) return at + ' 缺少有效的 w/h 像素尺寸';
      bytes += a.dataUrl.length;
    } else {
      if (typeof a.text !== 'string' || !a.text) return at + '.text 不能为空';
      if (a.text.length > MAX_DOC_CHARS) return at + ' 文本过长（上限 ' + MAX_DOC_CHARS + ' 字，请先截断）';
      bytes += a.text.length;
    }
  }
  if (bytes > MAX_ATTACH_BYTES) return '附件总量过大（上限 ' + Math.round(MAX_ATTACH_BYTES / 1024 / 1024) + ' MB）';
  return null;
}

function isPixel(n) {
  return Number.isInteger(n) && n >= 1 && n <= 8192;
}

function badRequest(body) {
  if (!body || typeof body !== 'object') return '请求体必须是 JSON 对象';
  if (typeof body.text !== 'string' || !body.text.trim()) return '缺少 text';
  if (body.text.length > MAX_TEXT) return 'text 过长（上限 ' + MAX_TEXT + ' 字）';
  if (!body.scene || typeof body.scene !== 'object') return '缺少 scene';
  if (typeof body.sessionId !== 'string' || !/^[\w-]{8,64}$/.test(body.sessionId)) return 'sessionId 非法';
  return badAttachments(body.attachments);
}

/* ---------- 凭证 ---------- */

const MAX_KEY = 512;
// key 里只允许「不会破坏 .env 一行一变量」的可见 ASCII。宽到能装各家的 key，
// 窄到不含换行、引号、反斜杠 —— 注入面在这一行就关掉了
const KEY_RE = /^[A-Za-z0-9_\-.:+~/=]{8,512}$/;

/** baseUrl 必须是 http(s) 且不带 query/fragment：它会被拼上 /chat/completions */
function checkBaseUrl(raw) {
  if (raw === '') return { ok: true, value: '' };            // 空 = 恢复默认
  if (typeof raw !== 'string' || raw.length > 400) return { ok: false, error: 'baseUrl 非法' };
  if (/[\r\n\0]/.test(raw)) return { ok: false, error: 'baseUrl 不能包含换行' };
  let url;
  try { url = new URL(raw.trim()); } catch { return { ok: false, error: 'baseUrl 不是合法 URL' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'baseUrl 只能是 http/https' };
  if (url.search || url.hash) return { ok: false, error: 'baseUrl 不要带查询串或 #片段' };
  return { ok: true, value: url.origin + url.pathname.replace(/\/+$/, '') };
}

function checkKey(raw) {
  if (raw === '') return { ok: true, value: '' };             // 空 = 不改动
  if (typeof raw !== 'string') return { ok: false, error: 'apiKey 非法' };
  const value = raw.trim();
  if (value.length > MAX_KEY) return { ok: false, error: 'apiKey 过长' };
  if (!KEY_RE.test(value)) return { ok: false, error: 'apiKey 含不允许的字符（只接受字母数字和 _-.:+~/=）' };
  return { ok: true, value: value };
}

function create(options) {
  const router = express.Router();
  // fonts 由 server.js 注入：必须和导出路径用同一份，否则烘焙出来的断行和导出不一致
  const measure = createMeasure(options && options.fonts);

  router.get('/api/agent/config', (req, res) => {
    if (!guard(req, res)) return;
    res.json(CONFIG.publicConfig(CONFIG.load()));
  });

  /**
   * 配置弹窗要预填，所以这里给出当前 baseUrl 和「掩码后的」key。
   * /api/agent/config 那份契约不动（它是页面每次加载都拿的东西，不该带这些）。
   * 原始 key 一个字节都不出服务端 —— 只回 sk-abcdef…wxyz。
   */
  router.get('/api/agent/credentials', (req, res) => {
    if (!guard(req, res)) return;
    const cfg = CONFIG.load();
    const file = ENV_FILE.read();
    res.json({
      baseUrl: cfg.baseUrl,
      baseUrlDefault: CONFIG.DEFAULT_BASE_URL,
      hasApiKey: cfg.apiKey.length > 0,
      apiKeyMasked: ENV_FILE.mask(cfg.apiKey),
      // key 来自 shell 时改 .env 是没用的，这一条得让界面说清楚
      fromEnvFile: Boolean(file.values.DEEPSEEK_API_KEY) &&
        file.values.DEEPSEEK_API_KEY === cfg.apiKey,
      envPath: file.path,
      envExists: file.exists
    });
  });

  router.post('/api/agent/credentials', (req, res) => {
    if (!guard(req, res)) return;
    const body = req.body;
    if (!body || typeof body !== 'object') { res.status(400).json({ error: '请求体必须是 JSON 对象' }); return; }

    const base = checkBaseUrl(typeof body.baseUrl === 'string' ? body.baseUrl : '');
    if (!base.ok) { res.status(400).json({ error: base.error }); return; }
    const key = checkKey(typeof body.apiKey === 'string' ? body.apiKey : '');
    if (!key.ok) { res.status(400).json({ error: key.error }); return; }
    if (!key.value && !CONFIG.load().apiKey && !base.value) {
      res.status(400).json({ error: '什么都没填' });
      return;
    }

    let written;
    try {
      const updates = { DEEPSEEK_BASE_URL: base.value || null };   // 空 = 删掉这行，回到默认
      if (key.value) updates.DEEPSEEK_API_KEY = key.value;         // 没填就不碰原来那行
      written = ENV_FILE.patch(updates);
    } catch (err) {
      res.status(500).json({ error: '写 .env 失败：' + err.message });
      return;
    }

    // config.load() 每次请求现读 process.env，所以就地更新就等于「不用重启」
    if (key.value) process.env.DEEPSEEK_API_KEY = key.value;
    if (base.value) process.env.DEEPSEEK_BASE_URL = base.value;
    else delete process.env.DEEPSEEK_BASE_URL;

    const cfg = CONFIG.load();
    console.log('[agent] 凭证已写入 ' + written.path + '（key ' + (key.value ? '已更新' : '未改动') +
      '，baseUrl ' + (base.value || '默认') + '）');
    res.json({
      ok: true,
      envPath: written.path,
      baseUrl: cfg.baseUrl,
      hasApiKey: cfg.apiKey.length > 0,
      apiKeyMasked: ENV_FILE.mask(cfg.apiKey),
      model: cfg.model
    });
  });

  router.post('/api/agent', async (req, res) => {
    if (!guard(req, res)) return;
    const cfg = CONFIG.load();
    const problem = badRequest(req.body);
    if (problem) { res.status(400).json({ error: problem }); return; }
    if (!cfg.apiKey && cfg.transport !== 'fixture') {
      res.status(503).json({ error: '未配置 DEEPSEEK_API_KEY，无法调用模型' });
      return;
    }
    if (req.body.model !== undefined &&
        (typeof req.body.model !== 'string' || !MODEL_RE.test(req.body.model))) {
      res.status(400).json({ error: 'model 参数无效' });
      return;
    }
    if (req.body.model) cfg.model = req.body.model;
    const sessionId = req.body.sessionId;
    if (SESSION.has(sessionId)) { res.status(409).json({ error: '这个会话正在生成中' }); return; }
    if (SESSION.count() >= cfg.maxConcurrent) { res.status(429).json({ error: '并发已满，稍后再试' }); return; }

    let controller;
    try { controller = SESSION.begin(sessionId); } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
      return;
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    const sse = sseWriter(res);
    const beat = setInterval(() => sse.ping(), HEARTBEAT_MS);
    // 客户端 abort() 关 socket，这就是主中断路径，不需要第二个端点。
    // 必须挂 res 而不是 req：express.json 读完 body 就会让 req 流 emit 'close'，
    // 挂在 req 上等于每次请求都在第一轮之后立刻自我中断。
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('客户端断开'));
    });

    const startedAt = Date.now();
    sse.emit('open', { sessionId: sessionId, model: cfg.model, baseRevision: Number(req.body.baseRevision) || 0 });

    try {
      const out = await SESSION.run(cfg, {
        text: req.body.text,
        scene: req.body.scene,
        selection: req.body.selection,
        attachments: req.body.attachments,
        baseRevision: req.body.baseRevision,
        measure: measure,
        signal: controller.signal
      }, sse.emit);
      sse.emit('done', {
        revision: out.revision, applied: out.stats.applied, rounds: out.stats.rounds,
        stuck: out.stuck, ms: Date.now() - startedAt
      });
      console.log('[agent] 完成 rounds=' + out.stats.rounds + ' applied=' + out.stats.applied +
        ' tokens=' + out.stats.promptTokens + '/' + out.stats.completionTokens +
        ' reasoning=' + out.stats.reasoningChars + '字 ' + (Date.now() - startedAt) + 'ms');
    } catch (err) {
      // Express 5 会把 rejected promise 交给默认错误处理器，而 headers 早已 flush，
      // 那货会在流中间塞一段 JSON。所以这里必须自己兜住一切。
      const aborted = Boolean(err && err.aborted) || controller.signal.aborted;
      const message = aborted ? '已中断' : (err && err.message ? err.message : '生成失败');
      if (!aborted) console.error('[agent] 失败:', err);
      else console.log('[agent] 中断于 ' + (Date.now() - startedAt) + 'ms');
      sse.emit('error', { message: message, aborted: aborted });
      sse.emit('done', { revision: Number(req.body.baseRevision) || 0, applied: 0, aborted: aborted });
    } finally {
      clearInterval(beat);
      SESSION.end(sessionId);
      sse.close();
      try { res.end(); } catch { /* 已经断了 */ }
    }
  });

  router.get('/api/agent/models', async (req, res) => {
    if (!guard(req, res)) return;
    const cfg = CONFIG.load();
    if (!cfg.apiKey && cfg.transport !== 'fixture') {
      res.status(503).json({ error: '未配置 DEEPSEEK_API_KEY，无法获取模型列表' });
      return;
    }
    if (cfg.transport === 'fixture') {
      res.json({ data: [{ id: cfg.model }] });
      return;
    }
    try {
      const upstream = await fetch(cfg.baseUrl + '/models', {
        headers: { Authorization: 'Bearer ' + cfg.apiKey, Accept: 'application/json' }
      });
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: await parseErrorResponse(upstream) });
        return;
      }
      const payload = await upstream.json();
      const data = Array.isArray(payload.data)
        ? payload.data.filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id }))
        : [];
      res.json({ data: data });
    } catch (err) {
      res.status(502).json({ error: '获取模型列表失败：' + (err.message || '网络错误') });
    }
  });

  return router;
}

module.exports = { create };
