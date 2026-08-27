'use strict';
/**
 * DeepSeek 流式客户端。移植自 desktop-tools/src/main/deepseek-client.ts 的帧循环与重试，
 * 换成 CommonJS、去掉 OneAPI 兼容分支和附件。
 *
 * 三件必须照搬的事：
 *  1. 按 \n\n 切帧、frames.pop() 回写缓冲、done 之后冲刷尾部 —— 少一步就会丢最后一个 chunk；
 *  2. tool_call 分片按 index 重组（见 tool-calls.js）；
 *  3. delta.reasoning_content 单独走 onReasoning，绝不混进 onDelta ——
 *     「怎么处理思考过程」于是成为调用方的一个选择（当前是转发成自己的 SSE 事件），
 *     而不是要在正文里解析剥离。
 */
const fs = require('node:fs');
const path = require('node:path');
const TC = require('./tool-calls.js');

const RETRY_COUNT = 1;
const RETRYABLE_RE = /upstream service error|connection timed out|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

class AgentRequestError extends Error {
  constructor(message, retryable) {
    super(message);
    this.name = 'AgentRequestError';
    this.retryable = Boolean(retryable);
  }
}

function toRequestError(err, timeoutMs) {
  if (err instanceof AgentRequestError) return err;
  if (err && err.name === 'TimeoutError') {
    return new AgentRequestError(`模型服务请求超时（${Math.round(timeoutMs / 1000)} 秒）`, false);
  }
  if (err && err.name === 'AbortError') {
    const e = new AgentRequestError('已中断', false);
    e.aborted = true;
    return e;
  }
  const msg = err && err.message ? err.message : '模型服务请求失败';
  return new AgentRequestError(msg, RETRYABLE_RE.test(msg));
}

function buildBody(cfg, messages, tools, toolChoice, thinking) {
  const body = { model: cfg.model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools && tools.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  // 顶层 thinking，不是 extra_body（那是 OpenAI SDK 的约定被手写进了 raw fetch）。
  // 文档说默认开启、参考实现默认关闭，两处证据矛盾 —— 所以两个方向都显式发。
  body.thinking = { type: thinking ? 'enabled' : 'disabled' };
  if (thinking) body.reasoning_effort = cfg.reasoningEffort;
  return JSON.stringify(body);
}

async function parseErrorResponse(res) {
  let text = '';
  try { text = await res.text(); } catch { /* 读不出就只报状态码 */ }
  if (!text.trim()) return `模型服务请求失败：HTTP ${res.status} ${res.statusText}`;
  try {
    const payload = JSON.parse(text);
    if (payload && payload.error && payload.error.message) return payload.error.message;
  } catch { /* 不是 JSON，原样带上 */ }
  return `模型服务请求失败：HTTP ${res.status} ${text.slice(0, 400)}`;
}

/* ── fixture 传输：CI 不烧 API ───────────────────────────────────────────
 * 刻意按固定的小字节数切块（默认 7 字节），一刀切下去就同时造出了四种对抗边界：
 * 切在 data: 行中间、切在 UTF-8 多字节序列中间、\n\n 跨两块、tool_calls 分片
 * 的 index 先到而 id 未到。帧解析器真正会坏的地方就在这里，所以不做“整块喂”。 */
const FIXTURE_CHUNK = Math.max(1, Number.parseInt(process.env.AIPAINT_AGENT_FIXTURE_CHUNK || '7', 10) || 7);

function fixturePath(cfg, name) {
  return path.resolve(process.cwd(), cfg.fixtureDir, String(name).replace(/[^\w.-]/g, '_') + '.sse');
}

/** 依次尝试 本轮名 → cfg.fixtureName → default，第一个存在的胜出 */
function resolveFixture(cfg, name) {
  const tried = [];
  for (const candidate of [name, cfg.fixtureName, 'default']) {
    if (!candidate) continue;
    const file = fixturePath(cfg, candidate);
    tried.push(file);
    if (fs.existsSync(file)) return file;
  }
  throw new AgentRequestError('找不到 fixture：' + tried.join(' / '), false);
}

function fixtureBody(file) {
  const buf = fs.readFileSync(file);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= buf.length) { controller.close(); return; }
      const end = Math.min(buf.length, at + FIXTURE_CHUNK);
      controller.enqueue(new Uint8Array(buf.subarray(at, end)));
      at = end;
    }
  });
}

/* ── 帧解析 ─────────────────────────────────────────────────────────── */

function processFrame(frame, acc, onDelta, onReasoning) {
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue; // 注释行（心跳 `: ping`）、event: 行都跳过
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; } // 半截 JSON 不该炸掉整条流
    if (chunk && chunk.error && chunk.error.message) {
      throw new AgentRequestError(chunk.error.message, false);
    }
    if (chunk && chunk.usage) acc.usage = chunk.usage;

    const choice = chunk && chunk.choices && chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) acc.finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      acc.reasoningChars += delta.reasoning_content.length;
      if (onReasoning) onReasoning(delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content) {
      acc.content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      TC.mergeToolCallDelta(acc.toolCalls, delta.tool_calls);
    }
  }
}

