'use strict';
/**
 * .env 的读改写。只服务一个用途：让用户在界面上填 API key，而不是去命令行 export。
 *
 * 两条不能松的线：
 * 1. 值里出现换行就直接拒绝。.env 是「一行一个变量」的格式，把换行原样写进去
 *    等于让调用方任意注入环境变量 —— NODE_OPTIONS=--require /tmp/x.js 就是下次
 *    启动时的任意代码执行。这不是理论风险，是这个格式的必然后果。
 * 2. 改写时保留文件里其他所有行（含注释和空行），只替换命中的那一行。
 *    用户的 .env 里可能还有别的东西，我们没有资格重写它。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 测试用 AIPAINT_ENV_FILE 指到 tmp，绝不碰仓库里真的 .env */
function envPath() {
  return process.env.AIPAINT_ENV_FILE || path.join(process.cwd(), '.env');
}

/** 只认最简语法：KEY=VALUE，可带 export 前缀、可带引号。够用，且不猜 */
function parse(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    // 双引号里的 \" 和 \\ 是 format() 写出来的转义，读回来必须还原，否则写进去
    // 再读出来就不是同一个值了；单引号按 shell 语义一律字面量
    if (/^"(.*)"$/.test(value)) value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function read() {
  try {
    return { path: envPath(), exists: true, values: parse(fs.readFileSync(envPath(), 'utf8')) };
  } catch (err) {
    return { path: envPath(), exists: false, values: {} };
  }
}

/** 有空格、井号、引号的值加双引号；换行在 patch() 里已经被拒掉了 */
function format(key, value) {
  const needQuote = /[\s#'"]/.test(value);
  return key + '=' + (needQuote ? '"' + value.replace(/(["\\])/g, '\\$1') + '"' : value);
}

/**
 * 合并写回。updates 里值为 null / '' 表示删掉这一行；
 * 值为 undefined 的键当作没传，原来那行原样留着。
 * 命中的行原地替换，没命中的追加到末尾，其余一个字节都不动。
 */
function patch(raw) {
  const updates = {};
  for (const k of Object.keys(raw)) if (raw[k] !== undefined) updates[k] = raw[k];
  const keys = Object.keys(updates);
  for (const k of keys) {
    const v = updates[k];
    if (v == null || v === '') continue;
    if (typeof v !== 'string') throw new Error(k + ' 必须是字符串');
    if (/[\r\n\0]/.test(v)) throw new Error(k + ' 不能包含换行 —— 那会往 .env 里注入别的变量');
  }

  const file = envPath();
  let original = '';
  try { original = fs.readFileSync(file, 'utf8'); } catch (err) { original = ''; }

  const lines = original ? original.split('\n') : [];
  const done = Object.create(null);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i]);
    if (!m || !Object.prototype.hasOwnProperty.call(updates, m[1])) continue;
    const key = m[1];
    const value = updates[key];
    if (value == null || value === '') { lines[i] = null; }   // 稍后整行删掉
    else lines[i] = format(key, value);
    done[key] = true;
  }

  const kept = lines.filter((l) => l !== null);
  let appended = false;
  for (const key of keys) {
    const value = updates[key];
    if (done[key] || value == null || value === '') continue;
    // 空行只在第一次追加前加一次：把我们这段和用户原有内容隔开，
    // 但自己的几行之间不隔 —— 否则新建的文件里每两行之间都夹一个空行
    if (!appended && kept.length && kept[kept.length - 1].trim() !== '') kept.push('');
    appended = true;
    kept.push(format(key, value));
  }

  let text = kept.join('\n').replace(/\n{3,}$/, '\n');
  if (text && !text.endsWith('\n')) text += '\n';
  // 0600：这文件里躺着一把能花钱的 key，别让同机其他用户读到
  fs.writeFileSync(file, text, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (err) { /* Windows 上没这回事 */ }
  return { path: file, text: text };
}

/** sk-abcdef…wxyz：够用户认出来是哪一把，又不足以拿去用 */
function mask(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 12) return v.slice(0, 2) + '…';
  return v.slice(0, 6) + '…' + v.slice(-4);
}

module.exports = { envPath, parse, read, patch, mask, format };
