'use strict';
/**
 * tool_call 自愈。移植自 desktop-tools/src/main/tool-call-utils.ts。
 *
 * 两条都不是「防御性编程」，是被上游网关咬过的：
 *  - 流式 delta 归并后数组可能有空洞、缺 id、arguments 不是合法 JSON；
 *  - tool 消息必须紧跟在对应的 assistant.tool_calls 之后，配不上整个请求会被拒。
 * 一轮畸形若进了历史，后面每一轮都会被拒 —— 所以每次出站请求都要跑 dropOrphanToolMessages。
 */

function isParsableArguments(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return true; // 无参工具调用，合法
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function filterValidToolCalls(toolCalls) {
  const valid = [];
  const droppedReasons = [];
  const seenIds = new Set();

  (toolCalls || []).forEach((toolCall, index) => {
    if (!toolCall || !toolCall.function) {
      droppedReasons.push(`index=${index} tool_call 结构不完整`);
      return;
    }
    const id = (toolCall.id || '').trim();
    const name = (toolCall.function.name || '').trim();
    const args = toolCall.function.arguments || '';

    if (!id) { droppedReasons.push(`index=${index} 缺少 tool_call id`); return; }
    if (!name) { droppedReasons.push(`id=${id} 缺少工具名`); return; }
    if (seenIds.has(id)) { droppedReasons.push(`id=${id} 重复`); return; }
    if (!isParsableArguments(args)) {
      droppedReasons.push(`id=${id} tool=${name} 参数不是合法 JSON`);
      return;
    }
    seenIds.add(id);
    valid.push({ id, type: toolCall.type || 'function', function: { name, arguments: args } });
  });

  return { valid, droppedReasons };
}

function hasContent(content) {
  if (Array.isArray(content)) return content.length > 0;
  return typeof content === 'string' ? content.trim().length > 0 : false;
}

function dropOrphanToolMessages(messages) {
  const droppedToolCallIds = [];
  const answeredIds = new Set();
  const kept = [];
  let pendingIds = new Set();

  for (const message of messages) {
    if (message.role === 'tool') {
      const id = (message.tool_call_id || '').trim();
      if (!id || !pendingIds.has(id)) { droppedToolCallIds.push(id); continue; }
      answeredIds.add(id);
      kept.push(message);
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length) {
      pendingIds = new Set(message.tool_calls.map((t) => (t && t.id ? t.id.trim() : '')).filter(Boolean));
    } else {
      pendingIds = new Set();
    }
    kept.push(message);
  }

  const result = [];
  for (const message of kept) {
    if (message.role !== 'assistant' || !message.tool_calls || !message.tool_calls.length) {
      result.push(message);
      continue;
    }
    const answered = message.tool_calls.filter((t) => answeredIds.has(t && t.id ? t.id.trim() : ''));
    if (answered.length === message.tool_calls.length) { result.push(message); continue; }
    if (answered.length === 0) {
      // 一个结果都没有：留着 tool_calls 必被拒，只有正文还有价值
      if (!hasContent(message.content)) continue;
      const rest = Object.assign({}, message);
      delete rest.tool_calls;
      result.push(rest);
      continue;
    }
    result.push(Object.assign({}, message, { tool_calls: answered }));
  }

  return { messages: result, droppedToolCallIds };
}

/** 流式 tool_call 分片重组：index 可能缺，得靠 id / 上一个调用是否已完整来猜 */
function getToolCallDeltaIndex(toolCalls, delta) {
  if (typeof delta.index === 'number') return delta.index;
  if (delta.id) {
    const at = toolCalls.findIndex((t) => t && t.id === delta.id);
    if (at >= 0) return at;
  }
  if (toolCalls.length === 0) return 0;
  const last = toolCalls.length - 1;
  const newIdentity = Boolean(delta.id || (delta.function && delta.function.name));
  const lastHasName = Boolean(toolCalls[last] && toolCalls[last].function.name);
  const lastHasArgs = Boolean(toolCalls[last] && toolCalls[last].function.arguments);
  return newIdentity && lastHasName && lastHasArgs ? toolCalls.length : last;
}

function mergeToolCallDelta(toolCalls, deltas) {
  for (const delta of deltas) {
    if (!delta) continue;
    const i = getToolCallDeltaIndex(toolCalls, delta);
    const existing = toolCalls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
    const fn = delta.function || {};
    toolCalls[i] = {
      id: delta.id != null ? delta.id : existing.id,
      type: delta.type != null ? delta.type : existing.type,
      function: {
        name: fn.name != null ? fn.name : existing.function.name,
        arguments: existing.function.arguments + (fn.arguments != null ? fn.arguments : '')
      }
    };
  }
  return toolCalls;
}

module.exports = {
  filterValidToolCalls,
  dropOrphanToolMessages,
  getToolCallDeltaIndex,
  mergeToolCallDelta
};
