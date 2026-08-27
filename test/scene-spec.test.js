'use strict';
/**
 * scene-spec 的核心断言是那条往返不变式：
 * 严格层接受的任何场景，再过一次 SceneModel.validateScene 必须字节一致、warnings 为空。
 * 它不成立就意味着严格层有洞（宽容层会偷偷改字段），这种 bug 只会在成品图上显形。
 */
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/shared/scene.js');
const S = require('../src/shared/scene-spec.js');

// 确定性度量器：不依赖 node-canvas，CJK 算一个整宽，其余半宽
function measure(text, shape) {
  const size = shape.fontSize || 24;
  let w = 0;
  for (const ch of String(text)) w += ch.charCodeAt(0) > 0x2e7f ? size : size * 0.5;
  return w;
}

const OPTS = { measure, assertInvariant: true, srcRefs: {} };

function scene(shapes, extra) {
  return Object.assign({ width: 800, height: 600, background: '#ffffff', shapes }, extra || {});
}

function accept(raw, opts) {
  const res = S.normalizeAgentScene(raw, Object.assign({}, OPTS, opts || {}));
  assert.ok(res.ok, '本该接受，却报了: ' + JSON.stringify(res.problems));
  return res.scene;
}

function reject(raw, code, opts) {
  const res = S.normalizeAgentScene(raw, Object.assign({}, OPTS, opts || {}));
  assert.equal(res.ok, false, '本该拒绝: ' + JSON.stringify(raw));
  const codes = res.problems.map((p) => p.code);
  assert.ok(codes.includes(code), '期望 code ' + code + '，实际 ' + JSON.stringify(res.problems));
  return res;
}

const ALL_TYPES = [
  { type: 'rect', x: 10, y: 10, w: 100, h: 50, fill: '#ff0000', radius: 8 },
  { type: 'ellipse', x: 20, y: 20, w: 60, h: 60, stroke: '#000000', strokeWidth: 3 },
  { type: 'diamond', x: 30, y: 30, w: 40, h: 40, fill: '#00ff00', dash: 'dashed' },
  { type: 'line', x1: 0, y1: 0, x2: 100, y2: 100, stroke: '#123456' },
  { type: 'arrow', x1: 5, y1: 5, x2: 90, y2: 10, stroke: '#abc', arrowSize: 12 },
  { type: 'path', points: [[0, 0], [50, 0], [25, 40]], closed: true, smooth: false, fill: '#eeeeee' },
  { type: 'text', x: 100, y: 200, text: '标题 Title', fontSize: 32, bold: true },
  { type: 'text', x: 100, y: 300, text: '正文很长很长很长很长很长很长', maxWidth: 120, textAlign: 'center' },
  { type: 'rect', x: 0, y: 0, w: 10, h: 10, rotationDeg: 45, opacity: 0.5, fill: '#00000080' }
];

test('往返不变式：每种图形都过 validateScene 字节一致', () => {
  const out = accept(scene(ALL_TYPES));
  assert.equal(out.shapes.length, ALL_TYPES.length);
  const again = M.validateScene(out);
  assert.deepEqual(again.warnings, []);
  assert.equal(JSON.stringify(again.scene), JSON.stringify(out));
});

test('rotationDeg 转成弧度，rotation 字段被拒', () => {
  const out = accept(scene([{ type: 'rect', x: 0, y: 0, w: 10, h: 10, rotationDeg: 90 }]));
  assert.ok(Math.abs(out.shapes[0].rotation - Math.PI / 2) < 1e-12);
  const res = reject(scene([{ type: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 1.57 }]), 'unknown_field');
  assert.match(res.problems[0].hint, /rotationDeg/);
});

test('颜色只收 hex 和 transparent，颜色名被拒', () => {
  reject(scene([{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: 'skyblue' }]), 'bad_color');
  reject(scene([{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: 'rgb(1,2,3)' }]), 'bad_color');
  accept(scene([{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: 'transparent' }]));
});

