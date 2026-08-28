/**
 * 交互层：指针拖拽（绘制 / 移动 / 缩放 / 旋转 / 框选 / 平移）、
 * 键盘快捷键、画布内文本编辑。
 */
(function (global) {
  'use strict';
  var M = global.SceneModel;
  var Store = global.Store;
  var View = global.View;

  var SHAPE_TOOLS = { rect: 1, roundRect: 1, ellipse: 1, diamond: 1, line: 1, arrow: 1, connector: 1, note: 1 };
  var canvas = null;
  var textEditor = null;
  var drag = null;
  var spaceDown = false;
  var hoverCursor = 'default';

  function isVisible(v) { return M.isVisible(v); }

  /**
   * AI 模式下屏蔽「绘制」：工具键、拖拽出新图形、双击空白建文本。
   * 选中、移动、缩放、平移都保留 —— 选中是 agent 的输入（「把这个改成红色」）。
   * 查 DOM class 而不是查 Agent 模块：input.js 先加载，不能依赖 agent.js 已就位。
   */
  var appEl = null;
  function drawLocked() {
    if (!appEl) appEl = document.querySelector('.app');
    return !!(appEl && appEl.classList.contains('ai-mode'));
  }

  /** 新图形的初始样式，取自「最近一次使用」 */
  function styleFor(type) {
    var st = Store.state.style;
    var base = {
      stroke: st.stroke,
      strokeWidth: st.strokeWidth,
      fill: st.fill,
      dash: st.dash,
      opacity: st.opacity
    };
    if (type === 'rect') base.radius = st.radius;
    if (type === 'line' || type === 'arrow' || type === 'path') base.fill = 'transparent';
    if (type === 'text') {
      base.fill = isVisible(st.fill) ? st.fill : (isVisible(st.stroke) ? st.stroke : '#1f2933');
      base.stroke = 'transparent';
      base.fontSize = st.fontSize;
      base.fontFamily = st.fontFamily;
      base.textAlign = st.textAlign;
      base.bold = st.bold;
      base.italic = st.italic;
    }
    return base;
  }

  function snapPoint(p) {
    return { x: View.snapValue(p.x), y: View.snapValue(p.y) };
  }
  /* ---------------- 文本编辑 ---------------- */

  function syncEditorBox(shape) {
    var v = Store.state.viewport;
    var b = M.shapeBBox(shape);
    var sp = View.worldToScreen({ x: b.x, y: b.y });
    var size = M.num(shape.fontSize, 24) * v.scale;
    var lh = M.num(shape.lineHeight, 1.3);
    textEditor.style.left = sp.x + 'px';
    textEditor.style.top = sp.y + 'px';
    textEditor.style.font = (shape.italic ? 'italic ' : '') + (shape.bold ? '700 ' : '400 ') +
      size + 'px ' + (M.FONT_STACKS[shape.fontFamily] || M.FONT_STACKS.sans);
    textEditor.style.lineHeight = lh;
    textEditor.style.color = isVisible(shape.fill) ? shape.fill : '#1f2933';
    textEditor.style.textAlign = shape.textAlign || 'left';
    textEditor.style.width = Math.max(24, b.w * v.scale + size * 0.8) + 'px';
    textEditor.style.height = Math.max(size * lh, b.h * v.scale) + 'px';
  }

  function openTextEditor(shape) {
    Store.state.editingTextId = shape.id;
    Store.setSelection([shape.id]);
    textEditor.hidden = false;
    textEditor.value = shape.text || '';
    syncEditorBox(shape);
    Store.touch();
    global.setTimeout(function () {
      textEditor.focus();
      textEditor.select();
    }, 0);
  }

  function closeTextEditor(opts) {
    var id = Store.state.editingTextId;
    if (!id) return;
    var shape = Store.shapeById(id);
    Store.state.editingTextId = null;
    textEditor.hidden = true;
    textEditor.blur();
    if (!shape) { Store.touch(); return; }
    if (opts && opts.cancel === true && opts.originalText != null) shape.text = opts.originalText;
    if (!String(shape.text || '').trim()) {
      // 空文本没有意义，直接丢掉
      Store.state.scene.shapes = Store.state.scene.shapes.filter(function (s) { return s.id !== id; });
      Store.setSelection([]);
    }
    Store.commit();
  }

  function onEditorInput() {
    var shape = Store.shapeById(Store.state.editingTextId);
    if (!shape) return;
    shape.text = textEditor.value;
    var m = View.measureText(shape);
    shape.w = m.w;
    shape.h = m.h;
    syncEditorBox(shape);
    Store.touch();
  }
  /* ---------------- 拖拽辅助 ---------------- */

  /** 把几何字段从快照恢复回图形，供拖拽过程中反复重算 */
  function resetGeom(target, src) {
    target.x = src.x; target.y = src.y; target.w = src.w; target.h = src.h;
    if (src.x1 !== undefined) { target.x1 = src.x1; target.y1 = src.y1; target.x2 = src.x2; target.y2 = src.y2; }
    if (src.points) {
      target.points = src.points.map(function (p) { return [p[0], p[1]]; });
    }
    target.rotation = src.rotation;
    if (src.fontSize !== undefined) target.fontSize = src.fontSize;
  }

  function snapshotSelection() {
    return Store.selectedShapes().map(function (s) {
      return { id: s.id, geom: Store.clone(s), box: M.shapeBBox(s) };
    });
  }

  function snapAngle(rad, stepDeg) {
    var step = (stepDeg || 15) * Math.PI / 180;
    return Math.round(rad / step) * step;
  }

  /** 按控制点计算新的包围盒；rot 不为 0 时先转到局部坐标系再算 */
  function resizeBox(startBox, handle, worldPt, rot, keepRatio) {
    var cx = startBox.x + startBox.w / 2, cy = startBox.y + startBox.h / 2;
    var p = M.rotatePoint(worldPt, { x: cx, y: cy }, -rot);
    if (!rot) p = snapPoint(p);

    var west = handle.indexOf('w') >= 0, east = handle.indexOf('e') >= 0;
    var north = handle.indexOf('n') >= 0, south = handle.indexOf('s') >= 0;
    var nb;

    if (keepRatio && (west || east) && (north || south)) {
      var ax = east ? startBox.x : startBox.x + startBox.w;
      var ay = south ? startBox.y : startBox.y + startBox.h;
      var ratio = startBox.w / Math.max(0.001, startBox.h);
      var w = Math.abs(p.x - ax), h = Math.abs(p.y - ay);
      if (w / Math.max(0.001, h) > ratio) h = w / ratio; else w = h * ratio;
      w = Math.max(1, w); h = Math.max(1, h);
      nb = { x: east ? ax : ax - w, y: south ? ay : ay - h, w: w, h: h };
    } else {
      var x1 = startBox.x, y1 = startBox.y;
      var x2 = startBox.x + startBox.w, y2 = startBox.y + startBox.h;
      if (west) x1 = p.x;
      if (east) x2 = p.x;
      if (north) y1 = p.y;
      if (south) y2 = p.y;
      nb = M.normRect(x1, y1, x2, y2);
      nb.w = Math.max(1, nb.w);
      nb.h = Math.max(1, nb.h);
    }
    // 局部坐标算完再转回世界坐标：保证旋转后拖拽方向仍然直观
    var nc = M.rotatePoint({ x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 }, { x: cx, y: cy }, rot);
    nb.x = nc.x - nb.w / 2;
    nb.y = nc.y - nb.h / 2;
    return nb;
  }
  /* ---------------- 开始各种拖拽 ---------------- */

  function startMove(wp) {
    var originals = snapshotSelection();
    if (!originals.length) return;
    drag = { mode: 'move', start: wp, originals: originals, moved: false };
  }
  function translateWithChildren(shape, dx, dy) {
    M.translateShape(shape, dx, dy);
    if (shape.type !== 'group') return;
    var children = shape.children || [];
    for (var i = 0; i < children.length; i++) {
      var child = Store.shapeById(children[i]);
      if (child) M.translateShape(child, dx, dy);
    }
  }

  function startResize(hit, wp) {
    drag = {
      mode: 'resize',
      handle: hit.name,
      startBox: hit.frame.box,
      rot: hit.frame.rot,
      shape: hit.frame.shape,
      originals: snapshotSelection(),
      start: wp
    };
  }

  function startRotate(hit, wp) {
    var box = hit.frame.box;
    var c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    drag = {
      mode: 'rotate',
      shape: hit.frame.shape,
      center: c,
      startAngle: Math.atan2(wp.y - c.y, wp.x - c.x),
      origRot: M.num(hit.frame.shape.rotation, 0)
    };
  }

  function startDraw(tool, wp) {
    var p = snapPoint(wp);
    var patch = (tool === 'line' || tool === 'arrow' || tool === 'connector')
      ? { x1: p.x, y1: p.y, x2: p.x, y2: p.y }
      : { x: p.x, y: p.y, w: 0, h: 0 };
    var shape = M.createShape(tool, Object.assign(patch, styleFor(tool)));
    View.draft = shape;
    drag = { mode: 'draw', tool: tool, start: p, shape: shape };
    Store.touch();
  }

  function startPen(wp) {
    var shape = M.createShape('path', Object.assign({ points: [[wp.x, wp.y]] }, styleFor('path')));
    if (M.num(shape.strokeWidth, 2) <= 0) shape.strokeWidth = 2;
    if (!isVisible(shape.stroke)) shape.stroke = '#1f2933';
    View.draft = shape;
    drag = { mode: 'pen', shape: shape };
    Store.touch();
  }

  function createText(wp) {
    var p = snapPoint(wp);
    var shape = M.createShape('text', Object.assign({ x: p.x, y: p.y, text: '' }, styleFor('text')));
    var m = View.measureText(shape);
    shape.w = m.w; shape.h = m.h;
    Store.addShape(shape);
    Store.setTool('select');
    openTextEditor(shape);
  }
  function createGroup() {
    var ids = Store.state.selection.slice();
    if (ids.length < 2) return;
    var children = Store.selectedShapes();
    var box = M.unionBBox(children);
    var group = M.createShape('group', {
      x: box.x - 16, y: box.y - 30, w: box.w + 32, h: box.h + 46,
      children: ids.slice(), title: '分组'
    });
    Store.addShape(group);
    Store.setTool('select');
  }
  /* ---------------- 指针事件 ---------------- */

  function onPointerDown(ev) {
    if (ev.button === 2) return;
    // 触控笔/触摸等场景下可能捕获失败，失败也不该中断绘制
    try { canvas.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
    var wp = View.eventToWorld(ev);

    if (ev.button === 1 || spaceDown) {
      drag = { mode: 'pan', last: { x: ev.clientX, y: ev.clientY } };
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (Store.state.editingTextId) closeTextEditor();

    var tool = drawLocked() ? 'select' : Store.state.tool;
    if (tool === 'group') { createGroup(); return; }
    if (tool === 'select') {
      var h = View.handleAt(wp);
      if (h) {
        if (h.name === 'rotate') startRotate(h, wp);
        else startResize(h, wp);
        return;
      }
      var hit = View.hitTest(wp);
      if (hit) {
        var already = Store.state.selection.indexOf(hit.id) >= 0;
        if (ev.shiftKey) {
          Store.toggleSelection(hit.id);
          if (already) return;   // 刚被取消选中，不进入拖动
        } else if (!already) {
          Store.setSelection([hit.id]);
        }
        startMove(wp);
        return;
      }
      if (!ev.shiftKey) Store.setSelection([]);
      drag = { mode: 'marquee', start: wp, additive: ev.shiftKey, base: Store.state.selection.slice() };
      return;
    }
    if (tool === 'pen') { startPen(wp); return; }
    if (tool === 'text') { createText(wp); return; }
    if (tool === 'note') {
      var note = M.createShape('note', {
        x: wp.x, y: wp.y, w: 220, h: 140, text: '',
        stroke: Store.state.style.stroke, strokeWidth: Store.state.style.strokeWidth,
        opacity: Store.state.style.opacity
      });
      Store.addShape(note);
      Store.setTool('select');
      openTextEditor(note);
      return;
    }
    if (SHAPE_TOOLS[tool]) { startDraw(tool, wp); return; }
  }

  function updateHoverCursor(ev) {
    if (spaceDown) { canvas.style.cursor = 'grab'; return; }
    var tool = drawLocked() ? 'select' : Store.state.tool;
    if (tool !== 'select') { canvas.style.cursor = 'crosshair'; return; }
    var wp = View.eventToWorld(ev);
    var h = View.handleAt(wp);
    if (h) {
      canvas.style.cursor = h.name === 'rotate' ? 'grab' : CURSORS[h.name] || 'default';
      return;
    }
    canvas.style.cursor = View.hitTest(wp) ? 'move' : 'default';
  }

  var CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    p1: 'crosshair', p2: 'crosshair'
  };
  function onPointerMove(ev) {
    if (!drag) { updateHoverCursor(ev); return; }
    var wp = View.eventToWorld(ev);
    var i, s, o, p;

    if (drag.mode === 'pan') {
      View.panBy(ev.clientX - drag.last.x, ev.clientY - drag.last.y);
      drag.last = { x: ev.clientX, y: ev.clientY };
      return;
    }

    if (drag.mode === 'move') {
      var dx = wp.x - drag.start.x, dy = wp.y - drag.start.y;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (Store.state.grid.snap) {
        var anchor = drag.originals[0].box;
        dx = View.snapValue(anchor.x + dx) - anchor.x;
        dy = View.snapValue(anchor.y + dy) - anchor.y;
      }
      for (i = 0; i < drag.originals.length; i++) {
        o = drag.originals[i];
        s = Store.shapeById(o.id);
        if (!s) continue;
        resetGeom(s, o.geom);
        translateWithChildren(s, dx, dy);
      }
      drag.moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 0;
      Store.touch();
      return;
    }

    if (drag.mode === 'resize') {
      if (drag.handle === 'p1' || drag.handle === 'p2') {
        s = drag.shape;
        resetGeom(s, drag.originals[0].geom);
        p = snapPoint(wp);
        var fx = drag.handle === 'p1' ? s.x2 : s.x1;
        var fy = drag.handle === 'p1' ? s.y2 : s.y1;
        if (ev.shiftKey) {
          var ang = snapAngle(Math.atan2(p.y - fy, p.x - fx));
          var len = Math.hypot(p.x - fx, p.y - fy);
          p = { x: fx + Math.cos(ang) * len, y: fy + Math.sin(ang) * len };
        }
        if (drag.handle === 'p1') { s.x1 = p.x; s.y1 = p.y; } else { s.x2 = p.x; s.y2 = p.y; }
        Store.touch();
        return;
      }
      var nb = resizeBox(drag.startBox, drag.handle, wp, drag.rot, ev.shiftKey);
      for (i = 0; i < drag.originals.length; i++) {
        o = drag.originals[i];
        s = Store.shapeById(o.id);
        if (!s) continue;
        resetGeom(s, o.geom);
        M.setShapeBox(s, drag.startBox, nb);
      }
      Store.touch();
      return;
    }
    if (drag.mode === 'rotate') {
      var a2 = Math.atan2(wp.y - drag.center.y, wp.x - drag.center.x);
      var rot = drag.origRot + (a2 - drag.startAngle);
      if (ev.shiftKey) rot = snapAngle(rot);
      drag.shape.rotation = rot;
      Store.touch();
      return;
    }

    if (drag.mode === 'marquee') {
      View.marquee = M.normRect(drag.start.x, drag.start.y, wp.x, wp.y);
      Store.touch();
      return;
    }

    if (drag.mode === 'draw') {
      s = drag.shape;
      p = snapPoint(wp);
      if (drag.tool === 'line' || drag.tool === 'arrow') {
        if (ev.shiftKey) {
          var la = snapAngle(Math.atan2(p.y - s.y1, p.x - s.x1));
          var ll = Math.hypot(p.x - s.x1, p.y - s.y1);
          p = { x: s.x1 + Math.cos(la) * ll, y: s.y1 + Math.sin(la) * ll };
        }
        s.x2 = p.x; s.y2 = p.y;
      } else {
        var box = M.normRect(drag.start.x, drag.start.y, p.x, p.y);
        if (ev.shiftKey) {
          var side = Math.max(box.w, box.h);
          box = {
            x: p.x < drag.start.x ? drag.start.x - side : drag.start.x,
            y: p.y < drag.start.y ? drag.start.y - side : drag.start.y,
            w: side, h: side
          };
        }
        s.x = box.x; s.y = box.y; s.w = box.w; s.h = box.h;
      }
      Store.touch();
      return;
    }

    if (drag.mode === 'pen') {
      var pts = drag.shape.points;
      var last = pts[pts.length - 1];
      var minDist = 2 / Store.state.viewport.scale;
      if (Math.hypot(wp.x - last[0], wp.y - last[1]) >= minDist && pts.length < M.LIMITS.maxPointsPerPath) {
        pts.push([wp.x, wp.y]);
      }
      Store.touch();
      return;
    }
    /* __APPEND_6__ */
  }
  function cancelDrag() {
    if (!drag) return false;
    var d = drag;
    drag = null;
    if (d.mode === 'draw' || d.mode === 'pen') {
      View.draft = null;
    } else if (d.originals) {
      for (var i = 0; i < d.originals.length; i++) {
        var s = Store.shapeById(d.originals[i].id);
        if (s) resetGeom(s, d.originals[i].geom);
      }
    } else if (d.mode === 'rotate' && d.shape) {
      d.shape.rotation = d.origRot;
    }
    View.marquee = null;
    canvas.style.cursor = 'default';
    Store.touch();
    return true;
  }

  function onPointerUp(ev) {
    if (!drag) return;
    var d = drag;
    drag = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }

    if (d.mode === 'pan') {
      canvas.style.cursor = spaceDown ? 'grab' : 'default';
      return;
    }
    if (d.mode === 'marquee') {
      var m = View.marquee;
      View.marquee = null;
      if (m && (m.w > 1 || m.h > 1)) {
        var found = View.shapesInRect(m).map(function (s) { return s.id; });
        if (d.additive) {
          for (var i = 0; i < found.length; i++) {
            if (d.base.indexOf(found[i]) < 0) d.base.push(found[i]);
          }
          Store.setSelection(d.base);
        } else {
          Store.setSelection(found);
        }
      } else {
        Store.touch();
      }
      return;
    }
    if (d.mode === 'draw' || d.mode === 'pen') {
      var s2 = d.shape;
      View.draft = null;
      if (d.mode === 'pen') {
        if (!s2.points || s2.points.length < 2) { Store.touch(); return; }
      } else if (d.tool === 'line' || d.tool === 'arrow') {
        if (Math.hypot(s2.x2 - s2.x1, s2.y2 - s2.y1) < 4) { Store.touch(); return; }
      } else if (s2.w < 4 && s2.h < 4) {
        s2.w = 140;                        // 单击不拖 → 落一个默认尺寸的图形
        s2.h = d.tool === 'rect' ? 90 : 110;
      }
      Store.addShape(s2);
      if (d.mode !== 'pen') Store.setTool('select');  // 画笔保持连续书写
      return;
    }
    Store.commit();
  }
  function onDoubleClick(ev) {
    var wp = View.eventToWorld(ev);
    var hit = View.hitTest(wp);
    if (hit && hit.type === 'text') { openTextEditor(hit); return; }
    if (!hit && !drawLocked()) createText(wp);   // 双击空白处快速加文字（AI 模式不建）
  }

  function onWheel(ev) {
    ev.preventDefault();
    var rect = canvas.getBoundingClientRect();
    var anchor = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    if (ev.ctrlKey || ev.metaKey) {
      var factor = Math.exp(-ev.deltaY * 0.01);
      View.setZoom(Store.state.viewport.scale * factor, anchor);
    } else {
      View.panBy(-ev.deltaX, -ev.deltaY);
    }
  }

  function nudge(dx, dy) {
    var sel = Store.selectedShapes();
    if (!sel.length) return;
    for (var i = 0; i < sel.length; i++) M.translateShape(sel[i], dx, dy);
    Store.commit();
  }

  var TOOL_KEYS = {
    v: 'select', r: 'rect', o: 'ellipse', d: 'diamond',
    l: 'line', a: 'arrow', p: 'pen', t: 'text', i: 'image'
  };

  function isTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }
  function onKeyDown(ev) {
    if (Store.state.editingTextId) {
      if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))) {
        ev.preventDefault();
        closeTextEditor();
      }
      return;
    }
    if (isTyping(ev.target)) return;
    var mod = ev.metaKey || ev.ctrlKey;

    if (ev.code === 'Space' && !mod) {
      spaceDown = true;
      if (!drag) canvas.style.cursor = 'grab';
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Escape') {
      if (!cancelDrag()) Store.setSelection([]);
      return;
    }
    if (mod) {
      var k = ev.key.toLowerCase();
      if (k === 'z') { ev.preventDefault(); if (ev.shiftKey) Store.redo(); else Store.undo(); return; }
      if (k === 'y') { ev.preventDefault(); Store.redo(); return; }
      if (k === 'a') { ev.preventDefault(); Store.setSelection(Store.state.scene.shapes.map(function (s) { return s.id; })); return; }
      if (k === 'd') { ev.preventDefault(); Store.duplicateSelected(); return; }
      if (k === ']') { ev.preventDefault(); Store.reorder(ev.shiftKey ? 'front' : 'up'); return; }
      if (k === '[') { ev.preventDefault(); Store.reorder(ev.shiftKey ? 'back' : 'down'); return; }
      if (k === '0') { ev.preventDefault(); View.setZoom(1); return; }
      if (k === '=' || k === '+') { ev.preventDefault(); View.setZoom(Store.state.viewport.scale * 1.2); return; }
      if (k === '-') { ev.preventDefault(); View.setZoom(Store.state.viewport.scale / 1.2); return; }
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); Store.deleteSelected(); return; }
    if (ev.key === 'Enter') {
      var sel = Store.selectedShapes();
      if (sel.length === 1 && sel[0].type === 'text') { ev.preventDefault(); openTextEditor(sel[0]); }
      return;
    }
    if (ev.key.indexOf('Arrow') === 0) {
      ev.preventDefault();
      var step = ev.shiftKey ? 10 : 1;
      if (ev.key === 'ArrowLeft') nudge(-step, 0);
      else if (ev.key === 'ArrowRight') nudge(step, 0);
      else if (ev.key === 'ArrowUp') nudge(0, -step);
      else nudge(0, step);
      return;
    }
    if (ev.shiftKey && ev.key === '!') { View.fit(); return; }   // ⇧1 适应窗口
    var tool = TOOL_KEYS[ev.key.toLowerCase()];
    if (tool) {
      if (drawLocked()) return;   // AI 模式：工具键一律不响应（连 preventDefault 都不做）
      ev.preventDefault();
      if (tool === 'image') { if (global.UI && global.UI.pickImage) global.UI.pickImage(); return; }
      Store.setTool(tool);
    }
  }

  function onKeyUp(ev) {
    if (ev.code === 'Space') {
      spaceDown = false;
      if (!drag) canvas.style.cursor = 'default';
    }
  }
  function init(canvasEl, textEl) {
    canvas = canvasEl;
    textEditor = textEl;

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', function () { cancelDrag(); });
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    textEditor.addEventListener('input', onEditorInput);
    textEditor.addEventListener('blur', function () { closeTextEditor(); });

    global.addEventListener('keydown', onKeyDown);
    global.addEventListener('keyup', onKeyUp);
    global.addEventListener('blur', function () { spaceDown = false; });
  }

  global.Input = {
    init: init,
    openTextEditor: openTextEditor,
    closeTextEditor: closeTextEditor,
    isDragging: function () { return !!drag; }
  };
})(window);
