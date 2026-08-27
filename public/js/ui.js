/**
 * 界面层：工具栏 / 属性面板 / 画布参数 / 导出与存档，以及启动装配。
 */
(function (global) {
  'use strict';
  var M = global.SceneModel;
  var Store = global.Store;
  var View = global.View;
  var doc = global.document;

  var lastFill = '#dbeafe';
  var lastStroke = '#1f2933';
  var statusTimer = 0;

  function $(id) { return doc.getElementById(id); }

  function status(msg, kind) {
    var el = $('status-msg');
    el.textContent = msg || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
    if (statusTimer) global.clearTimeout(statusTimer);
    if (msg) {
      statusTimer = global.setTimeout(function () {
        el.textContent = '';
        el.className = 'msg';
      }, 6000);
    }
  }

  /** 颜色输入框只认 #rrggbb，其它写法尽量转换，转不了就给个兜底色 */
  function toHex(color, fallback) {
    if (typeof color !== 'string') return fallback;
    var c = color.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(c)) {
      return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toLowerCase();
    }
    var m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
      return '#' + [m[1], m[2], m[3]].map(function (n) {
        return ('0' + Math.min(255, parseInt(n, 10)).toString(16)).slice(-2);
      }).join('');
    }
    return fallback;
  }

  function focused(el) { return doc.activeElement === el; }
  /* ---------------- 属性写入 ---------------- */

  /**
   * 有选中就改选中对象，没选中就改「默认样式」，
   * 这样先调好颜色再画图和先画图再调色都符合直觉。
   */
  function applyStyle(patch, transient) {
    var keys = Object.keys(patch);
    var styleKeys = {};
    for (var i = 0; i < keys.length; i++) {
      if (M.STYLE_DEFAULTS[keys[i]] !== undefined) styleKeys[keys[i]] = patch[keys[i]];
    }
    if (Object.keys(styleKeys).length) Store.setStyle(styleKeys);
    if (Store.state.selection.length) Store.patchSelected(patch, { transient: !!transient });
  }

  /** 几何输入框：作用在选中集合的整体包围盒上 */
  function applyGeometry(field, value) {
    var sel = Store.selectedShapes();
    if (!sel.length) return;
    var box = M.unionBBox(sel);
    var i;
    if (field === 'x' || field === 'y') {
      var dx = field === 'x' ? value - box.x : 0;
      var dy = field === 'y' ? value - box.y : 0;
      for (i = 0; i < sel.length; i++) M.translateShape(sel[i], dx, dy);
    } else if (field === 'w' || field === 'h') {
      var to = { x: box.x, y: box.y, w: box.w, h: box.h };
      to[field] = Math.max(1, value);
      for (i = 0; i < sel.length; i++) M.setShapeBox(sel[i], box, to);
    } else if (field === 'rotation') {
      for (i = 0; i < sel.length; i++) sel[i].rotation = value * Math.PI / 180;
    }
    Store.commit();
  }

  function bindRange(id, prop, opts) {
    var input = $(id);
    var out = $(id + '-out');
    var fmt = (opts && opts.format) || function (v) { return String(v); };
    function push(transient) {
      var v = parseFloat(input.value);
      if (out) out.textContent = fmt(v);
      var patch = {};
      patch[prop] = v;
      applyStyle(patch, transient);
    }
    // 拖动时实时预览，松手才写入撤销栈
    input.addEventListener('input', function () { push(true); });
    input.addEventListener('change', function () { push(false); });
  }
  function initProps() {
    // 填充 / 描边：颜色 + 「无」开关
    $('p-fill').addEventListener('input', function () {
      lastFill = this.value;
      $('p-fill-none').checked = false;
      applyStyle({ fill: this.value }, true);
    });
    $('p-fill').addEventListener('change', function () { applyStyle({ fill: this.value }); });
    $('p-fill-none').addEventListener('change', function () {
      applyStyle({ fill: this.checked ? 'transparent' : lastFill });
    });
    $('p-stroke').addEventListener('input', function () {
      lastStroke = this.value;
      $('p-stroke-none').checked = false;
      applyStyle({ stroke: this.value }, true);
    });
    $('p-stroke').addEventListener('change', function () { applyStyle({ stroke: this.value }); });
    $('p-stroke-none').addEventListener('change', function () {
      applyStyle({ stroke: this.checked ? 'transparent' : lastStroke });
    });

    bindRange('p-strokeWidth', 'strokeWidth');
    bindRange('p-radius', 'radius');
    bindRange('p-opacity', 'opacity', {
      format: function (v) { return Math.round(v * 100) + '%'; }
    });
    $('p-dash').addEventListener('change', function () { applyStyle({ dash: this.value }); });

    // 文本
    $('p-fontSize').addEventListener('change', function () {
      applyStyle({ fontSize: M.clamp(parseFloat(this.value) || 24, 4, 400) });
      remeasureTexts();
    });
    $('p-fontFamily').addEventListener('change', function () {
      applyStyle({ fontFamily: this.value });
      remeasureTexts();
    });
    $('p-textAlign').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button');
      if (btn) applyStyle({ textAlign: btn.dataset.val });
    });
    $('p-bold').addEventListener('click', function () {
      applyStyle({ bold: !currentSource().bold });
      remeasureTexts();
    });
    $('p-italic').addEventListener('click', function () {
      applyStyle({ italic: !currentSource().italic });
      remeasureTexts();
    });

    // 位置与尺寸
    ['x', 'y', 'w', 'h'].forEach(function (f) {
      $('p-' + f).addEventListener('change', function () {
        applyGeometry(f, parseFloat(this.value) || 0);
      });
    });
    var rot = $('p-rotation');
    rot.addEventListener('input', function () {
      $('p-rotation-out').textContent = this.value + '°';
      var sel = Store.selectedShapes();
      for (var i = 0; i < sel.length; i++) sel[i].rotation = this.value * Math.PI / 180;
      Store.touch();
    });
    rot.addEventListener('change', function () { applyGeometry('rotation', parseFloat(this.value) || 0); });
  }
  /** 面板显示用的数据源：单选取图形本身，未选中取默认样式 */
  function currentSource() {
    var sel = Store.selectedShapes();
    return sel.length ? sel[0] : Store.state.style;
  }

  /** 字号 / 字体变化后文本包围盒要重新量一次 */
  function remeasureTexts() {
    var sel = Store.selectedShapes();
    var changed = false;
    for (var i = 0; i < sel.length; i++) {
      if (sel[i].type !== 'text') continue;
      var m = View.measureText(sel[i]);
      sel[i].w = m.w;
      sel[i].h = m.h;
      changed = true;
    }
    if (changed) Store.commit();
  }

  function initToolbar() {
    $('toolbar').addEventListener('click', function (ev) {
      var btn = ev.target.closest('.tool');
      if (!btn) return;
      if (btn.dataset.tool === 'image') { pickImage(); return; }
      Store.setTool(btn.dataset.tool);
    });
  }

  function initCanvasControls() {
    function pushSize() {
      Store.patchScene({
        width: Math.round(M.clamp(parseFloat($('canvas-w').value) || 1280, 1, M.LIMITS.maxWidth)),
        height: Math.round(M.clamp(parseFloat($('canvas-h').value) || 800, 1, M.LIMITS.maxHeight))
      });
    }
    $('canvas-w').addEventListener('change', pushSize);
    $('canvas-h').addEventListener('change', pushSize);
    $('canvas-bg').addEventListener('input', function () {
      Store.state.scene.background = this.value;
      Store.touch();
    });
    $('canvas-bg').addEventListener('change', function () { Store.patchScene({ background: this.value }); });
    $('preset-size').addEventListener('change', function () {
      if (!this.value) return;
      var parts = this.value.split('x');
      Store.patchScene({ width: parseInt(parts[0], 10), height: parseInt(parts[1], 10) });
      this.value = '';
      View.fit();
    });
    $('toggle-grid').addEventListener('change', function () {
      Store.state.grid.show = this.checked;
      Store.touch();
    });
    $('toggle-snap').addEventListener('change', function () {
      Store.state.grid.snap = this.checked;
      Store.touch();
    });
  }
  function initActions() {
    $('undo').addEventListener('click', function () { Store.undo(); });
    $('redo').addEventListener('click', function () { Store.redo(); });
    $('zoom-in').addEventListener('click', function () { View.setZoom(Store.state.viewport.scale * 1.2); });
    $('zoom-out').addEventListener('click', function () { View.setZoom(Store.state.viewport.scale / 1.2); });
    $('zoom-level').addEventListener('click', function () { View.setZoom(1); });
    $('zoom-fit').addEventListener('click', function () { View.fit(); });

    $('btn-duplicate').addEventListener('click', function () { Store.duplicateSelected(); });
    $('btn-delete').addEventListener('click', function () { Store.deleteSelected(); });
    doc.querySelectorAll('[data-order]').forEach(function (btn) {
      btn.addEventListener('click', function () { Store.reorder(btn.dataset.order); });
    });

    $('btn-clear').addEventListener('click', function () {
      if (!Store.state.scene.shapes.length) return;
      if (global.confirm('清空画布上的所有图形？（可以用 ⌘Z 撤销）')) {
        Store.clearScene();
        status('画布已清空', 'ok');
      }
    });

    $('btn-export').addEventListener('click', doExport);
    $('export-format').addEventListener('change', syncExportControls);
    $('btn-save-json').addEventListener('click', saveJSON);
    $('btn-import-json').addEventListener('click', function () { $('file-json').click(); });
    $('file-json').addEventListener('change', function () { loadJSONFile(this.files[0]); this.value = ''; });
    $('file-image').addEventListener('change', function () { insertImageFile(this.files[0]); this.value = ''; });

    // 拖文件到画布也能插入图片
    var stage = $('stage');
    stage.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    stage.addEventListener('drop', function (ev) {
      ev.preventDefault();
      var file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (!file) return;
      if (file.type === 'application/json' || /\.json$/i.test(file.name)) loadJSONFile(file);
      else if (/^image\//.test(file.type)) insertImageFile(file, View.eventToWorld(ev));
    });
  }

  function syncExportControls() {
    var isPng = $('export-format').value === 'png';
    $('transparent-wrap').style.opacity = isPng ? '1' : '0.45';
    $('export-transparent').disabled = !isPng;
  }
  /* ---------------- 导出 / 存档 ---------------- */

  function download(blob, filename) {
    var url = global.URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 1000);
  }

  function timestamp() {
    var d = new Date();
    function p(n) { return ('0' + n).slice(-2); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /** 把场景交给服务端渲染，拿回图片再触发下载 */
  async function doExport() {
    var btn = $('btn-export');
    var format = $('export-format').value;
    var scale = parseFloat($('export-scale').value) || 1;
    var body = {
      scene: Store.state.scene,
      format: format,
      scale: scale,
      quality: 0.92,
      transparent: format === 'png' && $('export-transparent').checked,
      filename: 'aipaint-drawing-' + timestamp()
    };
    btn.disabled = true;
    status('服务端渲染中…');
    var started = Date.now();
    try {
      var res = await global.fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        var info = await res.json().catch(function () { return { error: res.statusText }; });
        status('导出失败：' + (info.error || res.status), 'err');
        return;
      }
      var blob = await res.blob();
      download(blob, body.filename + (format === 'jpeg' ? '.jpg' : '.png'));
      var warns = [];
      try { warns = JSON.parse(decodeURIComponent(res.headers.get('X-Warnings') || '%5B%5D')); } catch (e) { warns = []; }
      status('已导出 ' + (res.headers.get('X-Output-Size') || '') +
        ' · ' + (blob.size / 1024).toFixed(1) + 'KB' +
        ' · 服务端 ' + (res.headers.get('X-Render-Ms') || '?') + 'ms' +
        ' · 往返 ' + (Date.now() - started) + 'ms' +
        (warns.length ? ' · ' + warns.length + ' 条提示：' + warns[0] : ''), 'ok');
    } catch (err) {
      status('导出请求失败：' + err.message + '（服务是否还在运行？）', 'err');
    } finally {
      btn.disabled = false;
    }
  }
  function saveJSON() {
    var text = JSON.stringify(Store.state.scene, null, 2);
    download(new global.Blob([text], { type: 'application/json' }), 'aipaint-scene-' + timestamp() + '.json');
    status('场景已存为 JSON', 'ok');
  }

  function loadJSONFile(file) {
    if (!file) return;
    var reader = new global.FileReader();
    reader.onload = function () {
      try {
        var warnings = Store.loadScene(JSON.parse(reader.result));
        // 存档里的文本可能没带 w/h（早期版本、或手写的 JSON），不补的话居中/右对齐
        // 和旋转中心都按零宽算 —— 和 init() 里补的是同一件事
        remeasureMissingTexts();
        Store.commit();
        View.fit();
        status('已导入场景' + (warnings.length ? '（' + warnings.length + ' 条提示：' + warnings[0] + '）' : ''), 'ok');
      } catch (err) {
        status('JSON 解析失败：' + err.message, 'err');
      }
    };
    reader.readAsText(file);
  }

  function pickImage() { $('file-image').click(); }

  /** 图片以 data URL 内联进场景，这样导出时服务端不需要访问外部地址 */
  function insertImageFile(file, atWorldPoint) {
    if (!file) return;
    var reader = new global.FileReader();
    reader.onload = function () {
      var src = String(reader.result);
      if (src.length > M.LIMITS.maxImageChars) {
        status('图片太大（' + (src.length / 1048576).toFixed(1) + 'MB），请先压缩', 'err');
        return;
      }
      var img = new global.Image();
      img.onload = function () {
        var scene = Store.state.scene;
        var maxW = scene.width * 0.6, maxH = scene.height * 0.6;
        var k = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
        var w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
        var center = atWorldPoint || View.screenToWorld({ x: View.size().w / 2, y: View.size().h / 2 });
        Store.addShape(M.createShape('image', {
          src: src,
          x: Math.round(center.x - w / 2),
          y: Math.round(center.y - h / 2),
          w: w, h: h,
          stroke: 'transparent',
          fill: 'transparent'
        }));
        Store.setTool('select');
        status('已插入图片 ' + img.naturalWidth + '×' + img.naturalHeight, 'ok');
      };
      img.onerror = function () { status('图片读取失败', 'err'); };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }
  /* ---------------- 状态 → 界面 ---------------- */

  function setValue(el, value) {
    if (!focused(el) && el.value !== String(value)) el.value = value;
  }

  function syncProps(source, type, selCount) {
    var isText = type === 'text';
    var fillNone = !M.isVisible(source.fill);
    var strokeNone = !M.isVisible(source.stroke);
    if (!fillNone) lastFill = toHex(source.fill, lastFill);
    if (!strokeNone) lastStroke = toHex(source.stroke, lastStroke);

    setValue($('p-fill'), toHex(source.fill, lastFill));
    setValue($('p-stroke'), toHex(source.stroke, lastStroke));
    $('p-fill-none').checked = fillNone;
    $('p-stroke-none').checked = strokeNone;

    setValue($('p-strokeWidth'), M.num(source.strokeWidth, 2));
    $('p-strokeWidth-out').textContent = M.num(source.strokeWidth, 2);
    setValue($('p-opacity'), M.num(source.opacity, 1));
    $('p-opacity-out').textContent = Math.round(M.num(source.opacity, 1) * 100) + '%';
    setValue($('p-radius'), M.num(source.radius, 0));
    $('p-radius-out').textContent = M.num(source.radius, 0);
    setValue($('p-dash'), source.dash || 'solid');

    // 圆角只对矩形有意义；没选中时作为新矩形的默认值一直显示
    doc.querySelectorAll('[data-only="rect"]').forEach(function (row) {
      row.hidden = !!type && type !== 'rect';
    });
    doc.querySelectorAll('[data-only="text"]').forEach(function (row) {
      row.hidden = !!type && !isText;
    });

    setValue($('p-fontSize'), M.num(source.fontSize, 24));
    setValue($('p-fontFamily'), source.fontFamily || 'sans');
    $('p-textAlign').querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.val === (source.textAlign || 'left'));
    });
    $('p-bold').classList.toggle('on', !!source.bold);
    $('p-italic').classList.toggle('on', !!source.italic);

    var geo = $('panel-geometry');
    geo.hidden = selCount === 0;
    $('panel-empty').hidden = selCount > 0;
    if (selCount > 0) {
      var box = M.unionBBox(Store.selectedShapes());
      setValue($('p-x'), Math.round(box.x));
      setValue($('p-y'), Math.round(box.y));
      setValue($('p-w'), Math.round(box.w));
      setValue($('p-h'), Math.round(box.h));
      var deg = Math.round(M.num(source.rotation, 0) * 180 / Math.PI);
      setValue($('p-rotation'), deg);
      $('p-rotation-out').textContent = deg + '°';
    }
  }
  var TYPE_LABELS = {
    rect: '矩形', ellipse: '椭圆', diamond: '菱形', line: '直线',
    arrow: '箭头', path: '手绘线', text: '文本', image: '图片'
  };

  function sync() {
    var st = Store.state;
    var sel = Store.selectedShapes();

    doc.querySelectorAll('.tool').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.tool === st.tool);
    });

    setValue($('canvas-w'), st.scene.width);
    setValue($('canvas-h'), st.scene.height);
    setValue($('canvas-bg'), toHex(st.scene.background, '#ffffff'));
    $('toggle-grid').checked = st.grid.show;
    $('toggle-snap').checked = st.grid.snap;

    $('undo').disabled = !Store.canUndo();
    $('redo').disabled = !Store.canRedo();
    $('zoom-level').textContent = Math.round(st.viewport.scale * 100) + '%';
    $('btn-delete').disabled = sel.length === 0;
    $('btn-duplicate').disabled = sel.length === 0;
    doc.querySelectorAll('[data-order]').forEach(function (b) { b.disabled = sel.length === 0; });

    syncProps(sel.length ? sel[0] : st.style, sel.length ? sel[0].type : null, sel.length);

    $('status-left').textContent = st.scene.shapes.length + ' 个图形 · ' +
      st.scene.width + '×' + st.scene.height;
    if (sel.length === 1) {
      var b = M.shapeBBox(sel[0]);
      $('status-right').textContent = '已选：' + (TYPE_LABELS[sel[0].type] || sel[0].type) +
        ' ' + Math.round(b.w) + '×' + Math.round(b.h);
    } else if (sel.length > 1) {
      $('status-right').textContent = '已选 ' + sel.length + ' 个对象';
    } else {
      $('status-right').textContent = '工具：' + (st.tool === 'select' ? '选择' : (TYPE_LABELS[st.tool] || st.tool));
    }
  }
  /* ---------------- 启动 ---------------- */

  var SEED_KEY = 'aipaint:seeded:v1';

  function demoScene() {
    return {
      width: 1280, height: 800, background: '#ffffff',
      shapes: [
        { type: 'rect', x: 80, y: 70, w: 1120, h: 160, radius: 18, fill: '#eef4ff', stroke: '#4c8dff', strokeWidth: 2 },
        { type: 'text', x: 120, y: 105, text: '欢迎使用 AIPaint', fontSize: 46, fill: '#1d3f7a', fontFamily: 'sans', bold: true },
        { type: 'text', x: 122, y: 168, text: '浏览器里编辑，服务端 node-canvas 导出图片', fontSize: 20, fill: '#5b6b86' },
        { type: 'rect', x: 130, y: 330, w: 240, h: 150, radius: 12, fill: '#dbeafe', stroke: '#2563eb', strokeWidth: 3 },
        { type: 'text', x: 186, y: 392, text: '拖拽绘制', fontSize: 26, fill: '#1e40af' },
        { type: 'arrow', x1: 400, y1: 405, x2: 560, y2: 405, stroke: '#dc2626', strokeWidth: 4 },
        { type: 'ellipse', x: 590, y: 320, w: 240, h: 170, fill: '#fef3c7', stroke: '#d97706', strokeWidth: 3, dash: 'dashed' },
        { type: 'text', x: 646, y: 390, text: '调整样式', fontSize: 26, fill: '#92400e' },
        { type: 'arrow', x1: 860, y1: 405, x2: 1010, y2: 405, stroke: '#dc2626', strokeWidth: 4 },
        { type: 'diamond', x: 1030, y: 320, w: 170, h: 170, fill: '#d1fae5', stroke: '#059669', strokeWidth: 3 },
        { type: 'text', x: 1068, y: 392, text: '导出', fontSize: 26, fill: '#065f46' },
        { type: 'path', stroke: '#7c3aed', strokeWidth: 6, fill: 'transparent',
          points: [[150, 620], [200, 680], [250, 600], [300, 690], [350, 610], [400, 670], [450, 620]] },
        { type: 'text', x: 480, y: 630, text: '画笔 · 文本 · 图片 · 旋转 · 图层', fontSize: 22, fill: '#6b7280' }
      ]
    };
  }

  /** 文本尺寸依赖字体度量，导入时缺尺寸就现场量一遍 */
  function remeasureMissingTexts() {
    var shapes = Store.state.scene.shapes;
    for (var i = 0; i < shapes.length; i++) {
      if (shapes[i].type !== 'text' || shapes[i].w > 1) continue;
      var m = View.measureText(shapes[i]);
      shapes[i].w = m.w;
      shapes[i].h = m.h;
    }
  }

  async function checkHealth() {
    try {
      var res = await global.fetch('/api/health');
      var info = await res.json();
      var missing = !info.fontFiles || !info.fontFiles.cjk;
      status('服务端就绪 · node-canvas ' + info.canvas +
        (missing ? ' · 未找到中日韩字体，导出中文可能变成方块' : ''), missing ? 'err' : 'ok');
    } catch (err) {
      status('无法连接导出服务，请确认 npm start 已运行', 'err');
    }
  }
  function init() {
    Store.restore();
    View.init($('board'));
    global.Input.init($('board'), $('text-editor'));
    initToolbar();
    initCanvasControls();
    initProps();
    initActions();
    syncExportControls();

    Store.on(function () {
      View.scheduleRender();
      sync();
    });

    var seeded = false;
    try { seeded = !!global.localStorage.getItem(SEED_KEY); } catch (err) { seeded = true; }
    if (!Store.state.scene.shapes.length && !seeded) {
      Store.loadScene(demoScene());
      try { global.localStorage.setItem(SEED_KEY, '1'); } catch (err) { /* 忽略 */ }
    }
    remeasureMissingTexts();

    View.fit();
    sync();
    View.render();
    checkHealth();
  }

  global.UI = {
    init: init,
    sync: sync,
    status: status,
    pickImage: pickImage,
    // agent.js 应用完场景后要补量文字尺寸：只补缺的，绝不全量重测 ——
    // 服务端烘焙过的尺寸才是导出用的那一份，用浏览器度量覆盖它就把导出弄错了
    remeasureMissingTexts: remeasureMissingTexts,
    doExport: doExport
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
