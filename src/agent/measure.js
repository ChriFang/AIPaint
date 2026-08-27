'use strict';
/**
 * node-canvas 文字度量器。
 *
 * 必须和导出路径用**同一个** fonts 映射（server.js 的 FONT_SETUP.fonts）——
 * 断行是在这里算完、烘成字面 \n 存进场景的，度量若和导出不一致，
 * 烘焙就从「保证一致」变成了「制造不一致」。所以 fonts 是注入的，没有默认值。
 */
const { createCanvas } = require('canvas');
const Renderer = require('../shared/renderer.js');

function createMeasure(fonts) {
  const ctx = createCanvas(8, 8).getContext('2d');
  ctx.textDrawingMode = 'path';
  return function measure(text, shape) {
    ctx.font = Renderer.resolveFont(shape, { fonts: fonts });
    return ctx.measureText(String(text == null ? '' : text)).width;
  };
}

module.exports = { createMeasure };
