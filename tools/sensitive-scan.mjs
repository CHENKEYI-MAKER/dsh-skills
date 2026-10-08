#!/usr/bin/env node
// 敏感信息扫描器：找出"不该进公开仓库"的内容。
//
// 为什么单独一个文件：校验器（tools/validate.mjs）管"技能写得好不好"，
// 这里管"会不会泄密"。两件事的失败代价不一样 —— 格式错了只是不好用，
// 泄密是把真实服务器地址、密钥、公司全称发到了公网，撤不回来。
//
// 设计要点：
//   1. 只按**形状**识别（IP、密钥前缀、路径形状、中文公司名后缀），
//      不写死任何本公司具体值 —— 写死等于把值又抄了一遍。
//   2. 命中片段（excerpt）**一律脱敏**后才返回：它会画到管理员看板、
//      也可能进日志，再泄一次就白做了。
//   3. 占位符豁免：`<HOST>` `[客户名]` `xxxx` `TBD` 这些是**正确写法**，
//      判成问题会把合格技能全卡住（见 EXEMPT_* 与 segmentOf）。
//
// 零第三方依赖：只用 node 内置模块。

import { readFileSync, existsSync, statSync } from 'node:fs'

// ─────────────────────────────────────────────────────────────
// 私有 / 特殊网段：这些出现在公开仓库里**不算**泄露（是本机或内网地址）
// ─────────────────────────────────────────────────────────────
const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^255\.255\.255\.255$/,
]

// 公共域名白名单：文档里正常会提到的开源站点，不算"真实业务域名"
const DOMAIN_WHITELIST = [
  'github.com',
  'npmjs.com',
  'nodejs.org',
  'deepseek.com',
  'example.com',
  'example.org',
  'localhost',
]
const DOMAIN_WHITELIST_WILDCARD = [/^[a-z0-9-]+\.example\.(?:com|org|net|cn)$/i]

const isPrivateIp = (ip) => PRIVATE_IPV4.some((re) => re.test(ip))

const isWhitelistedDomain = (host) => {
  const h = host.toLowerCase()
  if (DOMAIN_WHITELIST.includes(h)) return true
  return DOMAIN_WHITELIST_WILDCARD.some((re) => re.test(h))
}

