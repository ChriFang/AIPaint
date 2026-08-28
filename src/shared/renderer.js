/**
 * 共享渲染器：浏览器预览与服务端导出走同一套绘制逻辑，
 * 所见即所得靠的就是这个文件在两端复用。
 * 只依赖 CanvasRenderingContext2D 的通用 API（node-canvas 兼容）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./scene.js'));
  else root.SceneRenderer = factory(root.SceneModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SceneModel) {
  'use strict';

  var isVisible = SceneModel.isVisible;
  var num = SceneModel.num;
  var clamp = SceneModel.clamp;

  function resolveFont(shape, opts) {
    var key = shape.fontFamily || 'sans';
    var map = (opts && opts.fonts) || SceneModel.FONT_STACKS;
    var family = map[key] || SceneModel.FONT_STACKS[key] || 'sans-serif';
    var size = clamp(num(shape.fontSize, 24), 4, 800);
    var style = shape.italic ? 'italic ' : '';
    var weight = shape.bold ? '700 ' : '400 ';
    return style + weight + size + 'px ' + family;
  }

  function dashPattern(dash, lineWidth) {
    var w = Math.max(1, lineWidth || 1);
    if (dash === 'dashed') return [w * 3.5, w * 2.5];
    if (dash === 'dotted') return [0.1, w * 2.2];
    return [];
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    var rr = Math.max(0, Math.min(r || 0, Math.min(Math.abs(w), Math.abs(h)) / 2));
    ctx.beginPath();
    if (rr <= 0.01) { ctx.rect(x, y, w, h); return; }
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }
  function paint(ctx, shape) {
    if (isVisible(shape.fill)) {
      ctx.fillStyle = shape.fill;
      ctx.fill();
    }
    if (isVisible(shape.stroke) && num(shape.strokeWidth, 0) > 0) {
      ctx.strokeStyle = shape.stroke;
      ctx.stroke();
    }
  }

  function drawEllipse(ctx, b) {
    ctx.beginPath();
    if (typeof ctx.ellipse === 'function') {
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.abs(b.w) / 2, Math.abs(b.h) / 2, 0, 0, Math.PI * 2);
    } else {
      // 兜底：用缩放圆近似
      ctx.save();
      ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
      ctx.scale(Math.max(0.0001, Math.abs(b.w) / 2), Math.max(0.0001, Math.abs(b.h) / 2));
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.restore();
    }
  }

  function drawDiamond(ctx, b) {
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.beginPath();
    ctx.moveTo(cx, b.y);
    ctx.lineTo(b.x + b.w, cy);
    ctx.lineTo(cx, b.y + b.h);
    ctx.lineTo(b.x, cy);
    ctx.closePath();
  }

  function drawArrowHead(ctx, shape, x, y, angle) {
    var dx = x === undefined ? shape.x2 - shape.x1 : x;
    var dy = y === undefined ? shape.y2 - shape.y1 : y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) return;
    var lw = Math.max(1, num(shape.strokeWidth, 2));
    var size = num(shape.arrowSize, 0) || clamp(lw * 4.5, 8, Math.max(8, len * 0.45));
    var ang = angle === undefined ? Math.atan2(dy, dx) : angle;
    var spread = 0.42;
    ctx.beginPath();
    var tx = angle === undefined ? shape.x2 : shape.x1;
    var ty = angle === undefined ? shape.y2 : shape.y1;
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - size * Math.cos(ang - spread), ty - size * Math.sin(ang - spread));
    ctx.lineTo(tx - size * Math.cos(ang + spread), ty - size * Math.sin(ang + spread));
    ctx.closePath();
    ctx.fillStyle = isVisible(shape.stroke) ? shape.stroke : '#1f2933';
    ctx.setLineDash([]);
    ctx.fill();
  }
  function drawTextCard(ctx, shape, opts) {
    roundRectPath(ctx, shape.x, shape.y, shape.w, shape.h, num(shape.radius, 12));
    paint(ctx, shape);
    drawText(ctx, shape, opts);
  }
  /**
   * 路径描边。smooth !== false 时用二次贝塞尔在相邻点中点之间过渡，得到顺滑的手绘线；
   * smooth === false 时逐点 lineTo，点就是顶点 —— 三角形、折线图、非正交连接线需要这个，
   * 且这也是 view.js 的 hit-test（distToSegment）一直假设的形状。
   */
  function drawFreehand(ctx, pts, closed, smooth) {
    ctx.beginPath();
    if (!pts || !pts.length) return;
    if (pts.length === 1) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
      return;
    }
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (smooth === false || pts.length === 2) {
      for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
    } else {
      for (var i = 1; i < pts.length - 1; i++) {
        var mx = (pts[i][0] + pts[i + 1][0]) / 2;
        var my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      var last = pts[pts.length - 1];
      ctx.lineTo(last[0], last[1]);
    }
    if (closed) ctx.closePath();
  }

  function textLines(shape) {
    return String(shape.text == null ? '' : shape.text).split('\n');
  }

  /** 依据文本内容量出包围盒尺寸，浏览器端用来自动撑开文本框 */
  function measureTextShape(ctx, shape, opts) {
    ctx.save();
    ctx.font = resolveFont(shape, opts);
    var lines = textLines(shape);
    var w = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = ctx.measureText(lines[i] || ' ');
      if (m.width > w) w = m.width;
    }
    ctx.restore();
    var size = clamp(num(shape.fontSize, 24), 4, 800);
    var lh = clamp(num(shape.lineHeight, 1.3), 0.8, 4);
    return { w: Math.max(4, Math.ceil(w)), h: Math.max(size, Math.ceil(lines.length * size * lh)) };
  }
  function drawText(ctx, shape, opts) {
    var b = SceneModel.shapeBBox(shape);
    var size = clamp(num(shape.fontSize, 24), 4, 800);
    var lh = clamp(num(shape.lineHeight, 1.3), 0.8, 4);
    var lines = textLines(shape);
    ctx.font = resolveFont(shape, opts);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.setLineDash([]);
    var fill = isVisible(shape.fill) ? shape.fill : null;
    var strokeOn = isVisible(shape.stroke) && num(shape.strokeWidth, 0) > 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var x = b.x;
      if (shape.textAlign === 'center' || shape.textAlign === 'right') {
        var lw = ctx.measureText(line).width;
        x = shape.textAlign === 'center' ? b.x + (b.w - lw) / 2 : b.x + b.w - lw;
      }
      var y = b.y + i * size * lh + (size * lh - size) / 2;
      if (fill) { ctx.fillStyle = fill; ctx.fillText(line, x, y); }
      if (strokeOn) { ctx.strokeStyle = shape.stroke; ctx.strokeText(line, x, y); }
    }
  }

  function drawImage(ctx, shape, opts) {
    var b = SceneModel.shapeBBox(shape);
    var img = opts && opts.images ? opts.images[shape.src] : null;
    if (!img) {
      // 占位框：图片未就绪时仍能看出版面
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(120,130,145,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);
      return;
    }
    ctx.drawImage(img, b.x, b.y, b.w, b.h);
    if (isVisible(shape.stroke) && num(shape.strokeWidth, 0) > 0) {
      roundRectPath(ctx, b.x, b.y, b.w, b.h, num(shape.radius, 0));
      ctx.strokeStyle = shape.stroke;
      ctx.stroke();
    }
  }
  function drawShape(ctx, shape, opts) {
    if (!shape || !shape.type) return;
    ctx.save();
    ctx.globalAlpha = clamp(num(shape.opacity, 1), 0, 1);
    ctx.lineWidth = Math.max(0, num(shape.strokeWidth, 2));
    ctx.lineJoin = 'round';
    ctx.lineCap = shape.dash === 'dotted' ? 'round' : 'round';
    ctx.setLineDash(dashPattern(shape.dash, ctx.lineWidth));

    var b = SceneModel.shapeBBox(shape);
    var rot = num(shape.rotation, 0);
    if (rot) {
      var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.translate(-cx, -cy);
    }

    switch (shape.type) {
      case 'rect':
        roundRectPath(ctx, b.x, b.y, b.w, b.h, num(shape.radius, 0));
        paint(ctx, shape);
        break;
      case 'roundRect':
        roundRectPath(ctx, b.x, b.y, b.w, b.h, num(shape.radius, 8));
        paint(ctx, shape);
        break;
      case 'ellipse':
        drawEllipse(ctx, b);
        paint(ctx, shape);
        break;
      case 'diamond':
        drawDiamond(ctx, b);
        paint(ctx, shape);
        break;
      case 'line':
      case 'arrow':
        ctx.beginPath();
        ctx.moveTo(shape.x1, shape.y1);
        ctx.lineTo(shape.x2, shape.y2);
        if (isVisible(shape.stroke) && ctx.lineWidth > 0) {
          ctx.strokeStyle = shape.stroke;
          ctx.stroke();
        }
        if (shape.type === 'arrow') drawArrowHead(ctx, shape);
        break;
      case 'connector':
        ctx.beginPath();
        ctx.moveTo(shape.x1, shape.y1);
        ctx.lineTo(shape.x2, shape.y2);
        if (isVisible(shape.stroke) && ctx.lineWidth > 0) {
          ctx.strokeStyle = shape.stroke; ctx.stroke();
        }
        if (shape.arrowEnd !== false) drawArrowHead(ctx, shape);
        if (shape.arrowStart) {
          drawArrowHead(ctx, { stroke: shape.stroke, strokeWidth: shape.strokeWidth,
            x1: shape.x2, y1: shape.y2, x2: shape.x1, y2: shape.y1 });
        }
        break;
      case 'path':
        drawFreehand(ctx, shape.points || [], shape.closed, shape.smooth);
        if (isVisible(shape.fill)) { ctx.fillStyle = shape.fill; ctx.fill(); }
        if (isVisible(shape.stroke) && ctx.lineWidth > 0) { ctx.strokeStyle = shape.stroke; ctx.stroke(); }
        break;
      case 'text': drawText(ctx, shape, opts); break;
      case 'note': drawTextCard(ctx, shape, opts); break;
      case 'group':
        roundRectPath(ctx, b.x, b.y, b.w, b.h, num(shape.radius, 8));
        paint(ctx, shape);
        if (shape.title) {
          var title = Object.assign({}, shape, { text: shape.title, x: b.x + 12, y: b.y + 8,
            w: Math.max(8, b.w - 24), h: num(shape.fontSize, 16) * 1.3,
            fill: isVisible(shape.stroke) ? shape.stroke : '#1f2933', stroke: 'transparent',
            fontSize: num(shape.fontSize, 16) });
          drawText(ctx, title, opts);
        }
        break;
      case 'image': drawImage(ctx, shape, opts); break;
    }
    ctx.restore();
  }
  /**
   * 渲染整个场景。调用方负责设置好 ctx 的缩放（导出倍率 / 屏幕 DPR）。
   * opts: { transparent, images: {src: Image}, fonts: {sans,serif,mono} }
   */
  function renderScene(ctx, scene, opts) {
    opts = opts || {};
    var w = num(scene.width, 1280), h = num(scene.height, 800);
    ctx.save();
    if (opts.clear !== false) ctx.clearRect(0, 0, w, h);
    if (!opts.transparent && isVisible(scene.background)) {
      ctx.fillStyle = scene.background;
      ctx.fillRect(0, 0, w, h);
    }
    if (opts.clipToCanvas !== false) {
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
    }
    var shapes = scene.shapes || [];
    for (var i = 0; i < shapes.length; i++) {
      try {
        drawShape(ctx, shapes[i], opts);
      } catch (err) {
        // 单个图形画失败不应该毁掉整张图
        if (opts.onError) opts.onError(err, shapes[i]);
      }
    }
    ctx.restore();
  }

  return {
    renderScene: renderScene,
    drawShape: drawShape,
    measureTextShape: measureTextShape,
    resolveFont: resolveFont,
    roundRectPath: roundRectPath,
    dashPattern: dashPattern,
    textLines: textLines
  };
});
