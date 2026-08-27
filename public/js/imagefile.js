/**
 * 图片文件 → data URL。ui.js 的手动插图和 agent.js 的附件共用这一份。
 *
 * 一律经 canvas 重编码，不走原始字节。三个理由，第一个是硬的：
 *  1. 图片会进场景，而 store.js 每次 commit 把整个场景写进 localStorage，配额（约 5 MB）
 *     一破就静默停止持久化（persist 里 catch 了什么都不做）—— 用户丢工作且看不到提示；
 *  2. 重编码之后 data URL 是我们自己的编码器产出的，任意文件伪装成图片的路径关掉了，
 *     EXIF 也顺带剥掉；
 *  3. PNG 和 JPEG 各编一次取小的那个：截图类 PNG 更小也更清楚，照片类 JPEG 小一个数量级。
 *
 * 代价写在这儿：动图只留第一帧；极小的 PNG 图标可能略微变大（取小规则已经覆盖大部分情况）。
 *
 * 全部走 global.FileReader / global.Image / global.document —— 测试里这三个是注入的。
 */
(function (global) {
  'use strict';

  var MAX_EDGE = 2048;                      // 长边；海报画布通常 ≤1920，再大对导出没有可见收益
  var MAX_SRC_BYTES = 20 * 1024 * 1024;     // 原始文件上限，压缩之前先拦一道

  /**
   * @param {File} file
   * @param {number} [maxEdge]
   * @returns {Promise<{dataUrl:string,w:number,h:number,mime:string,srcW:number,srcH:number}>}
   */
  function downscale(file, maxEdge) {
    var edge = maxEdge || MAX_EDGE;
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('没有文件')); return; }
      if (file.size > MAX_SRC_BYTES) {
        reject(new Error('文件太大（' + (file.size / 1048576).toFixed(1) + 'MB），上限 ' +
          (MAX_SRC_BYTES / 1048576) + 'MB'));
        return;
      }
      var reader = new global.FileReader();
      reader.onerror = function () { reject(new Error('读不出这个文件')); };
      reader.onload = function () {
        var img = new global.Image();
        img.onerror = function () { reject(new Error('不是能解码的图片')); };
        img.onload = function () {
          var sw = img.naturalWidth;
          var sh = img.naturalHeight;
          if (!sw || !sh) { reject(new Error('图片尺寸为 0')); return; }
          var k = Math.min(1, edge / Math.max(sw, sh));
          var w = Math.max(1, Math.round(sw * k));
          var h = Math.max(1, Math.round(sh * k));
          var cv = global.document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          var png = cv.toDataURL('image/png');
          var jpg = cv.toDataURL('image/jpeg', 0.85);
          var useJpg = jpg.length < png.length;
          resolve({
            dataUrl: useJpg ? jpg : png,
            mime: useJpg ? 'image/jpeg' : 'image/png',
            w: w, h: h, srcW: sw, srcH: sh
          });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  global.ImageFile = { downscale: downscale, MAX_EDGE: MAX_EDGE, MAX_SRC_BYTES: MAX_SRC_BYTES };
})(window);