test('每类错误各一例', () => {
  reject(scene([{ type: 'rect', x: 0, y: 0, w: 10 }]), 'missing');
  reject(scene([{ type: 'rect', x: '0', y: 0, w: 10, h: 10 }]), 'wrong_type');
  reject(scene([{ type: 'rect', x: 0, y: 0, w: 10, h: 10, rotationDeg: 720 }]), 'out_of_range');
  reject(scene([{ type: 'blob', x: 0, y: 0, w: 10, h: 10 }]), 'bad_enum');
  reject(scene([{ type: 'rect', x: 0, y: 0, w: 10, h: 10, dash: 'wavy' }]), 'bad_enum');
  reject(scene([{ type: 'text', x: 0, y: 0, text: '' }]), 'empty');
  reject(scene([{ type: 'path', points: [[0, 0]] }]), 'out_of_range');
  reject(scene([{ type: 'path', points: [[0, 0], [1, 'x']] }]), 'wrong_type');
  reject(scene([{ type: 'image', x: 0, y: 0, w: 10, h: 10, srcRef: 'nope' }]), 'unknown_ref');
  reject(scene([
    { id: 'dup', type: 'rect', x: 0, y: 0, w: 10, h: 10 },
    { id: 'dup', type: 'rect', x: 0, y: 0, w: 10, h: 10 }
  ]), 'duplicate_id');
  reject(scene([], { extra: 1 }), 'unknown_field');
  reject({ width: 800.5, height: 600, background: '#fff', shapes: [] }, 'wrong_type');
  reject({ width: 0, height: 600, background: '#fff', shapes: [] }, 'out_of_range');
});

test('文字烘焙：按 maxWidth 断行并写成字面 \\n，w/h 由度量决定', () => {
  const out = accept(scene([
    { type: 'text', x: 0, y: 0, text: 'aaaa bbbb cccc', maxWidth: 60, fontSize: 20 }
  ]));
  const s = out.shapes[0];
  assert.ok(s.text.includes('\n'), '应该断行了: ' + JSON.stringify(s.text));
  s.text.split('\n').forEach((line) => assert.ok(measure(line, s) <= 60, '行超宽: ' + line));
  assert.equal(s.maxWidth, 60);
  assert.ok(s.h >= s.fontSize * s.lineHeight * s.text.split('\n').length - 1);
});

test('CJK 没有空格也能逐字断行', () => {
  const out = accept(scene([
    { type: 'text', x: 0, y: 0, text: '这是一段没有空格的中文', maxWidth: 60, fontSize: 20 }
  ]));
  const lines = out.shapes[0].text.split('\n');
  assert.ok(lines.length >= 4, '中文该断成多行: ' + JSON.stringify(lines));
  lines.forEach((line) => assert.ok(measure(line, out.shapes[0]) <= 60));
});

test('居中/右对齐限宽时 w 用框宽，否则对齐等于没生效', () => {
  const c = accept(scene([{ type: 'text', x: 0, y: 0, text: 'ab', maxWidth: 200, textAlign: 'center' }]));
  assert.equal(c.shapes[0].w, 200);
  const l = accept(scene([{ type: 'text', x: 0, y: 0, text: 'ab', maxWidth: 200, textAlign: 'left' }]));
  assert.ok(l.shapes[0].w < 200);
});

test('单个换行也保留：文字里的 \\n 是硬换行', () => {
  const out = accept(scene([{ type: 'text', x: 0, y: 0, text: '第一行\n第二行' }]));
  assert.equal(out.shapes[0].text, '第一行\n第二行');
  assert.equal(out.shapes[0].maxWidth, 0);
});

function base() {
  return accept(scene([
    { id: 'a', type: 'rect', x: 0, y: 0, w: 100, h: 100, fill: '#111111' },
    { id: 'b', type: 'text', x: 10, y: 10, text: 'hi', fontSize: 20 },
    { id: 'c', type: 'ellipse', x: 200, y: 200, w: 50, h: 50, stroke: '#222222' }
  ]));
}

function ops(list, sc, opts) {
  return S.applyOps(sc || base(), list, Object.assign({}, OPTS, opts || {}));
}

