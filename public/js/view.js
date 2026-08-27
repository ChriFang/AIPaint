/**
 * 画布视图层：视口变换、屏幕绘制、命中测试、选中框控制点。
 * 场景内容用共享渲染器绘制，选中框等辅助元素画在屏幕坐标系里，
 * 这样控制点不会随缩放变粗变细。
 */
(function (global) {
  'use strict';
  var M = global.SceneModel;
  var R = global.SceneRenderer;
  var Store = global.Store;

  var HANDLE = 4.5;         // 控制点半边长（屏幕像素）
  var HANDLE_HIT = 8;       // 控制点命中半径
  var ROTATE_OFFSET = 24;   // 旋转手柄距顶边的距离

  var canvas = null;
  var ctx = null;
  var dpr = 1;
  var cssW = 0, cssH = 0;
  var imageCache = Object.create(null);
  var pendingImages = Object.create(null);

  var View = {
    draft: null,      // 正在拖拽绘制中的图形
    marquee: null,    // 框选矩形（世界坐标）
    snapGuides: null
  };

  function vp() { return Store.state.viewport; }

  function worldToScreen(p) {
    var v = vp();
    return { x: p.x * v.scale + v.tx, y: p.y * v.scale + v.ty };
  }

  function screenToWorld(p) {
    var v = vp();
    return { x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale };
  }

  /** 鼠标事件 → 世界坐标 */
  function eventToWorld(ev) {
    var rect = canvas.getBoundingClientRect();
    return screenToWorld({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
  }

  function pageRect() {
    var v = vp();
    var s = Store.state.scene;
    return { x: v.tx, y: v.ty, w: s.width * v.scale, h: s.height * v.scale };
  }
  function resize() {
    var rect = canvas.parentNode.getBoundingClientRect();
    var w = Math.max(1, Math.floor(rect.width));
    var h = Math.max(1, Math.floor(rect.height));
    var ratio = global.devicePixelRatio || 1;
    if (w === cssW && h === cssH && ratio === dpr) return false;
    cssW = w; cssH = h; dpr = ratio;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    return true;
  }

  /** 把画布缩放到刚好铺满可视区（留边距） */
  function fit(padding) {
    var pad = padding == null ? 48 : padding;
    var s = Store.state.scene;
    var v = vp();
    var scale = Math.min((cssW - pad * 2) / s.width, (cssH - pad * 2) / s.height);
    v.scale = M.clamp(scale, 0.02, 8);
    v.tx = (cssW - s.width * v.scale) / 2;
    v.ty = (cssH - s.height * v.scale) / 2;
    Store.touch();
  }

  function setZoom(next, anchor) {
    var v = vp();
    var scale = M.clamp(next, 0.05, 16);
    var a = anchor || { x: cssW / 2, y: cssH / 2 };
    var before = screenToWorld(a);
    v.scale = scale;
    v.tx = a.x - before.x * scale;
    v.ty = a.y - before.y * scale;
    Store.touch();
  }

  function panBy(dx, dy) {
    var v = vp();
    v.tx += dx;
    v.ty += dy;
    Store.touch();
  }

  /** 图片按需异步加载，加载完再触发一次重绘 */
  function imageFor(src) {
    if (!src) return null;
    if (imageCache[src]) return imageCache[src];
    if (pendingImages[src]) return null;
    pendingImages[src] = true;
    var img = new global.Image();
    img.onload = function () {
      imageCache[src] = img;
      delete pendingImages[src];
      Store.touch();
    };
    img.onerror = function () { delete pendingImages[src]; };
    img.src = src;
    return null;
  }
  function collectImages(shapes) {
    var map = Object.create(null);
    for (var i = 0; i < shapes.length; i++) {
      if (shapes[i].type !== 'image') continue;
      var img = imageFor(shapes[i].src);
      if (img) map[shapes[i].src] = img;
    }
    return map;
  }

  function drawCheckerboard(rect) {
    var size = 10;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = '#e3e6ea';
    var cols = Math.ceil(rect.w / size), rows = Math.ceil(rect.h / size);
    for (var r = 0; r < rows; r++) {
      for (var c = (r % 2); c < cols; c += 2) {
        ctx.fillRect(rect.x + c * size, rect.y + r * size, size, size);
      }
    }
    ctx.restore();
  }

  function drawPage(rect) {
    var scene = Store.state.scene;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#000';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();

    if (M.isVisible(scene.background)) {
      ctx.fillStyle = scene.background;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    } else {
      drawCheckerboard(rect);
    }
  }

  function drawGrid(rect) {
    var grid = Store.state.grid;
    if (!grid.show) return;
    var v = vp();
    var step = grid.size;
    while (step * v.scale < 8) step *= 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.lineWidth = 1;
    var scene = Store.state.scene;
    for (var i = 0; i * step <= scene.width; i++) {
      var x = Math.round(rect.x + i * step * v.scale) + 0.5;
      ctx.strokeStyle = (i * step) % (step * 5) === 0 ? 'rgba(90,105,130,0.30)' : 'rgba(90,105,130,0.14)';
      ctx.beginPath();
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.h);
      ctx.stroke();
    }
    for (var j = 0; j * step <= scene.height; j++) {
      var y = Math.round(rect.y + j * step * v.scale) + 0.5;
      ctx.strokeStyle = (j * step) % (step * 5) === 0 ? 'rgba(90,105,130,0.30)' : 'rgba(90,105,130,0.14)';
      ctx.beginPath();
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
      ctx.stroke();
    }
    ctx.restore();
  }
  /** 选中框：单选跟随图形旋转，多选用轴对齐的并集包围盒 */
  function selectionFrame() {
    var sel = Store.selectedShapes();
    if (!sel.length) return null;
    if (sel.length === 1) {
      return { box: M.shapeBBox(sel[0]), rot: M.num(sel[0].rotation, 0), shape: sel[0], single: true };
    }
    return { box: M.unionBBox(sel), rot: 0, shape: null, single: false };
  }

  var CORNERS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  function localHandlePoint(box, name) {
    var mx = box.x + box.w / 2, my = box.y + box.h / 2;
    switch (name) {
      case 'nw': return { x: box.x, y: box.y };
      case 'n': return { x: mx, y: box.y };
      case 'ne': return { x: box.x + box.w, y: box.y };
      case 'e': return { x: box.x + box.w, y: my };
      case 'se': return { x: box.x + box.w, y: box.y + box.h };
      case 's': return { x: mx, y: box.y + box.h };
      case 'sw': return { x: box.x, y: box.y + box.h };
      case 'w': return { x: box.x, y: my };
      default: return { x: mx, y: my };
    }
  }

  /** 返回世界坐标下的控制点（已按图形旋转摆好） */
  function handlesFor(frame) {
    if (!frame) return [];
    var out = [];
    var center = { x: frame.box.x + frame.box.w / 2, y: frame.box.y + frame.box.h / 2 };
    var s = frame.shape;

    if (frame.single && (s.type === 'line' || s.type === 'arrow')) {
      out.push({ name: 'p1', x: s.x1, y: s.y1 });
      out.push({ name: 'p2', x: s.x2, y: s.y2 });
      return out;
    }
    for (var i = 0; i < CORNERS.length; i++) {
      var p = localHandlePoint(frame.box, CORNERS[i]);
      var rp = M.rotatePoint(p, center, frame.rot);
      out.push({ name: CORNERS[i], x: rp.x, y: rp.y });
    }
    if (frame.single) {
      var top = { x: center.x, y: frame.box.y - ROTATE_OFFSET / vp().scale };
      var rr = M.rotatePoint(top, center, frame.rot);
      out.push({ name: 'rotate', x: rr.x, y: rr.y });
    }
    return out;
  }

  /** 命中控制点（按屏幕距离判断，缩放下手感一致） */
  function handleAt(worldPt) {
    var frame = selectionFrame();
    if (!frame) return null;
    var sp = worldToScreen(worldPt);
    var hs = handlesFor(frame);
    for (var i = 0; i < hs.length; i++) {
      var h = worldToScreen(hs[i]);
      if (Math.abs(h.x - sp.x) <= HANDLE_HIT && Math.abs(h.y - sp.y) <= HANDLE_HIT) {
        return { name: hs[i].name, frame: frame };
      }
    }
    return null;
  }
  function drawOverlay() {
    var v = vp();
    var sel = Store.selectedShapes();

    // 每个选中图形的轮廓
    for (var i = 0; i < sel.length; i++) {
      var b = M.shapeBBox(sel[i]);
      var rot = M.num(sel[i].rotation, 0);
      var c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      var pts = [
        M.rotatePoint({ x: b.x, y: b.y }, c, rot),
        M.rotatePoint({ x: b.x + b.w, y: b.y }, c, rot),
        M.rotatePoint({ x: b.x + b.w, y: b.y + b.h }, c, rot),
        M.rotatePoint({ x: b.x, y: b.y + b.h }, c, rot)
      ];
      ctx.save();
      ctx.strokeStyle = 'rgba(76,141,255,0.9)';
      ctx.lineWidth = 1;
      ctx.setLineDash(sel.length > 1 ? [4, 3] : []);
      ctx.beginPath();
      for (var k = 0; k < 4; k++) {
        var sp = worldToScreen(pts[k]);
        if (k === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    var frame = selectionFrame();
    if (frame) {
      if (!frame.single) {
        var fb = frame.box;
        var p0 = worldToScreen({ x: fb.x, y: fb.y });
        ctx.save();
        ctx.strokeStyle = 'rgba(76,141,255,0.95)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(p0.x) + 0.5, Math.round(p0.y) + 0.5, fb.w * v.scale, fb.h * v.scale);
        ctx.restore();
      }
      var hs = handlesFor(frame);
      var center = worldToScreen({ x: frame.box.x + frame.box.w / 2, y: frame.box.y + frame.box.h / 2 });
      for (var j = 0; j < hs.length; j++) {
        var h = worldToScreen(hs[j]);
        ctx.save();
        if (hs[j].name === 'rotate') {
          ctx.strokeStyle = 'rgba(76,141,255,0.7)';
          ctx.beginPath();
          ctx.moveTo(center.x, center.y);
          ctx.lineTo(h.x, h.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(h.x, h.y, HANDLE + 0.5, 0, Math.PI * 2);
        } else {
          ctx.beginPath();
          ctx.rect(h.x - HANDLE, h.y - HANDLE, HANDLE * 2, HANDLE * 2);
        }
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#4c8dff';
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    if (View.marquee) {
      var m = View.marquee;
      var a = worldToScreen({ x: m.x, y: m.y });
      ctx.save();
      ctx.fillStyle = 'rgba(76,141,255,0.12)';
      ctx.strokeStyle = 'rgba(76,141,255,0.85)';
      ctx.lineWidth = 1;
      ctx.fillRect(a.x, a.y, m.w * v.scale, m.h * v.scale);
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, m.w * v.scale, m.h * v.scale);
      ctx.restore();
    }
  }
  var rafId = 0;
  function render() {
    resize();
    var scene = Store.state.scene;
    var v = vp();
    var rect = pageRect();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    drawPage(rect);
    drawGrid(rect);

    var shapes = View.draft ? scene.shapes.concat([View.draft]) : scene.shapes;
    if (Store.state.editingTextId) {
      // 正在编辑的文本由覆盖层 textarea 显示，画布上先藏起来避免重影
      var editing = Store.state.editingTextId;
      shapes = shapes.filter(function (s) { return s.id !== editing; });
    }
    ctx.save();
    ctx.translate(v.tx, v.ty);
    ctx.scale(v.scale, v.scale);
    R.renderScene(ctx, { width: scene.width, height: scene.height, background: scene.background, shapes: shapes }, {
      clear: false,
      transparent: true,   // 底色已经由 drawPage 画好
      images: collectImages(shapes),
      fonts: M.FONT_STACKS
    });
    ctx.restore();

    drawOverlay();
  }

  function scheduleRender() {
    if (rafId) return;
    rafId = global.requestAnimationFrame(function () {
      rafId = 0;
      render();
    });
  }
  function distToSegment(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    var t = M.clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /** 单个图形的命中测试；worldPt 会先反旋转到图形局部坐标 */
  function hitShape(shape, worldPt) {
    var b = M.shapeBBox(shape);
    var c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    var lp = M.rotatePoint(worldPt, c, -M.num(shape.rotation, 0));
    var tol = Math.max(6 / vp().scale, M.num(shape.strokeWidth, 0) / 2 + 3 / vp().scale);

    if (shape.type === 'line' || shape.type === 'arrow') {
      return distToSegment(lp, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <= tol;
    }
    if (shape.type === 'path') {
      var pts = shape.points || [];
      if (pts.length === 1) return Math.hypot(lp.x - pts[0][0], lp.y - pts[0][1]) <= tol;
      for (var i = 0; i < pts.length - 1; i++) {
        var a = { x: pts[i][0], y: pts[i][1] };
        var d = { x: pts[i + 1][0], y: pts[i + 1][1] };
        if (distToSegment(lp, a, d) <= tol) return true;
      }
      return false;
    }
    if (shape.type === 'ellipse') {
      var rx = Math.max(b.w / 2, 0.01) + tol, ry = Math.max(b.h / 2, 0.01) + tol;
      var nx = (lp.x - c.x) / rx, ny = (lp.y - c.y) / ry;
      return nx * nx + ny * ny <= 1;
    }
    if (shape.type === 'diamond') {
      var ax = Math.max(b.w / 2, 0.01), ay = Math.max(b.h / 2, 0.01);
      return Math.abs(lp.x - c.x) / ax + Math.abs(lp.y - c.y) / ay <= 1 + tol / Math.min(ax, ay);
    }
    return lp.x >= b.x - tol && lp.x <= b.x + b.w + tol &&
           lp.y >= b.y - tol && lp.y <= b.y + b.h + tol;
  }

  /** 自上而下找第一个命中的图形 */
  function hitTest(worldPt) {
    var shapes = Store.state.scene.shapes;
    for (var i = shapes.length - 1; i >= 0; i--) {
      if (hitShape(shapes[i], worldPt)) return shapes[i];
    }
    return null;
  }

  function shapesInRect(rect) {
    var out = [];
    var shapes = Store.state.scene.shapes;
    for (var i = 0; i < shapes.length; i++) {
      var b = M.shapeBBox(shapes[i]);
      if (b.x + b.w >= rect.x && b.x <= rect.x + rect.w &&
          b.y + b.h >= rect.y && b.y <= rect.y + rect.h) out.push(shapes[i]);
    }
    return out;
  }
  /** 量文本尺寸：和服务端用同一套 measure 逻辑 */
  function measureText(shape) {
    return R.measureTextShape(ctx, shape, { fonts: M.FONT_STACKS });
  }

  function snapValue(v) {
    var grid = Store.state.grid;
    if (!grid.snap) return v;
    return Math.round(v / grid.size) * grid.size;
  }

  function init(el) {
    canvas = el;
    ctx = el.getContext('2d');
    resize();
    if (global.ResizeObserver) {
      new global.ResizeObserver(scheduleRender).observe(el.parentNode);
    } else {
      global.addEventListener('resize', scheduleRender);
    }
    global.addEventListener('resize', scheduleRender);
  }

  View.init = init;
  View.render = render;
  View.scheduleRender = scheduleRender;
  View.worldToScreen = worldToScreen;
  View.screenToWorld = screenToWorld;
  View.eventToWorld = eventToWorld;
  View.pageRect = pageRect;
  View.fit = fit;
  // fit() 读的 cssW/cssH 只在 render() 顶部的 resize() 里刷新。
  // 右侧面板出现/消失后要立刻按新宽度取景时，先调这个再调 fit()。
  View.refreshSize = resize;
  View.setZoom = setZoom;
  View.panBy = panBy;
  View.selectionFrame = selectionFrame;
  View.handlesFor = handlesFor;
  View.handleAt = handleAt;
  View.hitTest = hitTest;
  View.hitShape = hitShape;
  View.shapesInRect = shapesInRect;
  View.measureText = measureText;
  View.snapValue = snapValue;
  View.canvasEl = function () { return canvas; };
  View.size = function () { return { w: cssW, h: cssH }; };
  global.View = View;
})(window);
