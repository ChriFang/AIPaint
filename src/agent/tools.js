'use strict';
/**
 * 工具执行层。三个工具、一个 execute，全部同步（画图不需要 IO）。
 *
 * 设计要点：数据只走 tool_call 参数，正文永远是给人看的话。所以这里也反过来守住 ——
 * 工具结果回喂给模型的是**结构化的 problems / notes**，不是渲染好的句子；
 * 校验失败不是异常，是模型下一轮的输入（招法来自 desktop-tools 的 tools.ts:36-51）。
 */
const SPEC = require('../shared/scene-spec.js');

const NAMES = ['set_scene', 'edit_scene', 'get_scene'];

function declarations(cfg) {
  return SPEC.tools(Boolean(cfg && cfg.strict));
}

/** 参数 JSON 解析失败也要变成 problems 回喂，模型下一轮就会重发 */
function parseArgs(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, problems: [{ path: 'arguments', code: 'wrong_type', message: '参数必须是一个 JSON 对象' }] };
    }
    return { ok: true, value: value };
  } catch (err) {
    return {
      ok: false,
      problems: [{
        path: 'arguments', code: 'bad_json',
        message: '参数不是合法 JSON：' + (err && err.message ? err.message : '解析失败'),
        hint: '一次性输出完整的 JSON，不要截断'
      }]
    };
  }
}

/** tool_start 的预览：从解析后的参数派生语义摘要，绝不外发原始参数（里面是整个场景） */
function preview(name, args) {
  if (name === 'set_scene' && args) {
    const n = Array.isArray(args.shapes) ? args.shapes.length : 0;
    const size = args.width && args.height ? '，画布 ' + args.width + '×' + args.height : '';
    return '重画整幅：' + n + ' 个图形' + size;
  }
  if (name === 'edit_scene' && args) {
    const ops = Array.isArray(args.ops) ? args.ops : [];
    const tally = {};
    ops.forEach((o) => { const k = o && o.op ? String(o.op) : '?'; tally[k] = (tally[k] || 0) + 1; });
    const parts = Object.keys(tally).map((k) => k + '×' + tally[k]);
    return '局部修改：' + ops.length + ' 个操作' + (parts.length ? '（' + parts.join('，') + '）' : '');
  }
  if (name === 'get_scene') return '读取当前画布';
  return name;
}

function fail(summary, problems, truncated) {
  return {
    ok: false,
    applied: false,
    clean: false,
    summary: summary,
    result: {
      ok: false,
      summary: summary,
      problems: (problems || []).slice(0, SPEC.MAX_PROBLEMS),
      truncated: truncated || 0
    }
  };
}

function ids(scene) {
  return scene.shapes.map((s) => s.id);
}

/**
 * 执行一次 tool_call。永不抛异常 —— 任何失败都是一个可回喂的 result。
 * @param {object} call {id, function:{name, arguments}}
 * @param {object} ctx  {scene, srcRefs, selection, measure, strict}
 * @returns {object} {name, ok, wrote, applied, clean, summary, preview, result, scene?, touchedIds?, notes?}
 */
function execute(call, ctx) {
  const name = call && call.function ? String(call.function.name || '') : '';
  const parsed = parseArgs(call && call.function ? call.function.arguments : '');
  const base = { name: name, preview: preview(name, parsed.ok ? parsed.value : null), wrote: false };

  if (NAMES.indexOf(name) < 0) {
    return Object.assign(base, fail('未知工具：' + name, [{
      path: 'name', code: 'bad_enum', message: '没有名为 ' + name + ' 的工具',
      hint: '可用：' + NAMES.join(' / ')
    }]));
  }
  if (!parsed.ok) return Object.assign(base, fail(name + ' 参数无法解析', parsed.problems));

  const opts = { measure: ctx.measure, srcRefs: ctx.srcRefs, assertInvariant: false };

  if (name === 'get_scene') {
    return Object.assign(base, {
      ok: true, applied: false, clean: false,
      summary: '已读取当前画布',
      result: {
        ok: true,
        summary: '当前画布',
        scene: SPEC.explainScene(ctx.scene, { srcRefs: ctx.srcRefs, uploads: ctx.uploads, selection: ctx.selection }),
        notes: SPEC.auditScene(ctx.scene)
      }
    });
  }

  let res;
  if (name === 'set_scene') {
    res = SPEC.normalizeAgentScene(parsed.value, opts);
  } else {
    const ops = parsed.value.ops;
    const extra = Object.keys(parsed.value).filter((k) => k !== 'ops');
    if (extra.length) {
      return Object.assign(base, fail('edit_scene 参数无法解析', [{
        path: extra[0], code: 'unknown_field', message: 'edit_scene 只接受 ops 一个字段'
      }]));
    }
    if (!Array.isArray(ops)) {
      return Object.assign(base, fail('edit_scene 参数无法解析', [{
        path: 'ops', code: 'missing', message: 'ops 必须是数组', hint: '例：[{"op":"update","id":"s1","patch":{"fill":"#e53e3e"}}]'
      }]));
    }
    res = SPEC.applyOps(ctx.scene, ops, opts);
  }

  base.wrote = true;
  if (!res.ok) {
    // 场景一个字节都没动，模型下一轮拿着 problems 重试
    return Object.assign(base, {
      ok: false, applied: false, clean: false,
      summary: res.summary,
      result: { ok: false, summary: res.summary, problems: res.problems, truncated: res.truncated || 0 }
    });
  }

  const notes = SPEC.auditScene(res.scene);
  const touched = name === 'set_scene' ? ids(res.scene) : res.touchedIds;
  ctx.scene = res.scene; // 会话内的当前场景，落盘（发给浏览器）由 session 负责
  return Object.assign(base, {
    ok: true, applied: true, clean: notes.length === 0,
    summary: name === 'set_scene'
      ? '已重画：' + res.scene.shapes.length + ' 个图形'
      : '已修改 ' + touched.length + ' 个图形',
    scene: res.scene,
    touchedIds: touched,
    notes: notes,
    result: {
      ok: true,
      summary: (name === 'set_scene' ? 'scene set: ' : 'scene edited: ') + res.scene.shapes.length + ' shapes',
      canvas: { width: res.scene.width, height: res.scene.height, background: res.scene.background },
      ids: touched,
      // notes 是这套「盲画」设计里唯一的视觉反馈来源，必须回喂
      notes: notes,
      next: notes.length
        ? '上面这些是渲染后自动检查出的问题，请用 edit_scene 修掉，或确认它们是有意为之。'
        : '画布已符合要求，用一两句话向用户说明你画了什么，不要再调用工具。'
    }
  });
}

/** 组装回喂消息，格式照 desktop-tools tool-registry.ts:601-611（多带一个 name 字段） */
function toToolMessage(call, out) {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: out.name,
    content: JSON.stringify(out.result)
  };
}

module.exports = { NAMES, declarations, execute, parseArgs, preview, toToolMessage };
