/**
 * AgentScene Spec v1 —— 给 LLM 用的严格做图规范（浏览器 + Node 双端复用）。
 *
 * 与 scene.js 的分工：
 *   scene.js  = 安全边界，永不抛错，非法字段静默回落（localStorage 恢复、JSON 导入依赖这点）
 *   本文件    = 严格层，任何问题都变成结构化 problems 回喂给模型自我修复
 *
 * 不变式：本文件接受并输出的场景，再过一次 SceneModel.validateScene 必须
 * 字节一致且 warnings 为空。测试里对所有 fixture 断言这条。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./scene.js'));
  else root.SceneSpec = factory(root.SceneModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  var SPEC_VERSION = 'agentscene-1';
  var LIMITS = M.LIMITS;
  var MAX_PROBLEMS = 12;
  var MAX_AGENT_SHAPES = 400;
  var MAX_AGENT_POINTS = 200;

  /**
   * 只收 hex 和字面量 transparent。故意不复用 scene.js 的 COLOR_RE：
   * 它有个 [a-zA-Z]{3,20} 分支，"skyblu" 这种拼错的颜色能过；而 canvas 遇到
   * 非法颜色是保留上一次的 fillStyle，于是图形会被画成上一个图形的颜色 —— 静默且难查。
   */
  var HEX_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent)$/;

  var PALETTES = {
    ink: { bg: '#ffffff', fg: '#1f2933', muted: '#7b8794', accent: '#2b6cb0', soft: '#e8edf3' },
    dusk: { bg: '#151a24', fg: '#f0f4f8', muted: '#8b98a8', accent: '#6aa9ff', soft: '#232b38' },
    warm: { bg: '#fffaf3', fg: '#3b2f2a', muted: '#9c8878', accent: '#d9721e', soft: '#f6e7d4' },
    forest: { bg: '#f4f8f4', fg: '#1e3226', muted: '#6f8a76', accent: '#2f8f5b', soft: '#dceadf' },
    berry: { bg: '#fdf6f8', fg: '#3a1f2b', muted: '#9b7482', accent: '#c2255c', soft: '#f7dde5' }
  };

  var CJK_RE = new RegExp(
    '[\\u1100-\\u11FF\\u2E80-\\u303F\\u3040-\\u30FF\\u3130-\\u318F\\u3400-\\u4DBF' +
    '\\u4E00-\\u9FFF\\uA960-\\uA97F\\uAC00-\\uD7FF\\uF900-\\uFAFF\\uFE30-\\uFE4F' +
    '\\uFF00-\\uFF60\\uFFE0-\\uFFE6]'
  );

  /**
   * 字段表：schema 生成和运行时校验共用这一份，避免两边漂移。
   * t: number|string|boolean|color|enum|text|points   req: 必填   def: 缺省值
   */
  var F = {
    id: { t: 'string', max: 64, desc: '图形 id。改已有图形必填；新建时省略，由服务端分配' },
    opacity: { t: 'number', min: 0, max: 1, def: 1, desc: '不透明度 0..1' },
    rotationDeg: { t: 'number', min: -360, max: 360, def: 0, desc: '旋转角度，单位是度（不是弧度）', hint: '用度数，例如 45' },

    x: { t: 'number', min: -100000, max: 100000, req: true, desc: '左上角 x' },
    y: { t: 'number', min: -100000, max: 100000, req: true, desc: '左上角 y' },
    w: { t: 'number', min: 1, max: 100000, req: true, desc: '宽度' },
    h: { t: 'number', min: 1, max: 100000, req: true, desc: '高度' },
    x1: { t: 'number', min: -100000, max: 100000, req: true, desc: '起点 x' },
    y1: { t: 'number', min: -100000, max: 100000, req: true, desc: '起点 y' },
    x2: { t: 'number', min: -100000, max: 100000, req: true, desc: '终点 x' },
    y2: { t: 'number', min: -100000, max: 100000, req: true, desc: '终点 y' },

    fill: { t: 'color', def: 'transparent', desc: '填充色，#rrggbb 或 transparent' },
    stroke: { t: 'color', def: 'transparent', desc: '描边色，#rrggbb 或 transparent' },
    strokeWidth: { t: 'number', min: 0, max: 200, def: 2, desc: '线宽；stroke 为 transparent 时不生效' },
    dash: { t: 'enum', values: M.DASH_STYLES, def: 'solid' },
    radius: { t: 'number', min: 0, max: 100000, def: 0, desc: '圆角半径' },
    arrowSize: { t: 'number', min: 0, max: 200, def: 0, desc: '箭头大小，0=按线宽自动' },
    arrowStart: { t: 'boolean', def: false, desc: '连接线起点是否有箭头' },
    arrowEnd: { t: 'boolean', def: true, desc: '连接线终点是否有箭头' },
    startId: { t: 'string', max: 64, desc: '连接线起点图形 id' },
    endId: { t: 'string', max: 64, desc: '连接线终点图形 id' },

    points: { t: 'points', req: true, desc: '顶点数组 [[x,y],...]，至少 2 个' },
    smooth: { t: 'boolean', def: false, desc: 'false=顶点折线（三角形、折线图、连接线用这个）；true=平滑手绘曲线，点不再是顶点' },
    closed: { t: 'boolean', def: false, desc: '是否闭合成多边形' },

    text: { t: 'text', req: true, desc: '文字内容，可含 \\n 强制换行' },
    maxWidth: { t: 'number', min: 8, max: 100000, desc: '超过这个宽度自动换行。你无法测量文字，交给服务端断行' },
    fontSize: { t: 'number', min: 4, max: 800, def: 24 },
    fontFamily: { t: 'enum', values: M.FONT_KEYS, def: 'sans' },
    textAlign: { t: 'enum', values: M.TEXT_ALIGNS, def: 'left', desc: 'center/right 相对 maxWidth 生效' },
    bold: { t: 'boolean', def: false },
    italic: { t: 'boolean', def: false },
    lineHeight: { t: 'number', min: 0.8, max: 4, def: 1.3 },

    srcRef: { t: 'string', max: 64, req: true, desc: '图片句柄，只能用画布清单里列出的 srcRef（含用户刚上传的）；你无法自己生成图片数据' },
    children: { t: 'stringList', max: 64, desc: '容器包含的图形 id 列表' },
    title: { t: 'text', max: 200, desc: '容器标题' }
  };

  var BOX = ['x', 'y', 'w', 'h'];
  var COMMON = ['id', 'opacity', 'rotationDeg'];
  var TYPES = {
    rect: COMMON.concat(BOX, ['fill', 'stroke', 'strokeWidth', 'dash', 'radius']),
    roundRect: COMMON.concat(BOX, ['fill', 'stroke', 'strokeWidth', 'dash', 'radius']),
    ellipse: COMMON.concat(BOX, ['fill', 'stroke', 'strokeWidth', 'dash']),
    diamond: COMMON.concat(BOX, ['fill', 'stroke', 'strokeWidth', 'dash']),
    line: COMMON.concat(['x1', 'y1', 'x2', 'y2', 'stroke', 'strokeWidth', 'dash']),
    arrow: COMMON.concat(['x1', 'y1', 'x2', 'y2', 'stroke', 'strokeWidth', 'dash', 'arrowSize']),
    connector: COMMON.concat(['x1', 'y1', 'x2', 'y2', 'stroke', 'strokeWidth', 'dash', 'arrowStart', 'arrowEnd', 'startId', 'endId']),
    path: COMMON.concat(['points', 'smooth', 'closed', 'fill', 'stroke', 'strokeWidth', 'dash']),
    text: COMMON.concat(['x', 'y', 'text', 'maxWidth', 'fontSize', 'fontFamily', 'textAlign', 'bold', 'italic', 'lineHeight', 'fill']),
    image: COMMON.concat(BOX, ['srcRef', 'stroke', 'strokeWidth']),
    note: COMMON.concat(BOX, ['fill', 'stroke', 'strokeWidth', 'dash', 'radius', 'text', 'fontSize', 'fontFamily', 'textAlign', 'bold', 'italic', 'lineHeight']),
    group: COMMON.concat(BOX, ['fill', 'stroke', 'strokeWidth', 'dash', 'radius', 'title', 'children'])
  };

  // 模型最容易写错的字段 → 直接告诉它对应的正确字段
  var RENAMED = {
    rotation: 'rotationDeg（度数，不是弧度）',
    src: 'srcRef（句柄，你无法提供图片数据）',
    color: 'fill 或 stroke',
    fontWeight: 'bold: true',
    text: 'text 只有 type:"text" 的图形才有',
    width: 'w',
    height: 'h',
    left: 'x',
    top: 'y'
  };

  function describe(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array(' + v.length + ')';
    var t = typeof v;
    if (t === 'string') return 'string "' + v.slice(0, 24) + '"';
    return t + ' ' + String(v).slice(0, 24);
  }

  function Problems() { this.list = []; this.dropped = 0; }
  Problems.prototype.add = function (path, code, message, hint) {
    if (this.list.length >= MAX_PROBLEMS) { this.dropped += 1; return; }
    var p = { path: path, code: code, message: message };
    if (hint) p.hint = hint;
    this.list.push(p);
  };
  Problems.prototype.any = function () { return this.list.length > 0 || this.dropped > 0; };
  Problems.prototype.reject = function (summary) {
    return { ok: false, summary: summary, problems: this.list, truncated: this.dropped };
  };

  /** 校验单个字段。返回 {ok, value}；absent 表示用了缺省值 */
  function checkField(v, spec, path, probs) {
    if (v === undefined || v === null) {
      if (spec.req) {
        probs.add(path, 'missing', path + ' 是必填字段', spec.desc);
        return { ok: false };
      }
      return { ok: true, value: spec.def, absent: true };
    }
    if (spec.t === 'number') {
      if (typeof v !== 'number' || !isFinite(v)) {
        probs.add(path, 'wrong_type', path + ' 必须是有限数字，收到 ' + describe(v));
        return { ok: false };
      }
      if (v < spec.min || v > spec.max) {
        probs.add(path, 'out_of_range', path + ' ' + v + ' 超出范围 ' + spec.min + '..' + spec.max, spec.hint || spec.desc);
        return { ok: false };
      }
      return { ok: true, value: v };
    }
    if (spec.t === 'boolean') {
      if (typeof v !== 'boolean') {
        probs.add(path, 'wrong_type', path + ' 必须是 true 或 false，收到 ' + describe(v));
        return { ok: false };
      }
      return { ok: true, value: v };
    }
    if (spec.t === 'string') {
      if (typeof v !== 'string' || !v) {
        probs.add(path, 'wrong_type', path + ' 必须是非空字符串，收到 ' + describe(v));
        return { ok: false };
      }
      if (v.length > spec.max) {
        probs.add(path, 'out_of_range', path + ' 长度 ' + v.length + ' 超过 ' + spec.max);
        return { ok: false };
      }
      return { ok: true, value: v };
    }
    if (spec.t === 'stringList') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x || x.length > spec.max)) {
        probs.add(path, 'wrong_type', path + ' 必须是字符串数组');
        return { ok: false };
      }
      return { ok: true, value: v.slice(0, 400) };
    }
    if (spec.t === 'color') {
      if (typeof v !== 'string' || !HEX_RE.test(v.trim())) {
        probs.add(path, 'bad_color', path + ' 不是合法颜色: ' + describe(v),
          '只能用 #rgb / #rrggbb / #rrggbbaa 或 transparent，不能用颜色名');
        return { ok: false };
      }
      return { ok: true, value: v.trim() };
    }
    if (spec.t === 'enum') {
      if (spec.values.indexOf(v) < 0) {
        probs.add(path, 'bad_enum', path + ' 取值非法: ' + describe(v), '只能是 ' + spec.values.join(' / '));
        return { ok: false };
      }
      return { ok: true, value: v };
    }
    if (spec.t === 'text') {
      if (typeof v !== 'string') {
        probs.add(path, 'wrong_type', path + ' 必须是字符串，收到 ' + describe(v));
        return { ok: false };
      }
      if (!v.length) {
        probs.add(path, 'empty', path + ' 不能是空字符串', '不需要文字就别放 text 图形');
        return { ok: false };
      }
      if (v.length > LIMITS.maxTextLength) {
        probs.add(path, 'out_of_range', path + ' 长度 ' + v.length + ' 超过 ' + LIMITS.maxTextLength);
        return { ok: false };
      }
      return { ok: true, value: v.replace(/\r\n?/g, '\n') };
    }
    if (spec.t === 'points') {
      if (!Array.isArray(v)) {
        probs.add(path, 'wrong_type', path + ' 必须是数组 [[x,y],...]，收到 ' + describe(v));
        return { ok: false };
      }
      if (v.length < 2) {
        probs.add(path, 'out_of_range', path + ' 至少需要 2 个点，收到 ' + v.length);
        return { ok: false };
      }
      if (v.length > MAX_AGENT_POINTS) {
        probs.add(path, 'out_of_range', path + ' 点数 ' + v.length + ' 超过 ' + MAX_AGENT_POINTS);
        return { ok: false };
      }
      var out = [];
      for (var i = 0; i < v.length; i++) {
        var p = v[i];
        if (!Array.isArray(p) || p.length !== 2 ||
            typeof p[0] !== 'number' || !isFinite(p[0]) ||
            typeof p[1] !== 'number' || !isFinite(p[1])) {
          probs.add(path + '[' + i + ']', 'wrong_type', '每个点必须是 [x, y] 两个数字，收到 ' + describe(p));
          return { ok: false };
        }
        if (Math.abs(p[0]) > 100000 || Math.abs(p[1]) > 100000) {
          probs.add(path + '[' + i + ']', 'out_of_range', '坐标超出 ±100000');
          return { ok: false };
        }
        out.push([p[0], p[1]]);
      }
      return { ok: true, value: out };
    }
    probs.add(path, 'wrong_type', path + ' 无法校验');
    return { ok: false };
  }

  /**
   * 把校验通过的字段装成内部图形。
   * 键的写入顺序必须和 scene.js 的 sanitizeShape 完全一致，
   * 否则 JSON.stringify 出来的字节不同，往返不变式测试会挂。
   */
  function toInternal(type, v, srcRefs) {
    var s = {
      id: v.id || M.createId(),
      type: type,
      x: v.x === undefined ? 0 : v.x,
      y: v.y === undefined ? 0 : v.y,
      w: v.w === undefined ? 0 : v.w,
      h: v.h === undefined ? 0 : v.h,
      rotation: (v.rotationDeg || 0) * Math.PI / 180,
      stroke: v.stroke === undefined ? 'transparent' : v.stroke,
      fill: v.fill === undefined ? 'transparent' : v.fill,
      strokeWidth: v.strokeWidth === undefined ? 2 : v.strokeWidth,
      dash: v.dash === undefined ? 'solid' : v.dash,
      opacity: v.opacity === undefined ? 1 : v.opacity
    };
    if (type === 'rect' || type === 'roundRect' || type === 'note' || type === 'group') s.radius = v.radius === undefined ? 0 : v.radius;
    if (type === 'line' || type === 'arrow' || type === 'connector') {
      s.x1 = v.x1; s.y1 = v.y1; s.x2 = v.x2; s.y2 = v.y2;
      if (type === 'arrow') s.arrowSize = v.arrowSize === undefined ? 0 : v.arrowSize;
      if (type === 'connector') {
        s.arrowStart = v.arrowStart === true; s.arrowEnd = v.arrowEnd !== false;
        s.startId = v.startId || ''; s.endId = v.endId || '';
      }
    }
    if (type === 'path') {
      s.points = v.points;
      s.closed = v.closed === undefined ? false : v.closed;
      s.smooth = v.smooth === undefined ? false : v.smooth;
    }
    if (type === 'text') {
      s.text = v.text;
      s.fontSize = v.fontSize === undefined ? 24 : v.fontSize;
      s.fontFamily = v.fontFamily === undefined ? 'sans' : v.fontFamily;
      s.textAlign = v.textAlign === undefined ? 'left' : v.textAlign;
      s.lineHeight = v.lineHeight === undefined ? 1.3 : v.lineHeight;
      s.maxWidth = v.maxWidth === undefined ? 0 : v.maxWidth;
      s.bold = v.bold === undefined ? false : v.bold;
      s.italic = v.italic === undefined ? false : v.italic;
      if (v.fill === undefined) s.fill = '#1f2933';
    }
    if (type === 'image') s.src = srcRefs[v.srcRef];
    if (type === 'note') {
      s.text = v.text; s.fontSize = v.fontSize === undefined ? 20 : v.fontSize;
      s.fontFamily = v.fontFamily === undefined ? 'sans' : v.fontFamily;
      s.textAlign = v.textAlign === undefined ? 'left' : v.textAlign;
      s.lineHeight = v.lineHeight === undefined ? 1.3 : v.lineHeight;
      s.bold = v.bold === true; s.italic = v.italic === true;
    }
    if (type === 'group') {
      s.title = v.title || ''; s.children = Array.isArray(v.children) ? v.children.slice() : [];
    }
    return s;
  }

  /** 校验一个 agent 图形，返回内部图形或 null */
  function normalizeShape(raw, path, probs, opts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      probs.add(path, 'wrong_type', path + ' 必须是对象，收到 ' + describe(raw));
      return null;
    }
    var type = raw.type;
    if (typeof type !== 'string' || !TYPES[type]) {
      probs.add(path + '.type', 'bad_enum', 'type 非法: ' + describe(type),
        '只能是 ' + Object.keys(TYPES).join(' / '));
      return null;
    }
    var allowed = TYPES[type];
    // 计数要带上 dropped：problems 满 12 条后 list 不再增长，只看 list 会把有错的图形放过去
    var before = probs.list.length + probs.dropped;

    for (var key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      if (key === 'type' || allowed.indexOf(key) >= 0) continue;
      probs.add(path + '.' + key, 'unknown_field',
        type + ' 不认识字段 ' + key,
        RENAMED[key] ? '你想要的可能是 ' + RENAMED[key] : type + ' 允许的字段: ' + allowed.join(', '));
    }

    var vals = {};
    for (var i = 0; i < allowed.length; i++) {
      var name = allowed[i];
      var res = checkField(raw[name], F[name], path + '.' + name, probs);
      if (res.ok && !res.absent) vals[name] = res.value;
    }
    if (type === 'image' && vals.srcRef !== undefined && !opts.srcRefs[vals.srcRef]) {
      probs.add(path + '.srcRef', 'unknown_ref', '没有这个 srcRef: ' + vals.srcRef,
        '可用的: ' + (Object.keys(opts.srcRefs).join(', ') || '（当前场景没有任何图片）'));
    }
    if (probs.list.length + probs.dropped > before) return null;
    return toInternal(type, vals, opts.srcRefs);
  }

  /** 按「词 / 空格 / 单个 CJK 字」切成可断行单元。CJK 没有空格可断，必须逐字 */
  function splitUnits(line) {
    var chars = typeof Array.from === 'function' ? Array.from(line) : line.split('');
    var out = [];
    var buf = '';
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (ch === ' ' || ch === '\t' || CJK_RE.test(ch)) {
        if (buf) { out.push(buf); buf = ''; }
        out.push(ch);
      } else {
        buf += ch;
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  /**
   * 贪心换行。measure(text, shape) 由调用方注入：
   * 服务端传 node-canvas 度量器，浏览器传自己的，测试传确定性 stub。
   * 这样本函数不依赖任何 canvas 实现就能单测。
   */
  function wrapText(text, maxWidth, measure, shape) {
    var paragraphs = String(text).split('\n');
    var lines = [];
    for (var p = 0; p < paragraphs.length; p++) {
      var units = splitUnits(paragraphs[p]);
      var cur = '';
      for (var i = 0; i < units.length; i++) {
        var u = units[i];
        var next = cur + u;
        if (cur !== '' && measure(next, shape) > maxWidth) {
          lines.push(cur.replace(/[ \t]+$/, ''));
          cur = (u === ' ' || u === '\t') ? '' : u;
        } else {
          cur = next;
        }
      }
      lines.push(cur.replace(/[ \t]+$/, ''));
    }
    return lines;
  }

  /**
   * 把文字排版烘进场景：换行结果写成字面 \n，w/h 用度量结果填好。
   * 绝不能改成绘制时换行 —— 浏览器用 FONT_STACKS（PingFang/Helvetica），
   * 服务端用 registerFont 别名过的字体（通常是 Arial），绘制时算会断在不同位置，
   * 连行数都不一样，WYSIWYG 就没了。断行只在服务端算一次，结果进场景数据。
   */
  function bakeTextLayout(scene, measure) {
    for (var i = 0; i < scene.shapes.length; i++) {
      var s = scene.shapes[i];
      if (s.type !== 'text') continue;
      var maxWidth = s.maxWidth > 0 ? s.maxWidth : 0;
      var lines = maxWidth ? wrapText(s.text, maxWidth, measure, s) : String(s.text).split('\n');
      s.text = lines.join('\n');
      var widest = 0;
      for (var j = 0; j < lines.length; j++) {
        var lw = measure(lines[j] || ' ', s);
        if (lw > widest) widest = lw;
      }
      // 居中/右对齐是相对 b.w 算的，限了宽就必须用框宽，否则等于没对齐
      s.w = (maxWidth && s.textAlign !== 'left') ? Math.ceil(maxWidth) : Math.max(4, Math.ceil(widest));
      s.h = Math.max(s.fontSize, Math.ceil(lines.length * s.fontSize * s.lineHeight));
    }
    return scene;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  var SCENE_FIELDS = ['width', 'height', 'background', 'shapes'];

  function checkCanvasSize(v, name, max, probs) {
    if (typeof v !== 'number' || !isFinite(v)) {
      probs.add(name, 'wrong_type', name + ' 必须是数字，收到 ' + describe(v));
      return null;
    }
    if (v !== Math.round(v)) {
      probs.add(name, 'wrong_type', name + ' 必须是整数，收到 ' + v);
      return null;
    }
    if (v < 1 || v > max) {
      probs.add(name, 'out_of_range', name + ' ' + v + ' 超出范围 1..' + max);
      return null;
    }
    return v;
  }

  /**
   * 最终关卡：烘焙文字 → 过 SceneModel.validateScene。
   * validateScene 是安全边界且永不抛错，这里靠 warnings 必须为空来反证严格层没有洞。
   */
  function finalize(scene, probs, opts) {
    bakeTextLayout(scene, opts.measure);
    var res = M.validateScene(scene);
    if (res.warnings.length) {
      probs.add('scene', 'internal',
        '严格层放过了 validateScene 要修的内容（这是 AIPaint 自身的 bug）: ' + res.warnings.join('; '));
      return null;
    }
    if (opts.assertInvariant && JSON.stringify(scene) !== JSON.stringify(res.scene)) {
      probs.add('scene', 'internal', '往返不变式被打破：validateScene 改动了字段');
      return null;
    }
    return res.scene;
  }

  /** 校验一批 agent 图形，检查 id 重复。返回内部图形数组或 null */
  function normalizeShapeList(list, probs, opts, seen) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = normalizeShape(list[i], 'shapes[' + i + ']', probs, opts);
      if (!s) continue;
      if (seen[s.id]) {
        probs.add('shapes[' + i + '].id', 'duplicate_id', 'id 重复: ' + s.id, '每个图形的 id 必须唯一；新建图形就别写 id');
        continue;
      }
      seen[s.id] = true;
      out.push(s);
    }
    return probs.any() ? null : out;
  }

  /** set_scene：全量替换。opts: { measure, srcRefs, assertInvariant } */
  function normalizeAgentScene(raw, opts) {
    opts = opts || {};
    opts.srcRefs = opts.srcRefs || {};
    if (typeof opts.measure !== 'function') throw new Error('normalizeAgentScene 需要 opts.measure');
    var probs = new Problems();

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      probs.add('scene', 'wrong_type', 'scene 必须是对象，收到 ' + describe(raw));
      return probs.reject('scene 被拒绝');
    }
    for (var key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      if (SCENE_FIELDS.indexOf(key) < 0) {
        probs.add('scene.' + key, 'unknown_field', 'scene 不认识字段 ' + key, '只能有 ' + SCENE_FIELDS.join(', '));
      }
    }
    var width = checkCanvasSize(raw.width, 'scene.width', LIMITS.maxWidth, probs);
    var height = checkCanvasSize(raw.height, 'scene.height', LIMITS.maxHeight, probs);
    var bg = checkField(raw.background, { t: 'color', def: '#ffffff' }, 'scene.background', probs);

    if (!Array.isArray(raw.shapes)) {
      probs.add('scene.shapes', 'wrong_type', 'shapes 必须是数组，收到 ' + describe(raw.shapes));
      return probs.reject('scene 被拒绝');
    }
    if (raw.shapes.length > MAX_AGENT_SHAPES) {
      probs.add('scene.shapes', 'too_many', '图形数 ' + raw.shapes.length + ' 超过 ' + MAX_AGENT_SHAPES);
      return probs.reject('scene 被拒绝');
    }

    var shapes = normalizeShapeList(raw.shapes, probs, opts, {});
    if (!shapes || probs.any()) return probs.reject('scene 被拒绝：' + (probs.list.length + probs.dropped) + ' 处问题');
    var ids = {};
    shapes.forEach(function (s) { ids[s.id] = true; });
    shapes.forEach(function (s, i) {
      if (s.type === 'group') {
        s.children = s.children.filter(function (id) {
          if (id === s.id || !ids[id]) {
            probs.add('scene.shapes[' + i + '].children', 'unknown_ref', '容器包含了无效图形 id: ' + id);
            return false;
          }
          return true;
        });
      }
      if (s.type === 'connector') {
        if (s.startId && !ids[s.startId]) {
          probs.add('scene.shapes[' + i + '].startId', 'unknown_ref', '连接线起点不存在: ' + s.startId);
        }
        if (s.endId && !ids[s.endId]) {
          probs.add('scene.shapes[' + i + '].endId', 'unknown_ref', '连接线终点不存在: ' + s.endId);
        }
      }
    });
    if (probs.any()) return probs.reject('scene 被拒绝：存在无效图形引用');

    var scene = { width: width, height: height, background: bg.value, shapes: shapes };
    var finalScene = finalize(scene, probs, opts);
    if (!finalScene) return probs.reject('scene 被拒绝');
    return { ok: true, scene: finalScene, touchedIds: shapes.map(function (s) { return s.id; }) };
  }

  var OP_KINDS = ['update', 'add', 'delete', 'move', 'order', 'canvas'];
  var OP_FIELDS = {
    update: ['op', 'id', 'patch'],
    add: ['op', 'shape'],
    'delete': ['op', 'id'],
    move: ['op', 'id', 'dx', 'dy'],
    order: ['op', 'id', 'to'],
    canvas: ['op', 'width', 'height', 'background']
  };
  var ORDER_TO = ['front', 'back', 'forward', 'backward'];
  var MAX_AGENT_OPS = 200;
  var DELTA = { t: 'number', min: -100000, max: 100000, def: 0, desc: '位移量，可负' };

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function uniq(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      if (seen[list[i]]) continue;
      seen[list[i]] = true;
      out.push(list[i]);
    }
    return out;
  }

  /** 把校验过的 agent 字段写进内部图形（这里是规范字段名 → 内部字段名的唯一映射点） */
  function writeField(s, key, value, srcRefs) {
    if (key === 'rotationDeg') { s.rotation = value * Math.PI / 180; return; }
    if (key === 'srcRef') { s.src = srcRefs[value]; return; }
    s[key] = value;
  }

  function findIndex(shapes, id) {
    for (var i = 0; i < shapes.length; i++) if (shapes[i].id === id) return i;
    return -1;
  }

  /** 取 op 的目标图形下标；找不到就记问题并返回 -1 */
  function targetIndex(scene, raw, path, probs) {
    if (typeof raw.id !== 'string' || !raw.id) {
      probs.add(path + '.id', 'missing', path + '.id 是必填字段', '用场景清单里列出的图形 id');
      return -1;
    }
    var idx = findIndex(scene.shapes, raw.id);
    if (idx < 0) {
      probs.add(path + '.id', 'unknown_ref', '场景里没有这个 id: ' + raw.id,
        '只能改场景清单里列出的 id；要新图形用 op:"add"');
      return -1;
    }
    return idx;
  }

  /**
   * update 故意不走 normalizeShape：只校验 patch 里出现的字段，未提到的字段保持原样。
   * 手动编辑器允许 rgba()/颜色名（scene.js 的 COLOR_RE 更宽），若把整个图形拉回严格层重跑，
   * 「把它改成红色」会因为一个模型根本没碰过的 stroke 而失败。
   */
  function opUpdate(scene, raw, path, probs, opts, touched) {
    var i = targetIndex(scene, raw, path, probs);
    if (i < 0) return;
    var target = scene.shapes[i];
    var patch = raw.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      probs.add(path + '.patch', 'wrong_type', path + '.patch 必须是对象，收到 ' + describe(patch),
        '要改的属性放在 patch 里，例如 {"op":"update","id":"s1","patch":{"fill":"#e53e3e"}}');
      return;
    }
    if (patch.type !== undefined && patch.type !== target.type) {
      probs.add(path + '.patch.type', 'immutable', 'type 不能改：' + target.type + ' → ' + describe(patch.type),
        '删掉这个图形，再 add 一个新的');
      return;
    }
    var allowed = TYPES[target.type];
    var n = 0;
    for (var k in patch) {
      if (!hasOwn(patch, k) || k === 'id' || k === 'type') continue;
      if (allowed.indexOf(k) < 0) {
        probs.add(path + '.patch.' + k, 'unknown_field', target.type + ' 不认识字段 ' + k,
          RENAMED[k] ? '你想要的可能是 ' + RENAMED[k] : target.type + ' 允许的字段: ' + allowed.join(', '));
        continue;
      }
      var res = checkField(patch[k], F[k], path + '.patch.' + k, probs);
      if (!res.ok || res.absent) continue;
      if (k === 'srcRef' && !opts.srcRefs[res.value]) {
        probs.add(path + '.patch.srcRef', 'unknown_ref', '没有这个 srcRef: ' + res.value,
          '可用的: ' + (Object.keys(opts.srcRefs).join(', ') || '（当前场景没有任何图片）'));
        continue;
      }
      writeField(target, k, res.value, opts.srcRefs);
      n += 1;
    }
    if (!n) probs.add(path + '.patch', 'empty', 'patch 里没有任何要改的字段', '至少给一个属性，例如 fill:"#e53e3e"');
    touched.push(target.id);
  }

  function opAdd(scene, raw, path, probs, opts, touched) {
    if (scene.shapes.length >= MAX_AGENT_SHAPES) {
      probs.add(path, 'too_many', '图形数已达上限 ' + MAX_AGENT_SHAPES);
      return;
    }
    var s = normalizeShape(raw.shape, path + '.shape', probs, opts);
    if (!s) return;
    if (findIndex(scene.shapes, s.id) >= 0) {
      probs.add(path + '.shape.id', 'duplicate_id', 'id 已经存在: ' + s.id,
        '新建图形就别写 id；要改已有图形用 op:"update"');
      return;
    }
    scene.shapes.push(s);
    touched.push(s.id);
  }

  function opDelete(scene, raw, path, probs, touched) {
    var i = targetIndex(scene, raw, path, probs);
    if (i < 0) return;
    touched.push(scene.shapes[i].id);
    scene.shapes.splice(i, 1);
  }

  function opMove(scene, raw, path, probs, touched) {
    var i = targetIndex(scene, raw, path, probs);
    if (i < 0) return;
    var dx = checkField(raw.dx, DELTA, path + '.dx', probs);
    var dy = checkField(raw.dy, DELTA, path + '.dy', probs);
    if (!dx.ok || !dy.ok) return;
    M.translateShape(scene.shapes[i], dx.value || 0, dy.value || 0);
    touched.push(scene.shapes[i].id);
  }

  function opOrder(scene, raw, path, probs, touched) {
    var i = targetIndex(scene, raw, path, probs);
    if (i < 0) return;
    if (ORDER_TO.indexOf(raw.to) < 0) {
      probs.add(path + '.to', 'bad_enum', 'to 取值非法: ' + describe(raw.to), '只能是 ' + ORDER_TO.join(' / '));
      return;
    }
    var s = scene.shapes.splice(i, 1)[0];
    var at = raw.to === 'front' ? scene.shapes.length
      : raw.to === 'back' ? 0
        : raw.to === 'forward' ? Math.min(scene.shapes.length, i + 1)
          : Math.max(0, i - 1);
    scene.shapes.splice(at, 0, s);
    touched.push(s.id);
  }

  function opCanvas(scene, raw, path, probs) {
    var n = 0;
    if (raw.width !== undefined) {
      var w = checkCanvasSize(raw.width, path + '.width', LIMITS.maxWidth, probs);
      if (w === null) return;
      scene.width = w; n += 1;
    }
    if (raw.height !== undefined) {
      var h = checkCanvasSize(raw.height, path + '.height', LIMITS.maxHeight, probs);
      if (h === null) return;
      scene.height = h; n += 1;
    }
    if (raw.background !== undefined) {
      var b = checkField(raw.background, { t: 'color', req: true }, path + '.background', probs);
      if (!b.ok) return;
      scene.background = b.value; n += 1;
    }
    if (!n) probs.add(path, 'empty', path + ' 没给任何要改的字段', 'width / height / background 至少给一个');
  }

  function applyOne(scene, raw, path, probs, opts, touched) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      probs.add(path, 'wrong_type', path + ' 必须是对象，收到 ' + describe(raw));
      return;
    }
    var fields = OP_FIELDS[raw.op];
    if (!fields) {
      probs.add(path + '.op', 'bad_enum', 'op 非法: ' + describe(raw.op), '只能是 ' + OP_KINDS.join(' / '));
      return;
    }
    for (var k in raw) {
      if (hasOwn(raw, k) && fields.indexOf(k) < 0) {
        probs.add(path + '.' + k, 'unknown_field', 'op:"' + raw.op + '" 不认识字段 ' + k,
          raw.op + ' 只能有 ' + fields.join(', '));
      }
    }
    switch (raw.op) {
      case 'update': return opUpdate(scene, raw, path, probs, opts, touched);
      case 'add': return opAdd(scene, raw, path, probs, opts, touched);
      case 'delete': return opDelete(scene, raw, path, probs, touched);
      case 'move': return opMove(scene, raw, path, probs, touched);
      case 'order': return opOrder(scene, raw, path, probs, touched);
      case 'canvas': return opCanvas(scene, raw, path, probs);
    }
  }

  /**
   * edit_scene：增量修改，原子提交 —— 任何一处问题，传入的 scene 一个字节都不动。
   * 前置条件：scene 必须已经是 M.validateScene 的输出（服务端在会话入口做一次），
   * 否则基础场景自带的旧问题会被 finalize 当成严格层的 bug 报出来。
   */
  function applyOps(scene, ops, opts) {
    opts = opts || {};
    opts.srcRefs = opts.srcRefs || {};
    if (typeof opts.measure !== 'function') throw new Error('applyOps 需要 opts.measure');
    var probs = new Problems();

    if (!Array.isArray(ops)) {
      probs.add('ops', 'wrong_type', 'ops 必须是数组，收到 ' + describe(ops));
      return probs.reject('ops 被拒绝（场景未改动）');
    }
    if (!ops.length) {
      probs.add('ops', 'empty', 'ops 是空数组', '没有要改的东西就别调 edit_scene');
      return probs.reject('ops 被拒绝（场景未改动）');
    }
    if (ops.length > MAX_AGENT_OPS) {
      probs.add('ops', 'too_many', 'op 数 ' + ops.length + ' 超过 ' + MAX_AGENT_OPS, '拆成多次调用，或者用 set_scene 全量重画');
      return probs.reject('ops 被拒绝（场景未改动）');
    }

    var next = clone(scene);
    var touched = [];
    for (var i = 0; i < ops.length; i++) {
      applyOne(next, ops[i], 'ops[' + i + ']', probs, opts, touched);
      // problems 已经装满，后面的 op 再跑也报不出来，白算
      if (probs.list.length + probs.dropped >= MAX_PROBLEMS) break;
    }
    if (probs.any()) {
      return probs.reject('ops 被拒绝：' + (probs.list.length + probs.dropped) + ' 处问题（场景未改动）');
    }
    var finalScene = finalize(next, probs, opts);
    if (!finalScene) return probs.reject('ops 被拒绝（场景未改动）');
    return { ok: true, scene: finalScene, touchedIds: uniq(touched) };
  }

  /**
   * 图片句柄化。6MB base64 既不能进模型上下文，也不该每轮 clone 一遍。
   *
   * 占位符长得像 data URL 是刻意的：剥离后的场景还要过 M.validateScene（finalize 里），
   * 而它只放行 data:image/...;base64,xxx（scene.js 的 DATA_URL_RE）。占位符载荷用
   * AIPaintRef 前缀，正好落在 base64 字符类里，又不可能和真实图片数据撞上。
   *
   * 原地改 scene（调用方传的应该是 validateScene 刚吐出来的新对象）。
   *   srcRefs: ref → 占位符 data URL，作为 opts.srcRefs 交给 normalize/applyOps
   *   srcUrls: ref → 真实 data URL，留在会话里，回给浏览器前用 restoreImageSrc 还原
   */
  var REF_PREFIX = 'data:image/png;base64,AIPaintRef';

  function refFromSrc(src) {
    if (typeof src !== 'string' || src.indexOf(REF_PREFIX) !== 0) return null;
    var ref = src.slice(REF_PREFIX.length);
    return /^[A-Za-z0-9]+$/.test(ref) ? ref : null;
  }

  function stripImageSrc(scene) {
    var srcRefs = {}, srcUrls = {}, byUrl = {}, n = 0;
    for (var i = 0; i < scene.shapes.length; i++) {
      var s = scene.shapes[i];
      if (s.type !== 'image') continue;
      var already = refFromSrc(s.src);
      if (already) { srcRefs[already] = s.src; continue; }
      var ref = byUrl[s.src];
      if (!ref) {
        n += 1;
        ref = 'img' + n;
        byUrl[s.src] = ref;
        srcUrls[ref] = s.src;
        srcRefs[ref] = REF_PREFIX + ref;
      }
      s.src = srcRefs[ref];
    }
    return { scene: scene, srcRefs: srcRefs, srcUrls: srcUrls };
  }

  /** 还原真实图片数据。未知 ref 保留占位符：渲染器画个虚线框，比抛错好 */
  function restoreImageSrc(scene, srcUrls) {
    for (var i = 0; i < scene.shapes.length; i++) {
      var s = scene.shapes[i];
      if (s.type !== 'image') continue;
      var ref = refFromSrc(s.src);
      if (ref && srcUrls[ref]) s.src = srcUrls[ref];
    }
    return scene;
  }

  /**
   * 把用户这一轮上传的图片挂进同一套句柄机制，于是它成为「可放置的素材」。
   *
   * 这是模型唯一能得到新图片的途径，而且刻意只走这一条：三道 srcRef 闸门
   * （normalizeShape 的 unknown_ref、opUpdate 的 patch.srcRef、finalize 的
   * validateScene）判据全是 srcRefs 这张表，所以「注册了才能用」是构造上的，
   * 不是靠约定 —— 模型编一个 srcRef 出来照样被拒。
   *
   * 命名用 up1..upN：stripImageSrc 占的是 img1..imgN，两个前缀不会撞，
   * 而 refFromSrc 只要求 [A-Za-z0-9]+，upN 落在里面。
   *
   * 原地改 stripped（stripImageSrc 的返回值）。返回值给提示层用：
   * 上传图不在场景里，模型没有别的地方能知道它的名字和原始尺寸。
   */
  function registerUploads(stripped, uploads) {
    var out = [];
    var list = Array.isArray(uploads) ? uploads : [];
    for (var i = 0; i < list.length; i++) {
      var up = list[i];
      if (!up || up.kind !== 'image' || typeof up.dataUrl !== 'string' || !up.dataUrl) continue;
      // 避让已经占掉的句柄：场景里可能本来就带着 AIPaintRefup1 这样的占位符
      // （导入的 JSON、或上一轮因缺 srcUrls 而没能还原的那张），撞上去就会把画布上
      // 那个位置的图偷偷换成用户刚传的
      var k = out.length;
      var ref;
      do { k += 1; ref = 'up' + k; } while (stripped.srcRefs[ref]);
      stripped.srcRefs[ref] = REF_PREFIX + ref;
      stripped.srcUrls[ref] = up.dataUrl;
      out.push({ ref: ref, name: String(up.name || '图片'), w: Number(up.w) || 0, h: Number(up.h) || 0 });
    }
    return out;
  }

  var MAX_LISTED = 120;

  function fmt(n) { return String(Math.round(n * 10) / 10); }
  function clip(s, n) {
    var t = String(s).replace(/\n/g, '⏎');
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /** 一行一个图形，约 15 token；模型靠这个知道「这个」指的是谁 */
  function describeShape(s, i) {
    var b = M.shapeBBox(s);
    var p = ['[' + i + '] ' + s.id + ' ' + s.type,
      fmt(b.x) + ',' + fmt(b.y) + ' ' + fmt(b.w) + '×' + fmt(b.h)];
    if (M.isVisible(s.fill)) p.push('fill ' + s.fill);
    if (M.isVisible(s.stroke) && s.strokeWidth > 0) p.push('stroke ' + s.stroke + ' ' + fmt(s.strokeWidth) + (s.dash !== 'solid' ? ' ' + s.dash : ''));
    if (s.rotation) p.push('rot ' + fmt(s.rotation * 180 / Math.PI) + '°');
    if (s.opacity < 1) p.push('opacity ' + fmt(s.opacity));
    if (s.type === 'text') {
      p.push(fmt(s.fontSize) + 'px ' + s.fontFamily + (s.bold ? ' bold' : '') + (s.italic ? ' italic' : '') +
        (s.textAlign !== 'left' ? ' ' + s.textAlign : '') + (s.maxWidth ? ' maxWidth=' + fmt(s.maxWidth) : ''));
      p.push('"' + clip(s.text, 28) + '"');
    }
    if (s.type === 'path') p.push(s.points.length + ' 点' + (s.smooth ? ' 平滑' : ' 折线') + (s.closed ? ' 闭合' : ''));
    if (s.type === 'image') p.push('srcRef=' + (refFromSrc(s.src) || '?'));
    return p.join(' | ');
  }

  /** 场景清单，进系统提示。不含任何图片数据 */
  function explainScene(scene, opts) {
    var o = opts || {};
    var lines = ['画布 ' + scene.width + '×' + scene.height + '，背景 ' + scene.background];
    var n = scene.shapes.length;
    lines.push('图形 ' + n + ' 个（自下而上列出，后面的盖住前面的）：');
    if (!n) lines.push('  （空白画布）');
    for (var i = 0; i < Math.min(n, MAX_LISTED); i++) lines.push('  ' + describeShape(scene.shapes[i], i));
    if (n > MAX_LISTED) lines.push('  …还有 ' + (n - MAX_LISTED) + ' 个未列出，需要时先调 get_scene');
    var ups = o.uploads || [];
    var upSet = {};
    for (var u = 0; u < ups.length; u++) upSet[ups[u].ref] = true;
    var refs = [];
    var all = Object.keys(o.srcRefs || {});
    for (var r = 0; r < all.length; r++) if (!upSet[all[r]]) refs.push(all[r]);
    if (refs.length) lines.push('画布里已有的图片 srcRef：' + refs.join(', '));
    if (ups.length) {
      var parts = [];
      for (var v = 0; v < ups.length; v++) {
        var up = ups[v];
        // 宽高比这儿就算好：版面算术是这套「盲画」设计的已知弱项，能替它算的都替它算
        var wh = up.w && up.h ? '，' + up.w + '×' + up.h + ' 像素，宽高比 ' + fmt(up.w / up.h) : '';
        parts.push(up.ref + '（' + clip(up.name, 40) + wh + '）');
      }
      // 上传图不在场景里，所以尺寸得在这儿给：模型只能靠它算长宽比
      lines.push('用户刚上传、还没放进画布的图片：' + parts.join('、'));
      lines.push('  想用就 add 一个 image 并给 srcRef=对应句柄，w/h 按上面的宽高比定，别拉变形。');
    }
    if (refs.length || ups.length) lines.push('srcRef 只能用上面列出的这些，你无法自己生成图片数据。');
    if (o.selection && o.selection.length) {
      lines.push('用户当前选中：' + o.selection.join(', ') + '（用户说「这个」「它」时优先指这些）');
    }
    return lines.join('\n');
  }

  var MAX_NOTES = 10;

  function overlapArea(a, b) {
    var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    var h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return (w > 0 && h > 0) ? w * h : 0;
  }

  /**
   * 盲画的唯一反馈来源：模型看不到自己画出来的东西，只能靠这份体检报告发现
   * 「文字压在一起」「元素跑出画布」「和背景同色」这类肉眼一看就知道的问题。
   * 返回人话字符串数组，作为工具结果的 notes 回喂。
   */
  function auditScene(scene) {
    var notes = [];
    var texts = [];
    for (var i = 0; i < scene.shapes.length; i++) {
      var s = scene.shapes[i];
      var b = M.shapeBBox(s);
      var tag = s.id + '(' + s.type + ')';
      var line = s.type === 'line' || s.type === 'arrow';
      if ((b.w <= 0 && b.h <= 0) || (!line && (b.w <= 0 || b.h <= 0))) {
        notes.push(tag + ' 尺寸是 0，画不出来');
      }
      if (b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= scene.width || b.y >= scene.height) {
        notes.push(tag + ' 整个在画布外（' + fmt(b.x) + ',' + fmt(b.y) + '）');
      } else if (b.x < -1 || b.y < -1 || b.x + b.w > scene.width + 1 || b.y + b.h > scene.height + 1) {
        notes.push(tag + ' 超出画布边缘会被裁掉（右下角 ' + fmt(b.x + b.w) + ',' + fmt(b.y + b.h) +
          '，画布 ' + scene.width + '×' + scene.height + '）');
      }
      if (s.opacity < 0.05) notes.push(tag + ' opacity ' + fmt(s.opacity) + '，几乎全透明');
      var hasStroke = M.isVisible(s.stroke) && s.strokeWidth > 0;
      if (s.type !== 'image' && !M.isVisible(s.fill) && !hasStroke) {
        notes.push(tag + ' fill 和 stroke 都不可见，什么都不会显示');
      } else if (s.fill === scene.background && !hasStroke) {
        notes.push(tag + ' fill 和背景同色（' + s.fill + '），看不见');
      }
      if (s.type === 'text') texts.push({ tag: tag, b: b });
    }
    for (var a = 0; a < texts.length; a++) {
      for (var c = a + 1; c < texts.length; c++) {
        var area = overlapArea(texts[a].b, texts[c].b);
        if (!area) continue;
        var small = Math.min(texts[a].b.w * texts[a].b.h, texts[c].b.w * texts[c].b.h);
        if (small > 0 && area / small > 0.25) {
          notes.push('文字重叠：' + texts[a].tag + ' 和 ' + texts[c].tag + ' 压在一起');
        }
      }
    }
    if (notes.length > MAX_NOTES) {
      var rest = notes.length - MAX_NOTES;
      notes = notes.slice(0, MAX_NOTES);
      notes.push('…还有 ' + rest + ' 条同类问题');
    }
    return notes;
  }

  /* ---------- JSON Schema：和运行时校验共用 F/TYPES，两边不可能漂移 ---------- */

  function jsonFor(spec) {
    var j = {};
    var d = spec.desc || '';
    if (spec.t === 'number') {
      j.type = 'number'; j.minimum = spec.min; j.maximum = spec.max;
      d += (d ? '，' : '') + '范围 ' + spec.min + '..' + spec.max;
    } else if (spec.t === 'boolean') {
      j.type = 'boolean';
    } else if (spec.t === 'string') {
      j.type = 'string'; j.maxLength = spec.max;
    } else if (spec.t === 'stringList') {
      j.type = 'array'; j.maxItems = 400;
      j.items = { type: 'string', maxLength: spec.max };
    } else if (spec.t === 'text') {
      j.type = 'string'; j.maxLength = LIMITS.maxTextLength;
    } else if (spec.t === 'color') {
      j.type = 'string'; j.pattern = HEX_RE.source;
    } else if (spec.t === 'enum') {
      j.type = 'string'; j.enum = spec.values.slice();
    } else if (spec.t === 'points') {
      j.type = 'array'; j.minItems = 2; j.maxItems = MAX_AGENT_POINTS;
      j.items = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } };
    }
    // 缺省值写进 description：strict 模式会剥掉 default 关键字，但描述留得住
    if (spec.def !== undefined) d += (d ? '，' : '') + '缺省 ' + JSON.stringify(spec.def);
    if (d) j.description = d;
    return j;
  }

  function shapeSchema(type) {
    var props = { type: { type: 'string', enum: [type] } };
    var req = ['type'];
    var allowed = TYPES[type];
    for (var i = 0; i < allowed.length; i++) {
      props[allowed[i]] = jsonFor(F[allowed[i]]);
      if (F[allowed[i]].req) req.push(allowed[i]);
    }
    return { type: 'object', additionalProperties: false, properties: props, required: req };
  }

  function shapeAnyOf() {
    var out = [];
    for (var t in TYPES) if (hasOwn(TYPES, t)) out.push(shapeSchema(t));
    return out;
  }

  /** update 的 patch：所有类型字段的并集。「必须属于目标类型」由运行时校验兜住 */
  function patchSchema() {
    var names = {}, props = {};
    for (var t in TYPES) {
      if (!hasOwn(TYPES, t)) continue;
      for (var i = 0; i < TYPES[t].length; i++) names[TYPES[t][i]] = true;
    }
    delete names.id;
    for (var n in names) if (hasOwn(names, n)) props[n] = jsonFor(F[n]);
    return {
      type: 'object', additionalProperties: false, properties: props,
      description: '只放要改的字段，且必须是目标图形类型允许的字段；没提到的字段保持原样'
    };
  }

  var ID_PROP = { type: 'string', maxLength: 64, description: '目标图形 id，取自场景清单' };

  function sizeProp(max, what) {
    return { type: 'integer', minimum: 1, maximum: max, description: what + '（整数像素），范围 1..' + max };
  }

  function opSchema(kind, extra, req) {
    var props = { op: { type: 'string', enum: [kind] } };
    for (var k in extra) if (hasOwn(extra, k)) props[k] = extra[k];
    return {
      type: 'object', additionalProperties: false, properties: props,
      required: ['op'].concat(req || [])
    };
  }

  function opsAnyOf() {
    return [
      opSchema('update', { id: ID_PROP, patch: patchSchema() }, ['id', 'patch']),
      opSchema('add', { shape: { anyOf: shapeAnyOf(), description: '新图形，不要写 id，由服务端分配' } }, ['shape']),
      opSchema('delete', { id: ID_PROP }, ['id']),
      opSchema('move', { id: ID_PROP, dx: jsonFor(DELTA), dy: jsonFor(DELTA) }, ['id', 'dx', 'dy']),
      opSchema('order', {
        id: ID_PROP,
        to: { type: 'string', enum: ORDER_TO.slice(), description: 'front=移到最上，back=最下，forward/backward=上下移一层' }
      }, ['id', 'to']),
      opSchema('canvas', {
        width: sizeProp(LIMITS.maxWidth, '画布宽度'),
        height: sizeProp(LIMITS.maxHeight, '画布高度'),
        background: jsonFor({ t: 'color', desc: '画布背景色' })
      }, [])
    ];
  }

  function sceneParams() {
    return {
      type: 'object', additionalProperties: false,
      properties: {
        width: sizeProp(LIMITS.maxWidth, '画布宽度'),
        height: sizeProp(LIMITS.maxHeight, '画布高度'),
        background: jsonFor({ t: 'color', desc: '画布背景色' }),
        shapes: {
          type: 'array', maxItems: MAX_AGENT_SHAPES,
          description: '自下而上，后面的盖住前面的',
          items: { anyOf: shapeAnyOf() }
        }
      },
      required: ['width', 'height', 'background', 'shapes']
    };
  }

  var SET_DESC = '全量替换整张画布：从零画一张新图，或者用户要求整体改版时用。' +
    '会覆盖现有的所有图形，所以只改一两个属性千万别用它。';
  var EDIT_DESC = '增量修改当前场景：改属性、挪位置、删元素、调层级、改画布尺寸都用它。' +
    '所有 op 原子提交 —— 有一个不合法就整批不生效，场景保持原样。';
  var GET_DESC = '重新读取当前场景清单（不含图片数据）。只有清单被截断或你需要确认最新状态时才调。';

  function toolSchemas() {
    return [
      { type: 'function', function: { name: 'set_scene', description: SET_DESC, parameters: sceneParams() } },
      {
        type: 'function',
        function: {
          name: 'edit_scene', description: EDIT_DESC,
          parameters: {
            type: 'object', additionalProperties: false,
            properties: {
              ops: {
                type: 'array', minItems: 1, maxItems: MAX_AGENT_OPS,
                description: '按顺序执行', items: { anyOf: opsAnyOf() }
              }
            },
            required: ['ops']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_scene', description: GET_DESC,
          parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] }
        }
      }
    ];
  }

  var STRICT_DROP = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'default', 'format'];

  /**
   * 转成 OpenAI structured-outputs 的 strict 子集：不认 minimum/pattern/maxItems 这些关键字，
   * 且要求每个属性都出现在 required 里 —— 可选属性只能写成 anyOf:[T, {type:'null'}]。
   * 剥掉这些约束不会放行非法场景：运行时校验层里它们全都还在。
   */
  function strictify(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      var arr = [];
      for (var i = 0; i < node.length; i++) arr.push(strictify(node[i]));
      return arr;
    }
    var out = {};
    for (var k in node) {
      if (!hasOwn(node, k) || STRICT_DROP.indexOf(k) >= 0) continue;
      out[k] = strictify(node[k]);
    }
    if (out.type === 'object' && out.properties) {
      var names = Object.keys(out.properties);
      var was = node.required || [];
      for (var j = 0; j < names.length; j++) {
        if (was.indexOf(names[j]) >= 0) continue;
        var p = out.properties[names[j]];
        var wrapped = { anyOf: [p, { type: 'null' }] };
        if (p.description) wrapped.description = p.description + '（不需要就传 null）';
        out.properties[names[j]] = wrapped;
      }
      out.required = names;
      out.additionalProperties = false;
    }
    return out;
  }

  /** strict=true 时把三个工具都转成 strict 子集（配合 /beta base URL 使用） */
  function tools(strict) {
    var list = toolSchemas();
    if (!strict) return list;
    for (var i = 0; i < list.length; i++) {
      list[i].function.parameters = strictify(list[i].function.parameters);
      list[i].function.strict = true;
    }
    return list;
  }

  return {
    SPEC_VERSION: SPEC_VERSION,
    PALETTES: PALETTES,
    HEX_RE: HEX_RE,
    FIELDS: F,
    TYPES: TYPES,
    OP_KINDS: OP_KINDS,
    MAX_PROBLEMS: MAX_PROBLEMS,
    MAX_AGENT_SHAPES: MAX_AGENT_SHAPES,
    MAX_AGENT_POINTS: MAX_AGENT_POINTS,
    MAX_AGENT_OPS: MAX_AGENT_OPS,

    tools: tools,
    toolSchemas: toolSchemas,
    strictify: strictify,

    normalizeAgentScene: normalizeAgentScene,
    applyOps: applyOps,
    bakeTextLayout: bakeTextLayout,
    wrapText: wrapText,
    splitUnits: splitUnits,

    explainScene: explainScene,
    describeShape: describeShape,
    auditScene: auditScene,

    stripImageSrc: stripImageSrc,
    restoreImageSrc: restoreImageSrc,
    registerUploads: registerUploads,
    refFromSrc: refFromSrc
  };
});