// ─────────────────────────────────────────────────────────────
// 规则表
//   id        规则 id（稳定，看板/日志/测试都按它匹配）
//   severity  'problem' 必须拦下 | 'warn' 提醒管理员看一眼
//   re        源码形态正则（扫描时补上 g / d 标志）
//   message   人话说明
//   excerpt   脱敏方式：'ip' | 'key' | 'domain' | 'path' | 'company' | 'email' | 'phone' | 'id' | 'raw'
//   valueGroup 命中时以哪个捕获组作为"值"（算列号、脱敏、豁免都用它）
//   maskChar  打码字符，默认 '*'
//   exemptMask 连续打码（xxxx / ****）是否算占位符：
//             IP 这类"本来就是数字"的规则要设 false，否则 1.2.3.4 里的数字
//             会被当成 xxxx 打码而漏报
// ─────────────────────────────────────────────────────────────
export const DEFAULT_RULES = [
  {
    id: 'public-ip',
    severity: 'problem',
    re: /\b((?:\d{1,3}\.){3}\d{1,3})\b/g,
    message: '出现公网 IP 地址（真实服务器地址不应进公开仓库，请改成 <HOST> 占位值）',
    excerpt: 'ip',
    valueGroup: 1,
    exemptMask: false,
  },
  {
    id: 'local-abs-path',
    severity: 'problem',
    re: /(?:\/Users\/|\/home\/|\/root\/)([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g,
    message: '出现本机绝对路径（含真实用户名，请改成 <SRC_DIR> / <DEPLOY_DIR> 这类占位值）',
    excerpt: 'path',
    valueGroup: 0,
  },
  {
    id: 'api-key-shape',
    severity: 'problem',
    re: /(?:\bsk-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{20,}|\bgho_[A-Za-z0-9]{20,}|\bghs_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    message: '出现疑似密钥/令牌（一旦提交到公开仓库必须立即吊销并轮换）',
    excerpt: 'key',
    valueGroup: 0,
  },
  {
    id: 'credential-assignment',
    severity: 'problem',
    re: /(?:\b(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth)\b|密码|口令|密钥|验证码)\s*[:=：＝]\s*["'`]?([^\s"'`,;，。；）)\]}]{6,})/gi,
    message: '出现"凭据 = 真值"的赋值（占位符请写成 <TOKEN> / TBD 这类形态）',
    excerpt: 'key',
    valueGroup: 1,
  },
  {
    id: 'cn-mobile',
    severity: 'problem',
    re: /(?<!\d)(1[3-9]\d{9})(?!\d)/g,
    message: '出现中国大陆手机号（个人联系方式属于个人信息，不要写进公开技能）',
    excerpt: 'phone',
    valueGroup: 1,
  },
  {
    id: 'cn-id-card',
    severity: 'problem',
    re: /(?<![0-9A-Za-z])(\d{17}[\dXx])(?![0-9A-Za-z])/g,
    message: '出现 18 位身份证号（属于敏感个人信息，必须移除）',
    excerpt: 'id',
    valueGroup: 1,
  },
  {
    id: 'real-company-name',
    severity: 'warn',
    re: /[\u4e00-\u9fa5A-Za-z0-9]{2,30}?(?:股份有限公司|有限责任公司|有限公司|集团)/g,
    message: '出现疑似真实公司全称（公开仓库里请用 [客户名] / 示例公司 这类占位值）',
    excerpt: 'company',
    valueGroup: 0,
  },
  {
    id: 'email-address',
    severity: 'warn',
    re: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?![A-Za-z0-9.-])/g,
    message: '出现邮箱地址（确认是否是真实工作邮箱；示例请用 name@example.com）',
    excerpt: 'email',
    valueGroup: 1,
  },
  {
    id: 'real-domain',
    severity: 'warn',
    re: /(?<![A-Za-z0-9_@./-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|cn|net|org|io|dev|app|online|xyz|top|site|shop|vip|tech|info|biz|co|me|cc|us|uk|de|jp|ai|cloud|store|live|fun|work|link|club|art|wang|xin|ren|group))(?!\.[A-Za-z0-9])/gi,
    message: '出现疑似真实域名（公共站点白名单之外；请改成 <HOST> 或 example.com）',
    excerpt: 'domain',
    valueGroup: 1,
  },
]

// ─────────────────────────────────────────────────────────────
// 占位符豁免形态
// ─────────────────────────────────────────────────────────────
const EXEMPT_PATTERNS = [
  /<[^<>\n]{1,64}>/, // <HOST> <SRC_DIR> <服务名>
  /\[[^[\]\n]{1,32}\]/, // [客户名] [限额]
  /(?:x{3,}|\*{3,}|X{3,}|×{3,}|●{3,})/, // xxx *** **** —— 注意要 3 个以上：
  // `温州XX生物` 这种真名称里也有 XX，不能被当成打码而放过
  /(?:\bTBD\b|\bTODO\b|\bCHANGEME\b|待定|待补|your-[a-z0-9-]*-here)/i, // 明确的无值标记
  /^(?:无|暂无|略|n\/a|none|nil)$/i, // （无） — ——
]
// 连续打码单独拎出来，方便按规则开关（见 DEFAULT_RULES[].exemptMask）
const MASK_PATTERN = EXEMPT_PATTERNS[2]
// 凭据赋值里，值等于这些词就明显是占位符
const PLACEHOLDER_WORDS = new Set([
  '', '无', '暂无', '略', 'none', 'nil', 'null', 'undefined', 'n/a',
  'tbd', 'todo', 'changeme', 'xxx', 'xxxx', 'xxxxx', 'your-password-here',
])
const SEPARATORS = /[:=：＝]/
const SPAN_CLOSERS = new Set([...')）]】}》」』'])
const SPAN_DELIMITERS = new Set([...' \t"\'`,;，。；、|<>「」『』()（）[]【】{}《》'])
// 段尾部允许跟一个收尾符号：`密码:（无）` 要能看出值是「无」而不是空
const SEGMENT_RE = /^[^\s"'`,;，。；、|<>「」『』()（）[\]【】{}《》]*(?:[)）\]】}》」』])?/

/**
 * 取"命中所在的那一段文本"：往前到最近的空白/引号/逗号，往后同理。
 * 用来判断这是真值还是占位符（`<HOST>` 前后有尖括号，正是靠这一步看出来的）。
 */
const segmentOf = (text, from) => {
  const lineStart = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  let start = lineStart
  for (let i = from - 1; i >= lineStart; i--) {
    const ch = text[i]
    if (SPAN_DELIMITERS.has(ch)) {
      // `（无）`：开括号左边如果没跟着收尾符号，说明命中在括号里面，把开括号让出去
      if (!SPAN_CLOSERS.has(text[i + 1] ?? '')) {
        start = i + 1
        break
      }
    }
  }
  return text.slice(start).match(SEGMENT_RE)[0]
}

/** 从一段文本里挑出"值"那部分：`password: xxxx` → `xxxx`；`密码:（无）` → `无` */
function valuePart(seg) {
  let out = seg.trim()
  while (out.length && SPAN_CLOSERS.has(out[out.length - 1])) out = out.slice(0, -1).trim()
  const sep = out.search(SEPARATORS)
  if (sep >= 0) out = out.slice(sep + 1).trim()
  return out.replace(/^[（(【[]+/, '').replace(/[）)】\]]+$/, '').trim()
}

/** 这段文本是不是占位符形态（命中落在这里就丢弃） */
function isExempt(seg, rule) {
  const value = valuePart(seg)
  if (PLACEHOLDER_WORDS.has(value.toLowerCase())) return true
  for (const re of EXEMPT_PATTERNS) {
    if (re === MASK_PATTERN && rule.exemptMask === false) continue
    if (re.test(seg) || re.test(value)) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────
// 脱敏：返回的 excerpt 会进看板/日志，绝不能带完整真值
// ─────────────────────────────────────────────────────────────
const maskKeepEnds = (s, head, tail, mask = '*') =>
  s.length <= head + tail + 1 ? s : s.slice(0, head) + mask.repeat(4) + s.slice(s.length - tail)

function sanitizeExcerpt(kind, raw, rule) {
  const s = raw.trim()
  if (kind === 'ip') {
    const parts = s.split('.')
    return parts.length === 4 ? `${parts[0]}.***.***.${parts[3]}` : maskKeepEnds(s, 3, 2)
  }
  if (kind === 'key') return `${s.slice(0, 4)}…(${s.length} 字符)`
  if (kind === 'path') {
    if (s.startsWith('/root/')) return '/root/***'
    const m = /^\/(Users|home)\//.exec(s)
    const rest = s.slice(m ? m[0].length : 0)
    const tail = rest.slice(rest.indexOf('/') + 1)
    return tail ? `/${m[1]}/***/${tail}` : `/${m[1]}/***`
  }
  if (kind === 'company') {
    const m = /^([\u4e00-\u9fa5]{2,})/.exec(s)
    return m ? `${s.slice(0, 2)}…` : `${s.slice(0, 2)}…`
  }
  if (kind === 'domain') {
    const parts = s.split('.')
    if (parts.length < 3) return `${parts[0]}.****.${parts[parts.length - 1]}`
    return `${parts[0]}.${(rule.maskChar ?? '*').repeat(4)}.${parts[parts.length - 1]}`
  }
  if (kind === 'email') {
    const at = s.lastIndexOf('@')
    if (at <= 0) return maskKeepEnds(s, 2, 2)
    return `${(rule.maskChar ?? '*').repeat(3)}@${s.slice(at + 1)}`
  }
  if (kind === 'phone') return maskKeepEnds(s, 3, 4)
  if (kind === 'id') return maskKeepEnds(s, 3, 1)
  return maskKeepEnds(s, 2, 2)
}

// ─────────────────────────────────────────────────────────────
// 扫描
// ─────────────────────────────────────────────────────────────
function cloneRule(re) {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags + 'd' : re.flags + 'gd')
}

function positionOf(text, index) {
  const before = text.slice(0, index)
  const nl = before.lastIndexOf('\n')
  return { line: before.split('\n').length, column: index - nl }
}

/**
 * 扫描一段文本，返回命中列表。
 *
 * @param {string} text 待扫描文本
 * @param {{ file?: string, rules?: Array }} [options]
 * @returns {{ hits: Array, counts: { problem: number, warn: number } }}
 */
export function scanSensitive(text, { file = '', rules = DEFAULT_RULES } = {}) {
  const hits = []
  if (typeof text !== 'string' || text.length === 0) return { hits, counts: { problem: 0, warn: 0 } }

  for (const rule of rules) {
    const re = cloneRule(rule.re)
    let m
    while ((m = re.exec(text)) !== null) {
      if (m[0] === '') {
        re.lastIndex++
        continue
      }
      const g = rule.valueGroup ?? 0
      const value = m[g] ?? m[0]
      const indices = m.indices?.[g] ?? m.indices?.[0] ?? [m.index, m.index + m[0].length]
      const [vStart, vEnd] = indices

      if (rule.id === 'public-ip' && isPrivateIp(value)) continue
      if (rule.id === 'real-domain' && isWhitelistedDomain(value)) continue
      if (rule.id === 'credential-assignment' && isExempt(valuePart(value), rule)) continue

      const seg = segmentOf(text, vStart)
      if (isExempt(seg, rule)) continue

      const { line, column } = positionOf(text, vStart)
      hits.push({
        rule: rule.id,
        severity: rule.severity,
        line,
        column,
        excerpt: sanitizeExcerpt(rule.excerpt ?? 'raw', value, rule),
        message: rule.message,
        ...(file ? { file } : {}),
      })
    }
  }

  return { hits, counts: countHits(hits) }
}

function countHits(hits) {
  const counts = { problem: 0, warn: 0 }
  for (const h of hits) {
    if (h.severity === 'problem') counts.problem++
    else counts.warn++
  }
  return counts
}

/**
 * 批量扫描（服务端按这个签名调用）：
 * files: [{ path, content }] → { files: [{ path, hits, counts }], totals: { problem, warn } }
 */
export function scanFiles(files, { rules } = {}) {
  const out = []
  const totals = { problem: 0, warn: 0 }
  for (const f of files ?? []) {
    const path = f?.path ?? ''
    const { hits, counts } = scanSensitive(f?.content ?? '', {
      file: path,
      ...(rules ? { rules } : {}),
    })
    out.push({ path, hits, counts })
    totals.problem += counts.problem
    totals.warn += counts.warn
  }
  return { files: out, totals }
}

// ─────────────────────────────────────────────────────────────
// 目录遍历辅助：给校验器用（跳过二进制与超大文件）
// ─────────────────────────────────────────────────────────────
export const MAX_SCAN_BYTES = 256 * 1024

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tiff', '.avif',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.webm', '.ogg',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.node', '.wasm', '.class', '.o', '.a',
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.sqlite', '.db', '.pyc',
])

/**
 * 是否是"可以当文本扫"的文件。
 * 判据：① 已读到的字节里没有 NUL；② 扩展名不在二进制黑名单；③ 无扩展名时看解码质量。
 */
export function looksLikeText(buffer, ext = '') {
  if (BINARY_EXTENSIONS.has(ext.toLowerCase())) return false
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192))
  for (const byte of probe) if (byte === 0) return false
  const decoded = probe.toString('utf8')
  if (decoded.includes('\uFFFD')) return decoded.split('\uFFFD').length - 1 < 3
  return true
}

/** 读一个文件并返回可扫描文本；读不了/二进制/超大 → null */
export function readScannable(path) {
  if (!existsSync(path)) return null
  const st = statSync(path)
  if (!st.isFile() || st.size === 0 || st.size > MAX_SCAN_BYTES) return null
  const buf = readFileSync(path)
  const ext = path.slice(path.lastIndexOf('.'))
  if (!looksLikeText(buf, ext.includes('/') ? '' : ext)) return null
  return buf.toString('utf8')
}

// ─────────────────────────────────────────────────────────────
// CLI
//   node tools/sensitive-scan.mjs <文件...>        # 有 problem 则退出码 1
//   node tools/sensitive-scan.mjs --json <文件...>
// ─────────────────────────────────────────────────────────────
function main(argv) {
  const asJson = argv.includes('--json')
  const help = argv.includes('-h') || argv.includes('--help')
  const files = argv.filter((a) => !a.startsWith('-'))

  if (help || files.length === 0) {
    console.log(`用法: node tools/sensitive-scan.mjs [--json] <文件...>

扫描文件里的敏感信息（公网 IP、本机路径、密钥、手机号、身份证、公司全称、邮箱、真实域名）。
命中片段一律脱敏后才打印，可以直接贴到工单里。有 problem 级命中时退出码 1。`)
    process.exit(help ? 0 : 2)
  }

  const payload = []
  for (const path of files) {
    const content = readScannable(path)
    if (content === null) {
      payload.push({ path, hits: [], counts: { problem: 0, warn: 0 }, skipped: true })
      continue
    }
    const { hits, counts } = scanSensitive(content, { file: path })
    payload.push({ path, hits, counts })
  }

  const totals = payload.reduce(
    (acc, f) => ({ problem: acc.problem + f.counts.problem, warn: acc.warn + f.counts.warn }),
    { problem: 0, warn: 0 },
  )

  if (asJson) {
    console.log(JSON.stringify({ files: payload, totals }, null, 2))
  } else {
    for (const f of payload) {
      if (f.skipped) {
        console.log(`跳过（二进制或超过 ${MAX_SCAN_BYTES / 1024}KB）：${f.path}`)
        continue
      }
      if (!f.hits.length) continue
      console.log(`\n${f.path}`)
      for (const h of f.hits) {
        const mark = h.severity === 'problem' ? '❌' : '⚠️ '
        console.log(`  ${mark} ${h.line}:${h.column} [${h.rule}] ${h.excerpt} — ${h.message}`)
      }
    }
    console.log(`\n合计：${totals.problem} 个问题、${totals.warn} 个提醒`)
  }

  process.exit(totals.problem > 0 ? 1 : 0)
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) main(process.argv.slice(2))
