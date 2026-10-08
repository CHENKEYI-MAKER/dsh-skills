#!/usr/bin/env node
// 公司资料技能库的校验器。
//
// 做技术校验（格式错了 DSH 会静默忽略，最难查）：
//   1. 每个技能目录必须有 SKILL.md，且必须有 YAML frontmatter
//   2. name 必须符合 DSH 的语法 ^[a-z0-9]+(?:-[a-z0-9]+)*$，且全库唯一
//   3. name 必须与目录名一致（不一致时人的心智模型和实际加载的名字会分叉）
//   4. description / whenToUse 必填，且不许写成没有触发信息的废话
//   5. 正文不许为空、不许只剩标题
//
// 做"能不能被用上"的校验（这才是 100 个 SOP 之后真正会崩的地方）：
//   6. description 之间近似重复 —— 两个技能都声称处理同一件事，模型会随机挑一个
//   7. description 里没有"什么时候用/不适用"的线索
//
// 做"结构是否统一"的校验（公司标准四段）：
//   8. 必须含 ## 触发条件 / ## 步骤 / ## 坑 / ## 验收标准，且**顺序正确**
//   9. 技能里不许出现"需要用户回答的技术问题"（技能的读者是 AI，不是人）
//
// 做"会不会泄密"的校验（这个失败代价最大，撤不回来）：
//  10. 技能目录下的**所有文本文件**（SKILL.md + references/ + scripts/ +
//      templates/ + assets/）都不许出现公网 IP、本机绝对路径、密钥、手机号、
//      身份证、公司全称、真实邮箱、真实域名 —— 见 tools/sensitive-scan.mjs。
//
// 零第三方依赖（自己解析 frontmatter，不引 js-yaml）。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanSensitive, readScannable } from './sensitive-scan.mjs'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// description 的长度窗口：太短没有信息量，太长挤占每次会话的上下文
const DESC_MIN = 12
const DESC_MAX = 160
const BODY_MIN = 80

// description 里出现这些词却没有任何触发条件，等于在说"我是个好流程"
const VAGUE_WORDS = ['流程', '规范', '制度', '相关工作', '有关事项', '等等']
const TRIGGER_HINTS = ['当', '需要', '如果', '若', '在…时', '时使用', '时用', '用于', '适用于', '触发', '不适用', '请求', '询问', '提交']

// 公司标准四段，顺序不可换（顺序代表"先判断该不该用，再执行，再避坑，最后验收"）
const REQUIRED_SECTIONS = ['触发条件', '步骤', '坑', '验收标准']

// 技能是写给 AI 执行的，出现这些问句说明把"该自己判断的事"推给了人。
// ⚠️ 只在**去掉代码块/行内代码/引用/引号内示例/表格**之后才扫，
// 否则"坑"小节里引用的反例会把自己误判成违规。
const ASK_HUMAN_PATTERNS = [
  /你(?:需要|要|想)(?:用|使用)哪[个些]/,
  /请(?:问|告诉)用户(?:你)?(?:用|使用)什么/,
  /需要(?:用户|你)回答/,
  /你的(?:操作)?系统是(?:什么|哪)/,
]

/**
 * 把"引用别人错误做法"的地方去掉，只留正文自己的主张：
 * 代码块（含围栏行）、行内代码、引用行、**禁止项（❌ 开头的规则本身就是反例）**、表格行。
 */