async function readStream(body, acc, onDelta, onReasoning, record) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    const text = decoder.decode(value || new Uint8Array(), { stream: !done });
    if (record && text) record.push(text);
    buffer += text;
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || ''; // 最后一段可能是半截帧，回写缓冲
    for (const frame of frames) processFrame(frame, acc, onDelta, onReasoning);
    if (done) break;
  }
  if (buffer.trim()) processFrame(buffer, acc, onDelta, onReasoning); // 尾部冲刷
}

/* ── 一次请求 ───────────────────────────────────────────────────────── */

function newAcc() {
  return { content: '', toolCalls: [], reasoningChars: 0, usage: null, finishReason: '' };
}

/** 组装返回消息：只有非空字段才出现，避免给上游送一堆 null */
function toMessage(acc, cfg) {
  const filtered = TC.filterValidToolCalls(acc.toolCalls);
  if (filtered.droppedReasons.length && cfg.debug) {
    console.warn('[agent] 丢弃畸形 tool_call：' + filtered.droppedReasons.join('；'));
  }
  const message = { role: 'assistant', content: acc.content || null };
  if (filtered.valid.length) message.tool_calls = filtered.valid;
  return {
    message,
    usage: acc.usage,
    finishReason: acc.finishReason,
    reasoningChars: acc.reasoningChars,
    droppedToolCalls: filtered.droppedReasons
  };
}

function saveRecording(cfg, name, chunks) {
  try {
    const file = fixturePath(cfg, name || cfg.fixtureName || 'recorded');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, chunks.join(''), 'utf8');
    console.log('[agent] 已录制 fixture：' + file);
  } catch (err) {
    console.warn('[agent] fixture 录制失败：' + (err && err.message));
  }
}

async function attempt(cfg, opts, acc) {
  const record = cfg.record && cfg.transport === 'http' ? [] : null;

  if (cfg.transport === 'fixture') {
    const file = resolveFixture(cfg, opts.fixture);
    if (cfg.debug) console.log('[agent] fixture 回放：' + file);
    if (opts.signal && opts.signal.aborted) throw toRequestError(opts.signal.reason || new Error('已中断'), 0);
    await readStream(fixtureBody(file), acc, opts.onDelta, opts.onReasoning, null);
    return;
  }

  if (!cfg.apiKey) throw new AgentRequestError('未配置 DEEPSEEK_API_KEY', false);

  // AbortSignal.any：调用方中断和请求超时是两条独立的中断源，Node 26 原生支持
  const signals = [AbortSignal.timeout(cfg.requestTimeoutMs)];
  if (opts.signal) signals.unshift(opts.signal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  const sanitized = TC.dropOrphanToolMessages(opts.messages);
  if (sanitized.droppedToolCallIds.length && cfg.debug) {
    console.warn('[agent] 丢弃孤立 tool 消息：' + sanitized.droppedToolCallIds.join(','));
  }

  const res = await fetch(cfg.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey,
      Accept: 'text/event-stream'
    },
    body: buildBody(cfg, sanitized.messages, opts.tools, opts.toolChoice, opts.thinking),
    signal
  });

  if (!res.ok) {
    // 5xx 一律可重试；4xx 里只有网关那几句可重试的话术算
    const message = await parseErrorResponse(res);
    throw new AgentRequestError(message, res.status >= 500 || RETRYABLE_RE.test(message));
  }
  if (!res.body) throw new AgentRequestError('模型服务没有返回流式响应体', true);

  await readStream(res.body, acc, opts.onDelta, opts.onReasoning, record);
  if (record) saveRecording(cfg, opts.fixture, record);
}

/**
 * 流式聊天补全。
 * @param {object} cfg   config.load() 的结果
 * @param {object} opts  {messages, tools, toolChoice, thinking, signal, fixture, onDelta, onReasoning}
 * @returns {Promise<{message, usage, finishReason, reasoningChars, droppedToolCalls}>}
 */
async function streamChatCompletion(cfg, opts) {
  let lastError = null;
  for (let attemptNo = 0; attemptNo <= RETRY_COUNT; attemptNo++) {
    const acc = newAcc();
    try {
      await attempt(cfg, opts, acc);
      return toMessage(acc, cfg);
    } catch (err) {
      lastError = toRequestError(err, cfg.requestTimeoutMs);
      // 已经吐过内容就不能重试：重放会让用户看到两遍开头
      const emitted = acc.content.length > 0 || acc.toolCalls.length > 0;
      const userAborted = Boolean(opts.signal && opts.signal.aborted);
      if (!lastError.retryable || emitted || userAborted || attemptNo === RETRY_COUNT) throw lastError;
      if (cfg.debug) console.warn('[agent] 重试一次：' + lastError.message);
    }
  }
  throw lastError;
}

module.exports = { streamChatCompletion, AgentRequestError, buildBody, fixturePath };
