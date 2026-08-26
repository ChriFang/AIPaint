/**
 * 共享的场景数据模型（浏览器 + Node 双端复用）。
 * 场景 = { width, height, background, shapes: [...] }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SceneModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LIMITS = {
    maxWidth: 8000,
    maxHeight: 8000,
    maxShapes: 4000,
    maxPointsPerPath: 8000,
    maxTextLength: 4000,
    maxScale: 4,
    maxOutputPixels: 40e6,
    maxImageChars: 8 * 1024 * 1024
  };

  var SHAPE_TYPES = ['rect', 'ellipse', 'diamond', 'line', 'arrow', 'path', 'text', 'image'];
  var DASH_STYLES = ['solid', 'dashed', 'dotted'];
  var FONT_KEYS = ['sans', 'serif', 'mono'];
  var TEXT_ALIGNS = ['left', 'center', 'right'];

  // 浏览器端字体栈；服务端会用 registerFont 注册同名族尽量对齐
  var FONT_STACKS = {
    sans: '"Helvetica Neue", Helvetica, Arial, "PingFang SC", sans-serif',
    serif: 'Georgia, "Times New Roman", "Songti SC", serif',
    mono: '"SF Mono", Menlo, Consolas, monospace'
  };

  var DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
  var COLOR_RE = new RegExp(
    '^(#[0-9a-fA-F]{3,8}' +
    '|rgba?\\(\\s*[\\d.]+%?\\s*,\\s*[\\d.]+%?\\s*,\\s*[\\d.]+%?\\s*(,\\s*[\\d.]+%?\\s*)?\\)' +
    '|hsla?\\(\\s*[\\d.]+(deg)?\\s*,\\s*[\\d.]+%\\s*,\\s*[\\d.]+%\\s*(,\\s*[\\d.]+%?\\s*)?\\)' +
    '|transparent|none|[a-zA-Z]{3,20})$'
  );

  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function oneOf(v, list, fallback) { return list.indexOf(v) >= 0 ? v : fallback; }
  function color(v, fallback) {
    if (typeof v !== 'string') return fallback;
    var s = v.trim();
    if (!s || s.length > 64 || !COLOR_RE.test(s)) return fallback;
    return s;
  }
  function isVisible(paint) {
    return !!paint && paint !== 'transparent' && paint !== 'none';
  }

  var idSeq = 0;
  function createId() {
    idSeq += 1;
    return 's' + Date.now().toString(36) + '_' + idSeq.toString(36);
  }

  function defaultScene() {
    return { width: 1280, height: 800, background: '#ffffff', shapes: [] };
  }

  var STYLE_DEFAULTS = {
    stroke: '#1f2933',
    strokeWidth: 2,
    fill: 'transparent',
    dash: 'solid',
    opacity: 1,
    radius: 8,
    fontSize: 24,
    fontFamily: 'sans',
    textAlign: 'left',
    bold: false,
    italic: false
  };

  /** 创建一个带默认样式的图形 */
  function createShape(type, patch) {
    var s = {
      id: createId(),
      type: oneOf(type, SHAPE_TYPES, 'rect'),
      x: 0, y: 0, w: 100, h: 100,
      rotation: 0,
      stroke: STYLE_DEFAULTS.stroke,
      strokeWidth: STYLE_DEFAULTS.strokeWidth,
      fill: STYLE_DEFAULTS.fill,
      dash: STYLE_DEFAULTS.dash,
      opacity: 1
    };
    if (s.type === 'line' || s.type === 'arrow') {
      s.x1 = 0; s.y1 = 0; s.x2 = 100; s.y2 = 100;
    }
    if (s.type === 'path') s.points = [];
    if (s.type === 'rect') s.radius = STYLE_DEFAULTS.radius;
    if (s.type === 'text') {
      s.text = '';
      s.fontSize = STYLE_DEFAULTS.fontSize;
      s.fontFamily = STYLE_DEFAULTS.fontFamily;
      s.textAlign = STYLE_DEFAULTS.textAlign;
      s.bold = false;
      s.italic = false;
      s.fill = '#1f2933';
      s.stroke = 'transparent';
      s.w = 10; s.h = s.fontSize * 1.3;
    }
    if (s.type === 'image') { s.src = ''; s.stroke = 'transparent'; }
    if (patch) for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
    return s;
  }

  function normRect(ax, ay, bx, by) {
    return {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      w: Math.abs(bx - ax),
      h: Math.abs(by - ay)
    };
  }

  /** 图形未旋转时的包围盒（局部坐标系，同时也是旋转中心的依据） */
  function shapeBBox(s) {
    if (s.type === 'line' || s.type === 'arrow') {
      return normRect(num(s.x1, 0), num(s.y1, 0), num(s.x2, 0), num(s.y2, 0));
    }
    if (s.type === 'path') {
      var pts = s.points || [];
      if (!pts.length) return { x: num(s.x, 0), y: num(s.y, 0), w: 0, h: 0 };
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    return { x: num(s.x, 0), y: num(s.y, 0), w: num(s.w, 0), h: num(s.h, 0) };
  }

  function shapeCenter(s) {
    var b = shapeBBox(s);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  function unionBBox(shapes) {
    if (!shapes || !shapes.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < shapes.length; i++) {
      var b = shapeBBox(shapes[i]);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function translateShape(s, dx, dy) {
    if (s.type === 'line' || s.type === 'arrow') {
      s.x1 += dx; s.y1 += dy; s.x2 += dx; s.y2 += dy;
      return s;
    }
    if (s.type === 'path') {
      for (var i = 0; i < s.points.length; i++) {
        s.points[i] = [s.points[i][0] + dx, s.points[i][1] + dy];
      }
      return s;
    }
    s.x += dx; s.y += dy;
    return s;
  }

  /**
   * 把图形从 from 包围盒线性映射到 to 包围盒（缩放 + 平移）。
   * from 不必等于图形自身的包围盒，多选整体缩放时传的是并集包围盒。
   */
  function setShapeBox(s, from, to) {
    var sx = from.w > 0.0001 ? to.w / from.w : 1;
    var sy = from.h > 0.0001 ? to.h / from.h : 1;
    function mapX(v) { return to.x + (v - from.x) * sx; }
    function mapY(v) { return to.y + (v - from.y) * sy; }

    if (s.type === 'line' || s.type === 'arrow') {
      var nx1 = mapX(s.x1), ny1 = mapY(s.y1), nx2 = mapX(s.x2), ny2 = mapY(s.y2);
      s.x1 = nx1; s.y1 = ny1; s.x2 = nx2; s.y2 = ny2;
      return s;
    }
    if (s.type === 'path') {
      for (var i = 0; i < s.points.length; i++) {
        s.points[i] = [mapX(s.points[i][0]), mapY(s.points[i][1])];
      }
      return s;
    }
    if (s.type === 'text') {
      // 文本随高度等比缩放字号，避免拉伸变形
      s.fontSize = clamp(num(s.fontSize, 24) * sy, 4, 800);
    }
    var b = shapeBBox(s);
    var nb = normRect(mapX(b.x), mapY(b.y), mapX(b.x + b.w), mapY(b.y + b.h));
    s.x = nb.x; s.y = nb.y;
    s.w = Math.max(1, nb.w); s.h = Math.max(1, nb.h);
    return s;
  }

  function rotatePoint(p, origin, angle) {
    if (!angle) return { x: p.x, y: p.y };
    var c = Math.cos(angle), s = Math.sin(angle);
    var dx = p.x - origin.x, dy = p.y - origin.y;
    return { x: origin.x + dx * c - dy * s, y: origin.y + dx * s + dy * c };
  }

  function sanitizeShape(raw, warnings) {
    if (!raw || typeof raw !== 'object') return null;
    var type = oneOf(raw.type, SHAPE_TYPES, null);
    if (!type) { warnings.push('忽略未知图形类型: ' + String(raw.type).slice(0, 20)); return null; }

    var s = {
      id: typeof raw.id === 'string' ? raw.id.slice(0, 64) : createId(),
      type: type,
      x: clamp(num(raw.x, 0), -1e6, 1e6),
      y: clamp(num(raw.y, 0), -1e6, 1e6),
      w: clamp(num(raw.w, 0), 0, 1e6),
      h: clamp(num(raw.h, 0), 0, 1e6),
      rotation: clamp(num(raw.rotation, 0), -Math.PI * 4, Math.PI * 4),
      stroke: color(raw.stroke, 'transparent'),
      fill: color(raw.fill, 'transparent'),
      strokeWidth: clamp(num(raw.strokeWidth, 2), 0, 200),
      dash: oneOf(raw.dash, DASH_STYLES, 'solid'),
      opacity: clamp(num(raw.opacity, 1), 0, 1)
    };

    if (type === 'rect') s.radius = clamp(num(raw.radius, 0), 0, 1e5);

    if (type === 'line' || type === 'arrow') {
      s.x1 = clamp(num(raw.x1, 0), -1e6, 1e6);
      s.y1 = clamp(num(raw.y1, 0), -1e6, 1e6);
      s.x2 = clamp(num(raw.x2, 0), -1e6, 1e6);
      s.y2 = clamp(num(raw.y2, 0), -1e6, 1e6);
      if (type === 'arrow') s.arrowSize = clamp(num(raw.arrowSize, 0), 0, 200);
    }

    if (type === 'path') {
      var pts = Array.isArray(raw.points) ? raw.points : [];
      if (pts.length > LIMITS.maxPointsPerPath) {
        warnings.push('路径点数超限，已截断到 ' + LIMITS.maxPointsPerPath);
        pts = pts.slice(0, LIMITS.maxPointsPerPath);
      }
      s.points = [];
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (!Array.isArray(p) || !isFiniteNum(+p[0]) || !isFiniteNum(+p[1])) continue;
        s.points.push([clamp(+p[0], -1e6, 1e6), clamp(+p[1], -1e6, 1e6)]);
      }
      s.closed = !!raw.closed;
      if (!s.points.length) return null;
    }
    if (type === 'text') {
      var text = typeof raw.text === 'string' ? raw.text : '';
      if (text.length > LIMITS.maxTextLength) {
        warnings.push('文本超长，已截断');
        text = text.slice(0, LIMITS.maxTextLength);
      }
      if (raw.fill === undefined) s.fill = '#1f2933';
      s.text = text.replace(/\r\n?/g, '\n');
      s.fontSize = clamp(num(raw.fontSize, 24), 4, 800);
      s.fontFamily = oneOf(raw.fontFamily, FONT_KEYS, 'sans');
      s.textAlign = oneOf(raw.textAlign, TEXT_ALIGNS, 'left');
      s.lineHeight = clamp(num(raw.lineHeight, 1.3), 0.8, 4);
      s.bold = !!raw.bold;
      s.italic = !!raw.italic;
    }

    if (type === 'image') {
      var src = typeof raw.src === 'string' ? raw.src.trim() : '';
      // 只接受内联 data URL：避免服务端被诱导去请求任意地址（SSRF）
      if (!src || src.length > LIMITS.maxImageChars || !DATA_URL_RE.test(src)) {
        warnings.push('忽略图片：仅支持内联的 data:image/... base64 数据');
        return null;
      }
      s.src = src;
    }
    /* __APPEND_5__ */
    return s;
  }
  /**
   * 服务端入口：把不可信输入收敛成一个安全、可渲染的场景。
   * 返回 { scene, warnings }，非法字段回落到默认值而不是抛错。
   */
  function validateScene(input) {
    var warnings = [];
    var raw = (input && typeof input === 'object') ? input : {};
    var scene = {
      width: Math.round(clamp(num(raw.width, 1280), 1, LIMITS.maxWidth)),
      height: Math.round(clamp(num(raw.height, 800), 1, LIMITS.maxHeight)),
      background: color(raw.background, '#ffffff'),
      shapes: []
    };
    var list = Array.isArray(raw.shapes) ? raw.shapes : [];
    if (list.length > LIMITS.maxShapes) {
      warnings.push('图形数量超过 ' + LIMITS.maxShapes + '，已截断');
      list = list.slice(0, LIMITS.maxShapes);
    }
    for (var i = 0; i < list.length; i++) {
      var s = sanitizeShape(list[i], warnings);
      if (s) scene.shapes.push(s);
    }
    return { scene: scene, warnings: warnings };
  }

  return {
    LIMITS: LIMITS,
    SHAPE_TYPES: SHAPE_TYPES,
    DASH_STYLES: DASH_STYLES,
    FONT_KEYS: FONT_KEYS,
    FONT_STACKS: FONT_STACKS,
    TEXT_ALIGNS: TEXT_ALIGNS,
    STYLE_DEFAULTS: STYLE_DEFAULTS,
    defaultScene: defaultScene,
    createShape: createShape,
    createId: createId,
    shapeBBox: shapeBBox,
    shapeCenter: shapeCenter,
    unionBBox: unionBBox,
    translateShape: translateShape,
    setShapeBox: setShapeBox,
    rotatePoint: rotatePoint,
    normRect: normRect,
    validateScene: validateScene,
    isVisible: isVisible,
    clamp: clamp,
    num: num
  };
});