function stripQuoted(body) {
  const withoutFences = body
    .split('\n')
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .join('\n')
  const noBlocks = withoutFences.split(/```[\s\S]*?```/).join('\n')
  return noBlocks
    .split('\n')
    .filter((line) => !/❌/.test(line)) // 禁止项行：它描述的就是"不该出现什么"
    .join('\n')
    .replace(/`[^`\n]*`/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
}

function findSkillsRoot() {
  const here = fileURLToPath(import.meta.url)
  const repoRoot = resolve(join(here, '..', '..'))
  return join(repoRoot, 'skills')
}

/**
 * 极简 YAML frontmatter 解析：只支持本库用到的形状
 *   name: xxx
 *   description: 一句话
 *   whenToUse: 一句话
 *   metadata:
 *     author: xxx
 *     version: "0.1.0"
 * 以及 description 用 `>-` / `|` 折叠写法（多行）。
 */
function parseSkillFile(text) {
  if (!text.startsWith('---')) return { error: '文件开头不是 ---，缺少 frontmatter' }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { error: 'frontmatter 没有结束的 ---' }
  const head = text.slice(text.indexOf('\n', 3) + 1, end + 1)
  const body = text.slice(text.indexOf('\n', end + 1) + 1).trim()

  const data = {}
  let current = null
  let folded = null
  for (const rawLine of head.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) continue
    if (folded !== null) {
      // 折叠块（>- 或 |）的续行
      if (/^\s+\S/.test(line)) {
        folded.push(line.trim())
        continue
      }
      data[current] = folded.join(' ')
      folded = null
      current = null
    }
    const m = /^(\s*)([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const [, indent, key, value] = m
    if (indent.length >= 2) {
      // 缩进行是上一个键的子字段（本库只用到 metadata:）
      if (typeof data.metadata !== 'object' || data.metadata === null) data.metadata = {}
      data.metadata[key] = value
      continue
    }
    if (value === '>-' || value === '>' || value === '|' || value === '|-') {
      current = key
      folded = []
      continue
    }
    data[key] = value.replace(/^["']|["']$/g, '')
  }
  if (folded !== null && current) data[current] = folded.join(' ')
  return { data, body }
}

function bigrams(s) {
  const t = s.replace(/[\s，。、；：（）()"']/g, '')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return (2 * hit) / (A.size + B.size)
}

function validate(root) {
  const problems = []
  const warnings = []
  const skills = []

  if (!existsSync(root)) {
    return { problems: [`技能根目录不存在：${root}`], warnings: [], skills: [] }
  }

  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry)
    if (!statSync(dir).isDirectory()) {
      problems.push(`skills/ 下出现散落文件「${entry}」——技能必须是一个目录，目录里放 SKILL.md`)
      continue
    }
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) {
      // 附属目录（templates / references）不算技能
      if (['templates', 'references', 'scripts', 'assets'].includes(entry)) continue
      problems.push(`${entry}/：缺少 SKILL.md（这个目录不会被 DSH 识别为技能）`)
      continue
    }

    const parsed = parseSkillFile(readFileSync(file, 'utf8'))
    if (parsed.error) {
      problems.push(`${entry}/SKILL.md：${parsed.error}`)
      continue
    }
    const { data, body } = parsed

    if (!data.name) problems.push(`${entry}/SKILL.md：frontmatter 缺 name`)
    else if (!SKILL_NAME.test(data.name)) {
      problems.push(`${entry}/SKILL.md：name「${data.name}」不合语法（只能小写字母、数字，用连字符连接，如 expense-report）`)
    } else if (data.name !== entry) {
      problems.push(`${entry}/SKILL.md：name「${data.name}」与目录名「${entry}」不一致`)
    }

    if (!data.description) problems.push(`${entry}/SKILL.md：frontmatter 缺 description（模型靠它决定要不要加载这个技能）`)
    else {
      const d = data.description
      if (d.length < DESC_MIN) problems.push(`${entry}/SKILL.md：description 只有 ${d.length} 字，太短，模型无法判断何时使用`)
      if (d.length > DESC_MAX) warnings.push(`${entry}/SKILL.md：description ${d.length} 字，超过建议的 ${DESC_MAX} 字——它每次都进上下文`)
      if (!/。|\.$/.test(d)) warnings.push(`${entry}/SKILL.md：description 建议以句号结尾`)
      const hasHint = TRIGGER_HINTS.some((h) => d.includes(h))
      const onlyVague = VAGUE_WORDS.filter((w) => d.includes(w))
      if (!hasHint && onlyVague.length > 0) {
        problems.push(`${entry}/SKILL.md：description 只说「${onlyVague.join('、')}」却没写什么时候用——模型不会知道该在什么任务上加载它`)
      } else if (!hasHint) {
        warnings.push(`${entry}/SKILL.md：description 里没有出现「当/需要/用于…」这类触发线索，建议补一句什么时候用`)
      }
    }

    if (!data.whenToUse) {
      warnings.push(`${entry}/SKILL.md：建议补 whenToUse，把「什么时候用 / 什么时候不用」写清楚`)
    }

    if (!body) problems.push(`${entry}/SKILL.md：正文为空（正文是给 AI 执行的指令，不能只有 frontmatter）`)
    else if (body.replace(/^#.*$/gm, '').trim().length < BODY_MIN) {
      warnings.push(`${entry}/SKILL.md：正文只有 ${body.length} 字，偏薄，可能不足以执行`)
    }

    if (body) {
      // 公司标准四段：必须齐全，且顺序不能换
      const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].trim())
      const missing = REQUIRED_SECTIONS.filter((s) => !headings.includes(s))
      if (missing.length) {
        problems.push(`${entry}/SKILL.md：缺少标准小节 ${missing.map((s) => `## ${s}`).join('、')}（公司标准结构：触发条件 → 步骤 → 坑 → 验收标准）`)
      } else {
        const order = REQUIRED_SECTIONS.map((s) => headings.indexOf(s))
        for (let i = 1; i < order.length; i++) {
          if (order[i] < order[i - 1]) {
            problems.push(`${entry}/SKILL.md：标准小节顺序不对（当前顺序：${headings.filter((h) => REQUIRED_SECTIONS.includes(h)).map((s) => `## ${s}`).join(' → ')}）—— 必须按 触发条件 → 步骤 → 坑 → 验收标准`)
            break
          }
        }
      }

      // 技能是写给 AI 执行的：不该留下需要人来回答的技术问题。
      // 逐行判：**同一行出现否定词就不算违规**（"验收标准里不许有任何需要人来回答的
      // 技术问题"这类描述本身不是问题），否则禁止项自己会把自己判成违规。
      const scannable = stripQuoted(body)
      let hitText = null
      for (const line of scannable.split('\n')) {
        for (const re of ASK_HUMAN_PATTERNS) {
          const m = re.exec(line)
          if (!m) continue
          const before = line.slice(0, m.index)
          if (/(没有任何|没有|不含|不要|不许|禁止|不得|不可|无)/.test(before)) continue
          hitText = m[0].trim()
          break
        }
        if (hitText) break
      }
      if (hitText) {
        problems.push(`${entry}/SKILL.md：正文出现「${hitText.slice(0, 30)}」这类需要人来回答的技术问题——环境判断和工具选择应由执行者自判`)
      }
    }

    skills.push({ dir: entry, name: data.name ?? entry, description: data.description ?? '', whenToUse: data.whenToUse ?? '' })
  }

  // 近似重复：两个技能声称做同一件事，模型会随机选
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const sim = similarity(skills[i].description, skills[j].description)
      if (sim >= 0.35) {
        problems.push(
          `「${skills[i].name}」与「${skills[j].name}」的 description 有 ${Math.round(sim * 100)}% 重合——两者会互相抢触发，请合并或把适用边界写清`,
        )
      } else if (sim >= 0.2) {
        warnings.push(`「${skills[i].name}」与「${skills[j].name}」描述相近（${Math.round(sim * 100)}%），确认边界是否清楚`)
      }
    }
  }

  return { problems, warnings, skills }
}

/**
 * 递归收集技能目录下所有**可当文本扫**的文件（跳过二进制、>256KB 的、隐藏目录）。
 * 技能泄密不止发生在 SKILL.md：references/ 里的真实限额、scripts/ 里的写死口令
 * 一样会跟着仓库公开。
 */
function collectTextFiles(dir, root, out = []) {
  let entries
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      collectTextFiles(full, root, out)
      continue
    }
    if (!st.isFile() || st.size === 0) continue
    const text = readScannable(full)
    if (text === null) continue
    out.push({ path: relative(root, full), real: full, text })
  }
  return out
}

/**
 * 敏感信息检查（第 10 类）。做成独立的后置遍历，不改动上面任何原有检查：
 * 逐技能目录扫全部文本文件，problem 级进 problems、warn 级进 warnings。
 */
function scanSkillsForSensitive(root) {
  const problems = []
  const warnings = []
  const detail = []
  if (!existsSync(root)) return { problems, warnings, detail }

  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry)
    let isDir = false
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir || !existsSync(join(dir, 'SKILL.md'))) continue

    for (const f of collectTextFiles(dir, root)) {
      const { hits, counts } = scanSensitive(f.text, { file: f.path })
      if (!hits.length) continue
      for (const h of hits) {
        const at = `${f.path}:${h.line}:${h.column}`
        const text = `${at}：${h.message}（规则 ${h.rule}，命中片段：${h.excerpt}）`
        if (h.severity === 'problem') problems.push(text)
        else warnings.push(text)
      }
      detail.push({ skill: entry, file: f.path, hits, counts })
    }
  }
  return { problems, warnings, detail }
}

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  console.log(`用法: node tools/validate.mjs [--json] [--dir <技能根目录>]

校验公司资料技能库。退出码 0 = 全部通过（警告不算失败），1 = 有错误。`)
  process.exit(0)
}

const dirIdx = args.indexOf('--dir')
const root = dirIdx >= 0 ? resolve(args[dirIdx + 1]) : findSkillsRoot()
const result = validate(root)

// 敏感信息检查：只**追加**错误/提醒，不动已有字段
const sensitive = scanSkillsForSensitive(root)
result.problems.push(...sensitive.problems)
result.warnings.push(...sensitive.warnings)

const sensitiveSummary = {
  problems: sensitive.problems.length,
  warnings: sensitive.warnings.length,
  hits: sensitive.detail,
}

if (args.includes('--json')) {
  console.log(JSON.stringify({ root, ok: result.problems.length === 0, ...result, sensitive: sensitiveSummary }, null, 2))
} else {
  console.log(`技能库：${root}`)
  console.log(`共 ${result.skills.length} 个技能\n`)
  for (const s of result.skills) console.log(`  · ${s.name}`)
  console.log(
    `\n🔒 敏感信息扫描（全目录文本文件）：${sensitiveSummary.problems} 个问题、${sensitiveSummary.warnings} 个提醒`,
  )
  if (result.warnings.length) {
    console.log(`\n⚠️  建议（${result.warnings.length}）：`)
    for (const w of result.warnings) console.log(`  - ${w}`)
  }
  if (result.problems.length) {
    console.log(`\n❌ 错误（${result.problems.length}）：`)
    for (const p of result.problems) console.log(`  - ${p}`)
    console.log('')
    process.exit(1)
  }
  console.log(`\n✓ ${result.skills.length} 个技能全部通过校验`)
}

process.exit(result.problems.length === 0 ? 0 : 1)
