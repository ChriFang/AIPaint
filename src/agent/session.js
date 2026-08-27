'use strict';
/**
 * 会话编排：一次用户输入 → 若干轮模型调用 → 若干个 SSE 事件。
 *
 * 结构照 desktop-tools agent-service.ts:401-474，三处刻意不同：
 *  1. 不做模块级单例。会话状态只活在一次请求里，registry 只记「谁在跑」用于单飞和中断。
 *  2. 轮次用满不抛异常，改成强制收尾（forceSummarizeOnLimit 的思路）—— 用户至少能看到一句话。
 *  3. reasoning_content 不回灌历史。OpenAI 兼容语义不要求，回灌只会让多轮修复的上下文白涨。
 */
const M = require('../shared/scene.js');
const SPEC = require('../shared/scene-spec.js');
const DS = require('./deepseek.js');
const TOOLS = require('./tools.js');
const PROMPT = require('./prompt.js');

const MAX_SESSIONS = 32;
const active = new Map(); // sessionId → {controller, startedAt}

function count() { return active.size; }
function has(id) { return active.has(id); }

function begin(id) {
  if (active.size >= MAX_SESSIONS) throw Object.assign(new Error('并发会话过多'), { status: 429 });
  const controller = new AbortController();
  active.set(id, { controller: controller, startedAt: Date.now() });
  return controller;
}

function end(id) { active.delete(id); }

function abort(id, reason) {
  const entry = active.get(id);
  if (!entry) return false;
  entry.controller.abort(new Error(reason || '已中断'));
  return true;
}

/** 相同 code 集合连续出现两轮 = 模型在原地打转，烧轮次不如直接停 */
function codeKey(problems) {
  const codes = (problems || []).map((p) => p && p.code).filter(Boolean);
  return codes.slice().sort().join(',');
}

function clone(scene) { return JSON.parse(JSON.stringify(scene)); }

/** 把要发给浏览器的场景还原成带真实图片的版本；ctx.scene 保持剥离状态 */
function outboundScene(ctx, srcUrls) {
  const out = clone(ctx.scene);
  SPEC.restoreImageSrc(out, srcUrls);
  return out;
}

function addUsage(stats, usage) {
  if (!usage) return;
  stats.promptTokens += Number(usage.prompt_tokens) || 0;
  stats.completionTokens += Number(usage.completion_tokens) || 0;
}

/**
 * 跑完一次用户输入。emit(event, data) 由 routes 提供；它负责在连接已断时静默丢弃。
 * @param {object} input {text, scene, selection, baseRevision, measure, signal}
 * @returns {Promise<object>} {text, revision, stats}
 */
async function run(cfg, input, emit) {
  // applyOps 的前置条件：入口场景必须先过一遍安全边界
  const base = M.validateScene(input.scene);
  if (base.warnings.length) emit('status', { text: '画布有 ' + base.warnings.length + ' 处被修正' });
  // 剥离图片：几 MB base64 既不进模型上下文，也不进每轮的深拷贝
  const stripped = SPEC.stripImageSrc(base.scene);
  const known = base.scene.shapes.map((s) => s.id);
  const ctx = {
    scene: stripped.scene,
    srcRefs: stripped.srcRefs,
    selection: (Array.isArray(input.selection) ? input.selection : []).filter((id) => known.indexOf(id) >= 0),
    measure: input.measure
  };

  const tools = TOOLS.declarations(cfg);
  const messages = [
    { role: 'system', content: PROMPT.systemPrompt() },
    PROMPT.userMessage(input.text, ctx)
  ];
  const stats = { rounds: 0, applied: 0, promptTokens: 0, completionTokens: 0, reasoningChars: 0 };
  let revision = Number(input.baseRevision) || 0;
  let text = '';
  let clean = false;
  let lastKey = null;
  let stuck = false;

  for (let round = 1; round <= cfg.maxRounds; round++) {
    if (input.signal.aborted) break;
    // 一个布尔量同时驱动两个字段：这一轮只说话 → 关思考、掐掉工具（防「我再优化一下」死循环）
    const speakOnly = clean || round === cfg.maxRounds;
    stats.rounds = round;

    let announced = false;
    const res = await DS.streamChatCompletion(cfg, {
      messages: messages,
      tools: tools,
      toolChoice: speakOnly ? 'none' : 'auto',
      thinking: !speakOnly,
      signal: input.signal,
      fixture: 'round-' + round,
      onDelta: (chunk) => { text += chunk; emit('delta', { text: chunk }); },
      onReasoning: (chunk) => {
        // 思考期间一个正文 token 都不会来，可能沉默十几秒 —— 什么都不显示会像卡死。
        // phase:true 的状态是临时的，面板在拿到正文/工具动作之后会把它撤掉。
        if (!announced) {
          announced = true;
          emit('status', { text: round === 1 ? '正在规划版面…' : '正在检查并修正…', phase: true });
        }
        // 思考正文单独成一路事件：面板折成一块可收起的区域。绝不混进 delta，
        // 也绝不回灌模型历史（见文件头第 3 条）。AGENT_STREAM_REASONING=0 关掉这一路。
        if (cfg.streamReasoning) emit('reasoning', { text: chunk, round: round });
      }
    });
    stats.reasoningChars += res.reasoningChars || 0;
    addUsage(stats, res.usage);
    if (cfg.debug) {
      console.log('[agent] round ' + round + ' thinking=' + (!speakOnly) +
        ' tool_choice=' + (speakOnly ? 'none' : 'auto') +
        ' finish=' + res.finishReason + ' reasoning=' + (res.reasoningChars || 0) + '字' +
        ' calls=' + ((res.message.tool_calls || []).length));
    }

    messages.push(res.message);
    const calls = res.message.tool_calls || [];
    if (!calls.length) break; // 终止条件（照 agent-service.ts:435）：不再调用工具就是收尾轮

    let roundClean = true;
    let failedKey = null;
    for (const call of calls) {
      if (input.signal.aborted) break;
      const out = TOOLS.execute(call, ctx);
      emit('tool_start', { name: out.name, preview: out.preview });
      messages.push(TOOLS.toToolMessage(call, out));
      emit('tool_result', {
        name: out.name, ok: out.ok, summary: out.summary,
        notes: out.notes || [], problems: out.ok ? [] : out.result.problems
      });
      if (out.applied) {
        revision += 1;
        stats.applied += 1;
        emit('scene', {
          revision: revision,
          baseRevision: Number(input.baseRevision) || 0,
          scene: outboundScene(ctx, stripped.srcUrls),
          touchedIds: out.touchedIds,
          warnings: [],
          notes: out.notes,
          refit: out.scene.width !== base.scene.width || out.scene.height !== base.scene.height
        });
      }
      if (!out.ok) { roundClean = false; failedKey = codeKey(out.result.problems); }
      else if (!out.clean) roundClean = false;
    }

    if (failedKey && failedKey === lastKey) {
      stuck = true;
      emit('error', { message: '模型连续两轮犯同一类错误（' + failedKey + '），已停止。画布未改动。' });
      break;
    }
    lastKey = failedKey;
    clean = roundClean;
  }

  if (!text.trim() && stats.applied > 0) {
    // 卡死中止或轮次用尽时可能一句话都没有，日志不该是空的
    text = '已更新画布。';
    emit('delta', { text: text });
  }
  return { text: text, revision: revision, stats: stats, stuck: stuck };
}

module.exports = { run, begin, end, abort, has, count, MAX_SESSIONS };
