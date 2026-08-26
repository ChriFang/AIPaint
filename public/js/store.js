/**
 * 编辑器状态中心：场景数据、选中、工具、视口、撤销栈。
 * 所有会改变界面的操作都走这里，统一触发一次重绘。
 */
(function (global) {
  'use strict';
  var M = global.SceneModel;
  var LS_KEY = 'aipaint:scene:v1';
  var HISTORY_LIMIT = 120;

  var state = {
    scene: M.defaultScene(),
    selection: [],
    tool: 'select',
    style: JSON.parse(JSON.stringify(M.STYLE_DEFAULTS)),
    viewport: { scale: 1, tx: 0, ty: 0 },
    grid: { show: true, size: 20, snap: false },
    editingTextId: null
  };

  var listeners = [];
  var history = { stack: [], index: -1 };

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function emit() { for (var i = 0; i < listeners.length; i++) listeners[i](state); }
  function on(fn) { listeners.push(fn); }

  function snapshot() {
    return JSON.stringify({ scene: state.scene, selection: state.selection });
  }

  function resetHistory() {
    history.stack = [snapshot()];
    history.index = 0;
  }

  function persist() {
    try {
      global.localStorage.setItem(LS_KEY, JSON.stringify(state.scene));
    } catch (err) {
      /* 隐私模式或超额时忽略 */
    }
  }

  /** 提交一次可撤销的改动 */
  function commit() {
    var snap = snapshot();
    if (history.stack[history.index] === snap) { emit(); return; }
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(snap);
    if (history.stack.length > HISTORY_LIMIT) history.stack.shift();
    history.index = history.stack.length - 1;
    persist();
    emit();
  }
  function applySnapshot(snap) {
    var data = JSON.parse(snap);
    state.scene = data.scene;
    state.selection = data.selection.filter(function (id) { return !!shapeById(id); });
    state.editingTextId = null;
    persist();
    emit();
  }

  function undo() {
    if (history.index <= 0) return false;
    history.index -= 1;
    applySnapshot(history.stack[history.index]);
    return true;
  }

  function redo() {
    if (history.index >= history.stack.length - 1) return false;
    history.index += 1;
    applySnapshot(history.stack[history.index]);
    return true;
  }

  function canUndo() { return history.index > 0; }
  function canRedo() { return history.index < history.stack.length - 1; }

  function shapeById(id) {
    var list = state.scene.shapes;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function selectedShapes() {
    var out = [];
    for (var i = 0; i < state.selection.length; i++) {
      var s = shapeById(state.selection[i]);
      if (s) out.push(s);
    }
    return out;
  }

  function setSelection(ids) {
    state.selection = (ids || []).slice();
    emit();
  }

  function toggleSelection(id) {
    var i = state.selection.indexOf(id);
    if (i >= 0) state.selection.splice(i, 1);
    else state.selection.push(id);
    emit();
  }

  function setTool(tool) {
    state.tool = tool;
    if (tool !== 'select') state.editingTextId = null;
    emit();
  }
  /** 记住最近一次使用的样式，作为新图形的默认值 */
  function setStyle(patch) {
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) state.style[k] = patch[k];
    emit();
  }

  function addShape(shape, opts) {
    state.scene.shapes.push(shape);
    if (!opts || opts.select !== false) state.selection = [shape.id];
    if (!opts || opts.commit !== false) commit();
    else emit();
    return shape;
  }

  /** 把 patch 合并到所有选中图形，同时同步成默认样式 */
  function patchSelected(patch, opts) {
    var sel = selectedShapes();
    for (var i = 0; i < sel.length; i++) {
      for (var k in patch) {
        if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
        // 文本图形不接受圆角，直线不接受填充，避免脏字段
        if (k === 'radius' && sel[i].type !== 'rect') continue;
        sel[i][k] = patch[k];
      }
    }
    if (opts && opts.transient) emit();
    else commit();
  }

  function deleteSelected() {
    if (!state.selection.length) return;
    var kill = {};
    for (var i = 0; i < state.selection.length; i++) kill[state.selection[i]] = true;
    state.scene.shapes = state.scene.shapes.filter(function (s) { return !kill[s.id]; });
    state.selection = [];
    state.editingTextId = null;
    commit();
  }

  function duplicateSelected(offset) {
    var sel = selectedShapes();
    if (!sel.length) return;
    var d = offset == null ? 16 : offset;
    var ids = [];
    for (var i = 0; i < sel.length; i++) {
      var copy = clone(sel[i]);
      copy.id = M.createId();
      M.translateShape(copy, d, d);
      state.scene.shapes.push(copy);
      ids.push(copy.id);
    }
    state.selection = ids;
    commit();
  }
  /** 调整层级：front / back / up / down */
  function reorder(mode) {
    var sel = selectedShapes();
    if (!sel.length) return;
    var shapes = state.scene.shapes;
    var picked = {};
    for (var i = 0; i < sel.length; i++) picked[sel[i].id] = true;

    if (mode === 'front' || mode === 'back') {
      var keep = shapes.filter(function (s) { return !picked[s.id]; });
      var moved = shapes.filter(function (s) { return picked[s.id]; });
      state.scene.shapes = mode === 'front' ? keep.concat(moved) : moved.concat(keep);
    } else {
      var step = mode === 'up' ? 1 : -1;
      // 顺着移动方向遍历，避免同一批图形互相挡住
      var order = step > 0
        ? shapes.map(function (_, i2) { return shapes.length - 1 - i2; })
        : shapes.map(function (_, i2) { return i2; });
      for (var j = 0; j < order.length; j++) {
        var idx = order[j];
        if (!picked[shapes[idx].id]) continue;
        var target = idx + step;
        if (target < 0 || target >= shapes.length || picked[shapes[target].id]) continue;
        var tmp = shapes[target];
        shapes[target] = shapes[idx];
        shapes[idx] = tmp;
      }
    }
    commit();
  }

  function patchScene(patch) {
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) state.scene[k] = patch[k];
    commit();
  }

  function loadScene(raw, opts) {
    var res = M.validateScene(raw);
    state.scene = res.scene;
    state.selection = [];
    state.editingTextId = null;
    if (!opts || opts.resetHistory !== false) resetHistory();
    persist();
    emit();
    return res.warnings;
  }

  function clearScene() {
    state.scene.shapes = [];
    state.selection = [];
    state.editingTextId = null;
    commit();
  }
  function restore() {
    var raw = null;
    try { raw = global.localStorage.getItem(LS_KEY); } catch (err) { raw = null; }
    if (raw) {
      try {
        state.scene = M.validateScene(JSON.parse(raw)).scene;
      } catch (err) {
        state.scene = M.defaultScene();
      }
    }
    resetHistory();
  }

  global.Store = {
    state: state,
    on: on,
    emit: emit,
    touch: emit,
    commit: commit,
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    clone: clone,
    shapeById: shapeById,
    selectedShapes: selectedShapes,
    setSelection: setSelection,
    toggleSelection: toggleSelection,
    setTool: setTool,
    setStyle: setStyle,
    addShape: addShape,
    patchSelected: patchSelected,
    deleteSelected: deleteSelected,
    duplicateSelected: duplicateSelected,
    reorder: reorder,
    patchScene: patchScene,
    loadScene: loadScene,
    clearScene: clearScene,
    restore: restore,
    historyDepth: function () { return { index: history.index, total: history.stack.length }; }
  };
})(window);
