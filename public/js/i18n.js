(function (global) {
  'use strict';

  var STORAGE_KEY = 'aipaint:locale:v1';
  var SUPPORTED = { 'zh-CN': 1, 'en-US': 1 };
  var resources = {
    'zh-CN': {
      language: '中文',
      toolbar: {
        canvas: '画布', canvasWidth: '画布宽度', canvasHeight: '画布高度',
        commonSizes: '常用尺寸', background: '画布底色', undo: '撤销 (⌘Z)',
        redo: '重做 (⇧⌘Z)', zoomOut: '缩小 (⌘-)', zoomReset: '点击回到 100% (⌘0)',
        zoomIn: '放大 (⌘+)', fit: '适应窗口 (⇧1)', manual: '手动编辑',
        aiMode: 'AI 模式', grid: '网格', snap: '吸附', import: '导入',
        save: '存档', clear: '清空', exportFormat: '导出格式', exportScale: '导出倍率',
        transparent: '透明底', export: '导出图片', exportTitle: '调用服务端渲染并下载',
        modeTitle: '在 AI 模式和手动编辑之间切换'
      },
      tool: {
        select: '选择', rect: '矩形', roundRect: '圆角矩形', ellipse: '椭圆',
        diamond: '菱形', line: '直线', arrow: '箭头', connector: '连接线',
        pen: '画笔', path: '手绘线', text: '文本', image: '图片', note: '便签', group: '分组'
      },
      props: {
        style: '样式', fill: '填充', stroke: '描边', none: '无', strokeWidth: '线宽',
        dash: '线型', solid: '实线', dashed: '虚线', dotted: '点线', opacity: '透明',
        radius: '圆角', text: '文本', fontSize: '字号', fontFamily: '字体',
        sans: '无衬线', serif: '衬线', mono: '等宽', align: '对齐',
        left: '左', center: '中', right: '右', weight: '字重',
        geometry: '位置与尺寸', width: '宽', height: '高', rotation: '旋转',
        layers: '层级与操作', front: '置顶', up: '上移', down: '下移',
        back: '置底', duplicate: '复制', delete: '删除', empty: '没有选中对象',
        emptyHint: '左侧选一个工具在画布上拖拽即可绘制。此处的样式会作为新图形的默认样式。',
        choose: '选择', editText: '编辑文本', pan: '平移画布', zoom: '缩放', keepRatio: '保持等比'
      },
      chat: {
        title: 'AI 绘图', settings: '配置 API Base URL 和 API Key', stop: '停止',
        inputPlaceholder: '说要画什么，例如：做一张 1200×675 的三栏产品对比图',
        addTools: '添加文件和工具', addImage: '添加图片', addFile: '添加文件',
        chooseModel: '选择模型', send: '发送', stopGeneration: '停止生成',
        ready: '说想画什么就行，例如「做一张 1200×675 的三栏产品对比图」。⇧Enter 换行。',
        attach: '附件：', remove: '移除', chars: '字', leadingChars: '前 ',
        tooMany: '附件最多 {count} 个，剩下的没加上。', maxReached: '附件已达上限（{count} 个）',
        emptyAttachment: '说一句要用这些附件做什么，再发送。'
      },
      config: {
        title: '模型配置', cancel: '取消', save: '保存', loading: '正在读取当前配置…',
        loadFailed: '读不到当前配置：{error}', keep: '留空表示不改', keyPlaceholder: 'sk-…',
        shellWarning: '当前 key 来自 shell 环境变量，优先级比 .env 高。要用文件里的值，得先在 shell 里 unset DEEPSEEK_API_KEY 再重启。',
        configured: 'key 已配置，不动它就直接保存。', savedHint: '保存后立即生效，不用重启。文件按 0600 写，只有你自己能读。',
        writing: '正在写入…', saveFailed: '保存失败：{error}', saved: '凭证已写入 {path}，已生效。当前：{base}{key}',
        keyMissing: '未配置模型 API key，点这里配置', noKey: '还没配置模型 API key，AI 绘图暂时用不了。\n填一下就能开始，也可以点顶栏「手动编辑」自己画。'
      },
      status: {
        ready: '就绪', shapeCount: '{count} 个图形 · {width}×{height}', selected: '已选：{type} {width}×{height}',
        selectedMany: '已选 {count} 个对象', tool: '工具：{type}', clearConfirm: '清空画布上的所有图形？（可以用 ⌘Z 撤销）',
        cleared: '画布已清空', rendering: '服务端渲染中…', exportFailed: '导出失败：{error}',
        exported: '已导出 {output} · {size}KB · 服务端 {render}ms · 往返 {round}ms',
        saveJSON: '场景已存为 JSON', imported: '已导入场景', parseFailed: 'JSON 解析失败：{error}',
        imageTooLarge: '图片太大（{size}MB），请先压缩', imageInserted: '已插入图片 {original}{scaled}',
        imageReadFailed: '图片读取失败', health: '服务端就绪 · node-canvas {canvas}',
        healthMissingFont: ' · 未找到中日韩字体，导出中文可能变成方块',
        healthFailed: '无法连接导出服务，请确认 npm start 已运行'
      },
      agent: {
        generating: '生成中…', planning: '正在规划版面…', checking: '正在检查并修正…',
        viewing: '正在看你传的图…', viewed: '已读过你传的 {count} 张图（画图的模型拿到的是文字描述，不是原图）。',
        viewFailed: '看图失败（{error}）：图还能当素材摆进画布，但版式参考没有了。',
        applied: '已应用 {count} 次改动', unchanged: '画布未改动', rounds: '{count} 轮',
        tokens: '输入 {input} · 输出 {output} · 合计 {total} tokens',
        stuck: '模型没能自己改对，已停下。换个说法或说得更具体一点再试。',
        interrupted: '已中断，画布保持在上一次应用的状态', failed: '生成失败',
        requestFailed: '请求失败：HTTP {status}', disconnected: '连接中断：{error}',
        noKey: '还没配置模型 API key，先填一下。', override: '仍然应用',
        sceneChanged: '场景已被手动修改，AI 结果未应用。', overridden: '已用 AI 结果覆盖当前场景',
        validation: '模型自查未通过（{count} 处），正在修正：', correction: '本地校验修正了 {count} 处：',
        updated: '已更新画布。'
      }
    },
    'en-US': {
      language: 'English',
      toolbar: {
        canvas: 'Canvas', canvasWidth: 'Canvas width', canvasHeight: 'Canvas height',
        commonSizes: 'Common sizes', background: 'Canvas background', undo: 'Undo (⌘Z)',
        redo: 'Redo (⇧⌘Z)', zoomOut: 'Zoom out (⌘-)', zoomReset: 'Reset to 100% (⌘0)',
        zoomIn: 'Zoom in (⌘+)', fit: 'Fit window (⇧1)', manual: 'Manual editing',
        aiMode: 'AI mode', grid: 'Grid', snap: 'Snap', import: 'Import',
        save: 'Save', clear: 'Clear', exportFormat: 'Export format', exportScale: 'Export scale',
        transparent: 'Transparent background', export: 'Export image', exportTitle: 'Render with the server and download',
        modeTitle: 'Switch between AI mode and manual editing'
      },
      tool: {
        select: 'Select', rect: 'Rectangle', roundRect: 'Rounded rectangle', ellipse: 'Ellipse',
        diamond: 'Diamond', line: 'Line', arrow: 'Arrow', connector: 'Connector',
        pen: 'Pen', path: 'Freehand line', text: 'Text', image: 'Image', note: 'Note', group: 'Group'
      },
      props: {
        style: 'Style', fill: 'Fill', stroke: 'Stroke', none: 'None', strokeWidth: 'Line width',
        dash: 'Line style', solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted', opacity: 'Opacity',
        radius: 'Corner radius', text: 'Text', fontSize: 'Font size', fontFamily: 'Font',
        sans: 'Sans-serif', serif: 'Serif', mono: 'Monospace', align: 'Align',
        left: 'Left', center: 'Center', right: 'Right', weight: 'Weight',
        geometry: 'Position and size', width: 'Width', height: 'Height', rotation: 'Rotation',
        layers: 'Layer and actions', front: 'Bring to front', up: 'Bring forward', down: 'Send backward',
        back: 'Send to back', duplicate: 'Duplicate', delete: 'Delete', empty: 'No object selected',
        emptyHint: 'Choose a tool on the left and drag on the canvas to draw. These styles become defaults for new shapes.',
        choose: 'Select', editText: 'Edit text', pan: 'Pan canvas', zoom: 'Zoom', keepRatio: 'Keep aspect ratio'
      },
      chat: {
        title: 'AI drawing', settings: 'Configure API Base URL and API Key', stop: 'Stop',
        inputPlaceholder: 'Describe what to draw, for example: Create a three-column product comparison at 1200×675',
        addTools: 'Add files and tools', addImage: 'Add image', addFile: 'Add file',
        chooseModel: 'Choose model', send: 'Send', stopGeneration: 'Stop generation',
        ready: 'Describe what you want to draw, for example “Create a three-column product comparison at 1200×675”. ⇧Enter for a new line.',
        attach: 'Attachments: ', remove: 'Remove', chars: ' chars', leadingChars: 'First ',
        tooMany: 'You can add up to {count} attachments. The rest were skipped.', maxReached: 'Attachment limit reached ({count})',
        emptyAttachment: 'Say what to do with these attachments before sending.'
      },
      config: {
        title: 'Model configuration', cancel: 'Cancel', save: 'Save', loading: 'Loading current configuration…',
        loadFailed: 'Cannot read current configuration: {error}', keep: 'Leave empty to keep unchanged', keyPlaceholder: 'sk-…',
        shellWarning: 'The current key comes from the shell environment and takes precedence over .env. Run unset DEEPSEEK_API_KEY and restart to use the file value.',
        configured: 'A key is configured. Leave it unchanged to keep it.', savedHint: 'Changes take effect immediately. The file is written with mode 0600.',
        writing: 'Saving…', saveFailed: 'Save failed: {error}', saved: 'Credentials saved to {path}. Active base URL: {base}{key}',
        keyMissing: 'No model API key configured. Click here to configure it.', noKey: 'No model API key is configured, so AI drawing is unavailable.\nConfigure one to start, or use “Manual editing”.'
      },
      status: {
        ready: 'Ready', shapeCount: '{count} shapes · {width}×{height}', selected: 'Selected: {type} {width}×{height}',
        selectedMany: '{count} objects selected', tool: 'Tool: {type}', clearConfirm: 'Clear all shapes from the canvas? (You can undo with ⌘Z)',
        cleared: 'Canvas cleared', rendering: 'Rendering on the server…', exportFailed: 'Export failed: {error}',
        exported: 'Exported {output} · {size}KB · server {render}ms · round trip {round}ms',
        saveJSON: 'Scene saved as JSON', imported: 'Scene imported', parseFailed: 'JSON parse failed: {error}',
        imageTooLarge: 'Image is too large ({size}MB). Please compress it first.', imageInserted: 'Inserted image {original}{scaled}',
        imageReadFailed: 'Failed to read image', health: 'Server ready · node-canvas {canvas}',
        healthMissingFont: ' · CJK fonts not found; exported CJK text may render as boxes',
        healthFailed: 'Cannot connect to the export service. Make sure npm start is running.'
      },
      agent: {
        generating: 'Generating…', planning: 'Planning the layout…', checking: 'Checking and correcting…',
        viewing: 'Analyzing the uploaded images…', viewed: 'Read {count} uploaded image(s). The drawing model received a description, not the original images.',
        viewFailed: 'Image analysis failed ({error}). The image can still be used as a canvas asset, but not as layout reference.',
        applied: '{count} change(s) applied', unchanged: 'No canvas changes', rounds: '{count} round(s)',
        tokens: 'Input {input} · Output {output} · Total {total} tokens',
        stuck: 'The model could not correct itself and stopped. Try rephrasing with more specific details.',
        interrupted: 'Interrupted. The canvas remains at its last applied state.', failed: 'Generation failed',
        requestFailed: 'Request failed: HTTP {status}', disconnected: 'Connection interrupted: {error}',
        noKey: 'No model API key is configured. Configure one first.', override: 'Apply anyway',
        sceneChanged: 'The scene was changed manually, so the AI result was not applied.', overridden: 'Applied the AI result over the current scene',
        validation: 'Model self-check failed ({count} issue(s)); correcting:', correction: 'Local validation corrected {count} issue(s):',
        updated: 'Canvas updated.'
      }
    }
  };

  function browserLocale() {
    var list = (global.navigator && global.navigator.languages) || [global.navigator && global.navigator.language];
    for (var i = 0; i < list.length; i++) {
      if (/^zh(?:-|$)/i.test(list[i] || '')) return 'zh-CN';
      if (/^en(?:-|$)/i.test(list[i] || '')) return 'en-US';
    }
    return 'en-US';
  }

  function valid(locale) { return SUPPORTED[locale] ? locale : null; }
  function getLocale() {
    var saved = null;
    try { saved = global.localStorage.getItem(STORAGE_KEY); } catch (err) {}
    return valid(saved) || browserLocale();
  }
  var locale = getLocale();

  function t(key, params) {
    var parts = String(key).split('.');
    var value = resources[locale];
    for (var i = 0; i < parts.length && value; i++) value = value[parts[i]];
    if (typeof value !== 'string') return key;
    return value.replace(/\{(\w+)\}/g, function (_, name) {
      return params && params[name] !== undefined ? String(params[name]) : '{' + name + '}';
    });
  }

  function apply() {
    global.document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en';
    global.document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    global.document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    global.document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    global.document.querySelectorAll('[data-i18n-aria-label]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    });
    var event = global.document.createEvent('Event');
    event.initEvent('aipaint-locale-change', false, false);
    global.document.dispatchEvent(event);
  }

  function setLocale(next) {
    next = valid(next) || 'en-US';
    locale = next;
    try { global.localStorage.setItem(STORAGE_KEY, locale); } catch (err) {}
    apply();
  }

  global.I18n = {
    t: t,
    getLocale: function () { return locale; },
    setLocale: setLocale,
    apply: apply,
    resources: resources
  };
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', apply);
  else apply();
})(window);