test('applyOps: update 只改 patch 里的字段', () => {
  const res = ops([{ op: 'update', id: 'a', patch: { fill: '#e53e3e' } }]);
  assert.ok(res.ok, JSON.stringify(res.problems));
  assert.equal(res.scene.shapes[0].fill, '#e53e3e');
  assert.equal(res.scene.shapes[0].w, 100);
  assert.deepEqual(res.touchedIds, ['a']);
});

test('applyOps 原子性：坏 op 让整批不生效，输入场景一个字节都不动', () => {
  const sc = base();
  const before = JSON.stringify(sc);
  const res = ops([
    { op: 'update', id: 'a', patch: { fill: '#00ff00' } },
    { op: 'update', id: 'nope', patch: { fill: '#00ff00' } }
  ], sc);
  assert.equal(res.ok, false);
  assert.equal(res.problems[0].code, 'unknown_ref');
  assert.equal(JSON.stringify(sc), before);
});

test('applyOps: add / delete / move / order / canvas', () => {
  let res = ops([{ op: 'add', shape: { type: 'rect', x: 5, y: 5, w: 20, h: 20, fill: '#333333' } }]);
  assert.ok(res.ok, JSON.stringify(res.problems));
  assert.equal(res.scene.shapes.length, 4);
  assert.equal(res.touchedIds.length, 1);

  res = ops([{ op: 'delete', id: 'b' }]);
  assert.ok(res.ok);
  assert.equal(res.scene.shapes.length, 2);

  res = ops([{ op: 'move', id: 'a', dx: 10, dy: -5 }]);
  assert.ok(res.ok, JSON.stringify(res.problems));
  assert.equal(res.scene.shapes[0].x, 10);
  assert.equal(res.scene.shapes[0].y, -5);

  res = ops([{ op: 'order', id: 'a', to: 'front' }]);
  assert.ok(res.ok);
  assert.equal(res.scene.shapes[2].id, 'a');

  res = ops([{ op: 'canvas', width: 1000, background: '#000000' }]);
  assert.ok(res.ok, JSON.stringify(res.problems));
  assert.equal(res.scene.width, 1000);
  assert.equal(res.scene.background, '#000000');
  assert.equal(res.scene.height, 600);
});

test('applyOps: 拒绝改 type、拒绝跨类型字段、拒绝空 patch', () => {
  assert.equal(ops([{ op: 'update', id: 'a', patch: { type: 'ellipse' } }]).problems[0].code, 'immutable');
  assert.equal(ops([{ op: 'update', id: 'a', patch: { text: 'x' } }]).problems[0].code, 'unknown_field');
  assert.equal(ops([{ op: 'update', id: 'a', patch: {} }]).problems[0].code, 'empty');
  assert.equal(ops([{ op: 'nope', id: 'a' }]).problems[0].code, 'bad_enum');
  assert.equal(ops([{ op: 'update', id: 'a', patch: { fill: '#fff' }, fill: '#fff' }]).problems[0].code, 'unknown_field');
  assert.equal(ops([]).problems[0].code, 'empty');
});

