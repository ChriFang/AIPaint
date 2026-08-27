'use strict';
/**
 * agent 配置。DEEPSEEK_API_KEY 只在这个文件读取，绝不出现在任何响应体里。
 *
 * publicConfig() 刻意用显式白名单一个字段一个字段地抄，不用 {...cfg, ...} ——
 * 参考实现里 toMaskedConfig 就是因为对象展开，把原始 key 一路带到了渲染进程。
 */

const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const EFFORTS = ['low', 'medium', 'high'];

function intEnv(name, def, lo, hi) {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

/** 每次请求现读 process.env：所以界面上存完凭证就地改一下变量就能生效，不用重启 */
function load() {
  const strict = process.env.AIPAINT_AGENT_STRICT === '1';
  // strict 模式（structured outputs）只在 /beta 端点上提供
  const fallbackBase = strict ? DEFAULT_BASE_URL + '/beta' : DEFAULT_BASE_URL;
  const effort = process.env.AGENT_REASONING_EFFORT;
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
    baseUrl: (process.env.DEEPSEEK_BASE_URL || fallbackBase).replace(/\/+$/, ''),
    strict: strict,
    maxRounds: intEnv('AGENT_MAX_ROUNDS', 8, 1, 24),
    // 版面算术是「浅但多步」，high 主要买深度，这里买不到什么
    reasoningEffort: EFFORTS.indexOf(effort) >= 0 ? effort : 'medium',
    // 思考过程转发给面板（自己的 SSE 事件，绝不混进正文，也不回灌模型历史）。设 0 只留一条阶段提示
    streamReasoning: process.env.AGENT_STREAM_REASONING !== '0',
    requestTimeoutMs: intEnv('AGENT_REQUEST_TIMEOUT_MS', 180000, 5000, 600000),
    maxConcurrent: intEnv('AGENT_MAX_CONCURRENT', 2, 1, 8),
    // fixture：把 fetch 换成读 test/fixtures/*.sse，CI 不烧 API
    transport: process.env.AIPAINT_AGENT_TRANSPORT === 'fixture' ? 'fixture' : 'http',
    fixtureDir: process.env.AIPAINT_AGENT_FIXTURE_DIR || 'test/fixtures',
    fixtureName: process.env.AIPAINT_AGENT_FIXTURE || '',
    record: process.env.AIPAINT_AGENT_RECORD === '1',
    debug: process.env.AIPAINT_AGENT_DEBUG === '1'
  };
}

/** 给浏览器的配置：只有面板需要的几项，没有 key，也没有 baseUrl */
function publicConfig(cfg) {
  return {
    model: cfg.model,
    // 面板只关心「能不能发」。fixture 传输不需要 key 也能跑完整条链路，
    // 所以这里按可用性回答，否则本地回放时面板会自己把发送键锁死。
    hasApiKey: cfg.apiKey.length > 0 || cfg.transport === 'fixture',
    strict: cfg.strict,
    maxRounds: cfg.maxRounds,
    reasoningEffort: cfg.reasoningEffort
  };
}

module.exports = { load, publicConfig, DEFAULT_MODEL, DEFAULT_BASE_URL };
