/**
 * 导出服务：静态托管编辑器 + 用 node-canvas 在服务端把场景渲染成图片。
 * 默认只监听 127.0.0.1，是一个本地开发工具，没有鉴权。
 */
'use strict';

// .env 默认就读，启动脚本里不用再挂 --env-file。
// shell 里已经有的变量优先级更高（process.loadEnvFile 的语义就是这样），
// 所以临时 `DEEPSEEK_API_KEY=... npm run dev` 依然能盖掉文件里的值。
try {
  process.loadEnvFile();
} catch (err) {
  if (err && err.code !== 'ENOENT') console.warn('[env] .env 读取失败：' + err.message);
}

const fs = require('fs');
const path = require('path');
const express = require('express');
const { createCanvas, loadImage, registerFont } = require('canvas');

const SceneModel = require('./src/shared/scene.js');
const Renderer = require('./src/shared/renderer.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const LIMITS = SceneModel.LIMITS;

/**
 * node-canvas 走 fontconfig 找字体，不同机器结果不稳定。
 * 这里显式注册系统字体到固定族名，让服务端导出和浏览器预览尽量一致。
 * "Arial Unicode" 覆盖中日韩字形，作为 CJK 兜底。
 */
const FONT_CANDIDATES = {
  sans: [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    'C:/Windows/Fonts/arial.ttf'
  ],
  serif: [
    '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
    '/System/Library/Fonts/Supplemental/Georgia.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    'C:/Windows/Fonts/times.ttf'
  ],
  mono: [
    '/System/Library/Fonts/Menlo.ttc',
    '/System/Library/Fonts/Supplemental/Courier New.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
    'C:/Windows/Fonts/consola.ttf'
  ],
  cjk: [
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    'C:/Windows/Fonts/msyh.ttc'
  ]
};
const FAMILY_NAMES = { sans: 'AIPaintSans', serif: 'AIPaintSerif', mono: 'AIPaintMono', cjk: 'AIPaintCJK' };
const GENERIC = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' };

function registerFonts() {
  const registered = {};
  for (const key of Object.keys(FONT_CANDIDATES)) {
    for (const file of FONT_CANDIDATES[key]) {
      try {
        if (!fs.existsSync(file)) continue;
        registerFont(file, { family: FAMILY_NAMES[key] });
        registered[key] = file;
        break;
      } catch (err) {
        // 字体格式不被 FreeType 接受（常见于 .ttc），跳过换下一个候选
      }
    }
  }
  // Pango 支持逗号分隔的字体族回退链：先本族，再 CJK 兜底，最后交给系统
  const fonts = {};
  for (const key of ['sans', 'serif', 'mono']) {
    const chain = [];
    if (registered[key]) chain.push('"' + FAMILY_NAMES[key] + '"');
    if (registered.cjk) chain.push('"' + FAMILY_NAMES.cjk + '"');
    chain.push(GENERIC[key]);
    fonts[key] = chain.join(', ');
  }
  return { fonts, registered };
}

const FONT_SETUP = registerFonts();

/** 只允许内联 data URL，scene.js 已经校验过格式，这里负责解码 */
async function preloadImages(scene) {
  const images = {};
  const srcList = [];
  for (const s of scene.shapes) {
    if (s.type === 'image' && s.src && srcList.indexOf(s.src) < 0) srcList.push(s.src);
  }
  await Promise.all(srcList.map(async (src) => {
    try {
      images[src] = await loadImage(src);
    } catch (err) {
      console.warn('[export] 图片解码失败:', err.message);
    }
  }));
  return images;
}
/** 核心：把场景渲染成图片 buffer */
async function renderToBuffer(rawScene, options) {
  const { scene, warnings } = SceneModel.validateScene(rawScene);
  const format = options.format === 'jpeg' ? 'jpeg' : 'png';
  const scale = SceneModel.clamp(SceneModel.num(options.scale, 1), 0.25, LIMITS.maxScale);
  const quality = SceneModel.clamp(SceneModel.num(options.quality, 0.92), 0.3, 1);
  const transparent = format === 'png' && !!options.transparent;

  const outW = Math.max(1, Math.round(scene.width * scale));
  const outH = Math.max(1, Math.round(scene.height * scale));
  if (outW * outH > LIMITS.maxOutputPixels) {
    const err = new Error(`输出尺寸过大：${outW}×${outH}，超过 ${LIMITS.maxOutputPixels / 1e6}MP 上限`);
    err.status = 413;
    throw err;
  }

  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  if (format === 'jpeg') {
    // JPEG 不支持透明，先铺一层白底，避免透明区域变成黑块
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, scene.width, scene.height);
    ctx.restore();
  }
  ctx.quality = 'best';
  ctx.patternQuality = 'best';
  ctx.textDrawingMode = 'path';

  const images = await preloadImages(scene);
  const renderWarnings = [];
  Renderer.renderScene(ctx, scene, {
    transparent,
    images,
    fonts: FONT_SETUP.fonts,
    onError: (err, shape) => renderWarnings.push(`图形 ${shape && shape.id} 渲染失败: ${err.message}`)
  });

  const buffer = format === 'jpeg'
    ? canvas.toBuffer('image/jpeg', { quality, progressive: true })
    : canvas.toBuffer('image/png', { compressionLevel: 6 });

  return { buffer, format, width: outW, height: outH, warnings: warnings.concat(renderWarnings) };
}
const app = express();

// 场景里可能内联 base64 图片，agent 请求还会再叠上附件，所以 body 上限放宽，但仍然有界
app.use(express.json({ limit: '32mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// 前端与服务端共用同一份模型和渲染器
app.use('/shared', express.static(path.join(__dirname, 'src', 'shared')));
// agent 端点。注入 FONT_SETUP.fonts：文字断行必须用和导出完全相同的度量
app.use(require('./src/agent/routes.js').create({ fonts: FONT_SETUP.fonts }));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    canvas: require('canvas/package.json').version,
    node: process.version,
    fonts: FONT_SETUP.fonts,
    fontFiles: FONT_SETUP.registered,
    limits: LIMITS
  });
});

app.post('/api/export', async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const out = await renderToBuffer(body.scene, {
      format: body.format,
      scale: body.scale,
      quality: body.quality,
      transparent: body.transparent
    });
    const ms = Date.now() - started;
    const name = (typeof body.filename === 'string' ? body.filename : 'drawing')
      .replace(/[^\w一-龥.-]+/g, '_').slice(0, 60) || 'drawing';

    res.set({
      'Content-Type': out.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      'Content-Length': String(out.buffer.length),
      'Content-Disposition': `attachment; filename="${name}.${out.format === 'jpeg' ? 'jpg' : 'png'}"`,
      'Cache-Control': 'no-store',
      'X-Render-Ms': String(ms),
      'X-Output-Size': `${out.width}x${out.height}`,
      'X-Warnings': encodeURIComponent(JSON.stringify(out.warnings || []))
    });
    res.send(out.buffer);
    console.log(`[export] ${out.format} ${out.width}x${out.height} ${(out.buffer.length / 1024).toFixed(1)}KB ${ms}ms`);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[export] 失败:', err);
    res.status(status).json({ error: err.message || '导出失败' });
  }
});
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`AIPaint 已启动: http://${HOST}:${PORT}`);
    const missing = ['sans', 'serif', 'mono', 'cjk'].filter((k) => !FONT_SETUP.registered[k]);
    if (missing.length) {
      console.log(`提示: 未找到这些字体，将回落到系统默认: ${missing.join(', ')}`);
    }
  });
}

module.exports = { app, renderToBuffer, FONT_SETUP };