test('applyOps 之后依然满足往返不变式', () => {
  const res = ops([
    { op: 'update', id: 'b', patch: { text: 'aaaa bbbb cccc dddd', maxWidth: 80 } },
    { op: 'add', shape: { type: 'path', points: [[0, 0], [10, 10], [20, 0]], smooth: false, stroke: '#000000' } }
  ]);
  assert.ok(res.ok, JSON.stringify(res.problems));
  const again = M.validateScene(res.scene);
  assert.deepEqual(again.warnings, []);
  assert.equal(JSON.stringify(again.scene), JSON.stringify(res.scene));
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

test('图片句柄化：模型只见 srcRef，data URL 不进上下文，还原后一致', () => {
  const sc = M.validateScene({
    width: 400, height: 300, background: '#ffffff',
    shapes: [{ type: 'image', x: 0, y: 0, w: 100, h: 100, src: PNG }]
  }).scene;
  const st = S.stripImageSrc(sc);
  assert.deepEqual(Object.keys(st.srcRefs), ['img1']);
  assert.equal(st.srcUrls.img1, PNG);
  assert.ok(!JSON.stringify(st.scene).includes('iVBOR'), 'data URL 不该留在剥离后的场景里');
  assert.ok(!S.explainScene(st.scene, { srcRefs: st.srcRefs }).includes('iVBOR'));

  // 剥离后的场景仍要能过安全边界，否则 finalize 会把图片整个丢掉
  assert.deepEqual(M.validateScene(st.scene).warnings, []);

  const res = S.applyOps(st.scene, [{ op: 'move', id: st.scene.shapes[0].id, dx: 10, dy: 0 }],
    Object.assign({}, OPTS, { srcRefs: st.srcRefs }));
  assert.ok(res.ok, JSON.stringify(res.problems));
  S.restoreImageSrc(res.scene, st.srcUrls);
  assert.equal(res.scene.shapes[0].src, PNG);
});

test('image 只能引用已有 srcRef', () => {
  accept(scene([{ type: 'image', x: 0, y: 0, w: 10, h: 10, srcRef: 'img1' }]),
    { srcRefs: { img1: 'data:image/png;base64,AIPaintRefimg1' } });
  reject(scene([{ type: 'image', x: 0, y: 0, w: 10, h: 10, src: PNG }]), 'unknown_field');
});

test('auditScene 抓出盲画最常见的四种毛病', () => {
  const sc = accept(scene([
    { type: 'rect', x: 700, y: 500, w: 400, h: 400, fill: '#000000' },
    { type: 'rect', x: 900, y: 700, w: 50, h: 50, fill: '#000000' },
    { type: 'rect', x: 0, y: 0, w: 50, h: 50, fill: '#ffffff' },
    { type: 'rect', x: 0, y: 0, w: 50, h: 50, fill: '#123456', opacity: 0.01 },
    { type: 'text', x: 100, y: 100, text: '压在一起的甲', fontSize: 24 },
    { type: 'text', x: 100, y: 105, text: '压在一起的乙', fontSize: 24 }
  ]));
  const notes = S.auditScene(sc).join('\n');
  assert.match(notes, /超出画布边缘/);
  assert.match(notes, /整个在画布外/);
  assert.match(notes, /和背景同色/);
  assert.match(notes, /几乎全透明/);
  assert.match(notes, /文字重叠/);
  assert.deepEqual(S.auditScene(accept(scene([
    { type: 'rect', x: 10, y: 10, w: 50, h: 50, fill: '#123456' }
  ]))), []);
});

test('explainScene 给出 id/几何/文字摘要，且不含图片数据', () => {
  const out = S.explainScene(base(), { selection: ['a'] });
  assert.match(out, /画布 800×600/);
  assert.match(out, /a rect/);
  assert.match(out, /"hi"/);
  assert.match(out, /用户当前选中：a/);
});

test('工具 schema 从字段表生成，strict 变体剥掉不支持的关键字', () => {
  const list = S.tools(false);
  assert.deepEqual(list.map((t) => t.function.name), ['set_scene', 'edit_scene', 'get_scene']);
  const shapes = list[0].function.parameters.properties.shapes;
  assert.equal(shapes.items.anyOf.length, 8);
  const rect = shapes.items.anyOf.find((s) => s.properties.type.enum[0] === 'rect');
  assert.equal(rect.additionalProperties, false);
  assert.deepEqual(rect.required, ['type', 'x', 'y', 'w', 'h']);
  assert.ok(!rect.properties.rotation, '规范里不该有 rotation');
  assert.equal(rect.properties.rotationDeg.minimum, -360);

  const strict = S.tools(true);
  assert.equal(strict[0].function.strict, true);
  const srect = strict[0].function.parameters.properties.shapes.items.anyOf[0];
  assert.deepEqual(srect.required, Object.keys(srect.properties));
  assert.equal(JSON.stringify(strict).includes('"minimum"'), false);
  assert.equal(JSON.stringify(strict).includes('"pattern"'), false);
  assert.ok(srect.properties.opacity.anyOf, '可选字段要变成 anyOf[T,null]');
});

test('strict schema 里的 null 可选值，运行时当作缺省处理', () => {
  accept(scene([{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: null, radius: null }]));
});
