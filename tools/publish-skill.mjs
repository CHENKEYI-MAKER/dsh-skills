#!/usr/bin/env node
// 把试运行通过的技能正式入库并安装到本机技能目录。
//
// 这是"入库 + 安装"这一段的自动化，配套技能见 skills/sop-to-skill/SKILL.md。
//
// 它做四件事：
//   1. 先校验技能本身（不合格直接停，不产生任何提交）
//   2. 更新 capabilities.md（技能清单）与 VERSION（整体版本 +1），一起提交
//   3. 把技能接到本机 DSH 技能加载目录（~/.dsh/skills/<技能库名> -> <仓库>/skills）
//   4. 复验：确认技能真的躺在加载目录里、真的能被解析到
//
// 设计上的三条取舍：
//   - **先校验、后写盘**：技能不合格时不留半个提交，避免"入库了但是坏的"
//   - **用符号链接而不是复制**：改完源码立即生效（实测 DSH 技能是热加载的），不用重装
//   - **失败如实说**：安装或复验失败就把错误原文打出来，并给出修复计划，不假装成功
//
// 零第三方依赖（只用 node 内置模块）。

import { readFileSync, writeFileSync, existsSync, lstatSync, symlinkSync, rmSync, realpathSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TABLE_HEADER = ['name', '触发条件（一句话）', '维护人', '版本', '入库时间']
const SKILLS_DIR_NAME = 'skills'
const CAPABILITIES_FILE = 'capabilities.md'
const VERSION_FILE = 'VERSION'

// ────────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────────

/** 路径比较用 realpath：中文路径会被百分号编码，macOS 的 /tmp 是符号链接 */
function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

function git(repo, args, { allowFail = false } = {}) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim() }
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
    if (allowFail) return { ok: false, out }
    throw new Error(`git ${args.join(' ')} 失败：${out || err.message}`)
  }
}

/** `0.1.0` -> `0.1.1`；非法版本号退回 `0.1.0` */
function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim())
  if (!m) return '0.1.0'
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

/** 取本地日期 YYYY-MM-DD（不用 toISOString，那样会按 UTC 算错一天） */
function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 极简 frontmatter 解析（只支持本库用到的形状） */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return null
  const data = {}
  let currentKey = null
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (kv) {
      currentKey = kv[1]
      const value = kv[2].trim()
      if (value === '') data[currentKey] = {}
      else data[currentKey] = value.replace(/^["']|["']$/g, '')
      continue
    }
    const nested = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (nested && currentKey) {
      if (typeof data[currentKey] !== 'object' || data[currentKey] === null) data[currentKey] = {}
      data[currentKey][nested[1]] = nested[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return data
}

// ────────────────────────────────────────────────────────────────
// capabilities.md
// ────────────────────────────────────────────────────────────────

/**
 * 解析 `| name | ... |` 表格行。
 * 只认 5 列的行，避免把文件里其他表格（比如说明用的示例）吃进来。
 */
export function parseCapabilities(text) {
  const lines = text.split(/\r?\n/)
  const rows = []
  const order = []
  let headerSeen = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length !== TABLE_HEADER.length) continue
    if (!headerSeen && cells[0] === 'name') {
      headerSeen = true
      continue
    }
    if (!headerSeen) continue
    if (cells.every((c) => /^-{2,}$/.test(c) || c === '')) continue
    if (!SKILL_NAME_RE.test(cells[0])) continue
    rows.push({ line: i, name: cells[0], when: cells[1], author: cells[2], version: cells[3], date: cells[4] })
    order.push(cells[0])
  }
  return { rows, order }
}

function renderRow(r) {
  return `| ${r.name} | ${r.when} | ${r.author} | ${r.version} | ${r.date} |`
}

/**
 * 在表格里插入/更新一行技能条目：先按 name 排序重排整表。
 * 保留表格上方的说明文字与 frontmatter 原样不动。
 *
 * 三个字段的所有权分清楚（这是本函数最容易写错的地方）：
 *   - `when`：**人工维护**。只在首次插入时用技能 description 的首句兜底；
 *     以后不再覆盖 —— 否则每次入库都会把人工润色过的说明冲掉，产生无意义的 churn。
 *   - `date`：首次入库记当天，之后永不改。
 *   - `author` / `version`：脚本维护。
 *
 * 返回的 `changed` 表示"这一行真的需要重写吗"，用**逐行比较**而不是整表文本比较 ——
 * 否则只要表里别的行被重排过，就会一直误判成"有变化"。
 */
export function upsertCapabilitiesRow(text, entry, { version } = {}) {
  const { rows } = parseCapabilities(text)
  const byName = new Map(rows.map((r) => [r.name, { ...r }]))
  const existing = byName.get(entry.name)

  const merged = {
    name: entry.name,
    when: existing?.when || entry.when,
    author: entry.author,
    version: version || entry.version || existing?.version || '0.1.0',
    // 首次入库记当天；已存在的保留原来的入库时间
    date: existing?.date || entry.date,
  }
  byName.set(entry.name, merged)

  const changed = !existing || renderRow(existing) !== renderRow(merged)
  const sorted = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'))
  const lines = text.split(/\r?\n/)

  // 找出表格行所在的区间：从第一条数据行到最后一条数据行
  const dataLineNums = rows.map((r) => r.line).sort((a, b) => a - b)
  if (dataLineNums.length === 0) return { text, added: true, changed: true }

  const first = dataLineNums[0]
  const last = dataLineNums[dataLineNums.length - 1]
  const before = lines.slice(0, first)
  const after = lines.slice(last + 1)
  const wasNew = !existing

  return { text: [...before, ...sorted.map(renderRow), ...after].join('\n'), added: wasNew, changed }
}

// ────────────────────────────────────────────────────────────────
// 技能解析与校验
// ────────────────────────────────────────────────────────────────

export function readSkillInfo(repo, name) {
  const file = join(repo, SKILLS_DIR_NAME, name, 'SKILL.md')
  if (!existsSync(file)) throw new Error(`找不到技能：${file}`)
  const data = parseFrontmatter(readFileSync(file, 'utf8'))
  if (!data) throw new Error(`${file} 缺少 frontmatter`)
  if (data.name !== name) throw new Error(`技能的 name「${data.name}」与目录名「${name}」不一致`)
  if (!data.description) throw new Error(`${file} 缺少 description`)
  const author = (data.metadata && data.metadata.author) || '未署名'
  const version = (data.metadata && data.metadata.version) || '0.1.0'
  // 触发条件取 description 的首句，够当清单里的一句话
  const when = String(data.description).split(/[。；]/)[0].trim() || String(data.description).slice(0, 60)
  return { file, data, author, version, when }
}

/** 找出技能库根目录：优先 --repo，否则从本文件位置往上找 */
function resolveRepo(explicit) {
  if (explicit) return resolve(explicit)
  const here = fileURLToPath(import.meta.url)
  return resolve(join(dirname(here), '..'))
}

/** 找可用的 dsh 命令（DSH_BIN 或 PATH），找不到返回 null */
export function findDsh() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN
  const candidates = []
  if (process.env.DSH_HOME) candidates.push(join(process.env.DSH_HOME, '..', 'bin'))
  try {
    const which = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' }).trim()
    if (which) return which.split(/\r?\n/)[0]
  } catch {
    /* PATH 里没有 dsh，正常 */
  }
  return null
}

// ────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────

/**
 * 入库 + 安装。
 * @returns 结构化结果；失败时 ok:false 并带 error 与 plan（修复计划）
 */
export function runPublish({
  repo: repoInput = '',
  skillName,
  hostDir = '',
  profile = 'web',
  commit = true,
  install = true,
  push = true,
  dryRun = false,
  validator = null,
  now = new Date(),
  log = () => {},
} = {}) {
  const result = {
    ok: false,
    skill: skillName,
    repo: '',
    version: '',
    commit: '',
    commitCreated: false,
    pushed: false,
    rowAdded: false,
    hostDir: '',
    link: '',
    installed: false,
    loadChecked: false,
    loadDetail: '',
    error: '',
    plan: '',
    warnings: [],
  }

  try {
    if (!skillName) throw new Error('缺少技能名')
    if (!SKILL_NAME_RE.test(skillName)) throw new Error(`技能名「${skillName}」不合语法：只能小写字母、数字、连字符`)

    const repo = resolveRepo(repoInput)
    result.repo = repo
    if (!existsSync(join(repo, SKILLS_DIR_NAME))) throw new Error(`${repo} 下没有 ${SKILLS_DIR_NAME}/，这不像技能库根目录`)
    if (!existsSync(join(repo, CAPABILITIES_FILE))) throw new Error(`${repo} 下没有 ${CAPABILITIES_FILE}`)

    // 1) 先校验，不合格立即停（不留半个提交）
    const validate = validator || (() => {
      try {
        const out = execFileSync(process.execPath, [join(repo, 'tools', 'validate.mjs'), '--json'], {
          encoding: 'utf8',
          cwd: repo,
        })
        return JSON.parse(out)
      } catch (err) {
        // 校验失败时退出码是 1，execFileSync 会抛；但 stdout 里仍有完整 JSON
        const raw = String(err.stdout || '')
        if (raw.trim()) return JSON.parse(raw)
        throw new Error(`跑校验器失败：${err.message}`)
      }
    })
    const report = validate()
    if (report && Array.isArray(report.problems) && report.problems.length > 0) {
      throw new Error(`校验没通过，已停止入库：\n    ${report.problems.join('\n    ')}`)
    }

    const info = readSkillInfo(repo, skillName)
    log(`  ✓ 校验通过：${skillName}`)

    // 2) capabilities.md + VERSION
    const versionFile = join(repo, VERSION_FILE)
    const oldVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '0.1.0'

    const capsFile = join(repo, CAPABILITIES_FILE)
    const capsText = readFileSync(capsFile, 'utf8')
    const skillPath = `${SKILLS_DIR_NAME}/${skillName}`

    // 先做一次"不换版本号"的预演：只有真的有事要做，才让 VERSION 往前走。
    // （否则每跑一次都把版本号 +1，再拿新版号重写清单 → 永远有 diff → 空提交）
    const rowInput = { name: skillName, when: info.when, author: info.author }
    const preview = upsertCapabilitiesRow(capsText, rowInput, { version: oldVersion })
    const dirty = git(repo, ['status', '--porcelain', '--', skillPath, CAPABILITIES_FILE, VERSION_FILE], { allowFail: true }).out
    const nothingToDo = !preview.changed && !dirty

    result.rowAdded = preview.added

    if (nothingToDo) {
      result.version = oldVersion
      result.alreadyPublished = true
      result.warnings.push(`「${skillName}」此前已入库且内容无变化，本次没有产生任何改动`)
      log(`  · 内容无变化，跳过提交与版本变更（当前 v${oldVersion}）`)
    } else {
      const newVersion = bumpPatch(oldVersion)
      result.version = newVersion
      const updated = upsertCapabilitiesRow(capsText, rowInput, { version: newVersion })

      if (dryRun) {
        result.ok = true
        result.warnings.push('干跑模式：未写文件、未提交、未安装')
        return result
      }

      writeFileSync(capsFile, updated.text)
      writeFileSync(versionFile, `${newVersion}\n`)
      log(`  ✓ ${CAPABILITIES_FILE} ${updated.added ? '新增' : '更新'}条目，${VERSION_FILE} ${oldVersion} → ${newVersion}`)

      // 3) 提交（只提交这个技能的目录 + 两个元数据文件）
      if (commit) {
        git(repo, ['add', '--', skillPath, CAPABILITIES_FILE, VERSION_FILE])
        const staged = git(repo, ['diff', '--cached', '--name-only']).out
        if (!staged) {
          result.warnings.push('没有需要提交的改动（内容与上次一致）')
        } else {
          git(repo, [
            '-c', `user.name=${info.author}`,
            '-c', 'user.email=noreply@localhost',
            'commit', '-q', '-m', `feat(skill): ${skillName} v1`,
          ])
          result.commit = git(repo, ['rev-parse', '--short', 'HEAD']).out
          result.commitCreated = true
          log(`  ✓ 已提交 feat(skill): ${skillName} v1（${result.commit}）`)
        }

        // git log 确认提交真的落地（不靠 commit 命令的退出码）
        if (result.commitCreated) {
          const logLine = git(repo, ['log', '-1', '--pretty=%h %s']).out
          if (!logLine.includes(`feat(skill): ${skillName} v1`)) {
            throw new Error(`提交后 git log 里看不到本次提交，实际最新提交是：${logLine}`)
          }
          log(`  ✓ git log 确认：${logLine}`)
        }

        if (push && result.commitCreated) {
          const remote = git(repo, ['remote'], { allowFail: true }).out
          if (remote) {
            const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out
            const pushed = git(repo, ['push', '-q', 'origin', branch], { allowFail: true })
            if (pushed.ok) {
              result.pushed = true
              log(`  ✓ 已推送到 origin/${branch}`)
            } else {
              result.warnings.push(`推送失败（提交已在本地）：${pushed.out.split('\n')[0]}`)
            }
          } else {
            result.warnings.push('仓库没有 remote，跳过推送')
          }
        }
      } else {
        // --no-commit：入库和提交是一件事，不能只做一半。把刚写的两个文件还原，别留脏文件。
        git(repo, ['checkout', '--', CAPABILITIES_FILE, VERSION_FILE], { allowFail: true })
        result.warnings.push('--no-commit：清单与版本号已还原，本次没有改动入库')
      }
    }

    // 4) 安装到本机技能加载目录
    if (install) {
      const home = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh')
      const dir = resolve(hostDir || join(home, 'skills'))
      result.hostDir = dir
      const libName = basename(repo)
      const link = join(dir, libName)
      result.link = link

      mkdirSync(dir, { recursive: true })
      const target = join(repo, SKILLS_DIR_NAME)

      if (existsSync(link)) {
        const st = lstatSync(link)
        if (st.isSymbolicLink()) {
          if (samePath(link, target)) {
            log(`  · 链接已存在且指向正确：${link}`)
          } else {
            rmSync(link)
            symlinkSync(target, link, 'dir')
            log(`  ✓ 链接指向错误，已修正：${link} -> ${target}`)
          }
        } else {
          throw new Error(`${link} 已存在且不是符号链接（可能是一份旧的复制品）。请先手动确认并移除，再重跑。`)
        }
      } else {
        symlinkSync(target, link, 'dir')
        log(`  ✓ 已链接：${link} -> ${target}`)
      }
      result.installed = true

      // 5) 复验：确认从加载目录**真的能读到**这个技能（走链接读，不读源目录）
      const viaLink = join(link, skillName, 'SKILL.md')
      if (!existsSync(viaLink)) {
        throw new Error(`复验失败：从加载目录读不到 ${viaLink}`)
      }
      const fm = parseFrontmatter(readFileSync(viaLink, 'utf8'))
      if (!fm || fm.name !== skillName) {
        throw new Error(`复验失败：${viaLink} 解析出的 name 是「${fm && fm.name}」，不是「${skillName}」`)
      }
      const dirs = readdirSync(dir).filter((n) => !n.startsWith('.'))
      result.loadChecked = true
      result.loadDetail = `加载目录 ${dir} 下现有 ${dirs.length} 项：${dirs.join('、')}`

      // 有 dsh 命令的话再确认一次配置层面能被发现（拿不到就如实说，不算失败）
      const dsh = findDsh()
      if (dsh) {
        const dump = (() => {
          try {
            return { ok: true, out: execFileSync(dsh, ['--profile', profile, '--dump-config'], { encoding: 'utf8', timeout: 60_000 }) }
          } catch (err) {
            return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message }
          }
        })()
        if (dump.ok) {
          const m = new RegExp(`["']?${skillName}["']?`).test(dump.out)
          result.loadDetail += m
            ? `；dsh --dump-config 里能看到 ${skillName}`
            : `；dsh --dump-config 里没直接看到 ${skillName}（技能是运行时发现的，通常不写进 config，不算失败）`
        } else {
          result.warnings.push(`dsh --dump-config 没跑成功，跳过配置层复验：${dump.out.split('\n')[0]}`)
        }
      } else {
        result.warnings.push('本机 PATH 里没有 dsh 命令，只做了文件层复验')
      }
    }

    result.ok = true
    return result
  } catch (err) {
    result.error = err.message
    result.plan = buildPlan(result, err)
    return result
  }
}

function buildPlan(result, err) {
  const msg = String(err.message || '')
  if (/找不到技能/.test(msg)) return `先建技能：复制 templates/skill-template.md 到 skills/<技能名>/SKILL.md，填好四段内容再重跑。`
  if (/校验没通过/.test(msg)) return '改完技能内容后重跑同一条命令；校验器报什么就改什么。'
  if (/不合语法/.test(msg)) return '把技能目录和 frontmatter 的 name 一起改成小写字母+连字符（如 morning-sales-report）。'
  if (/name.*不一致/.test(msg)) return `把 frontmatter 的 name 改成与目录名一致。`
  if (/缺少 frontmatter|缺少 description/.test(msg)) return '补上 frontmatter 的 name 与 description（description 要写清何时触发、何时不适用）。'
  if (/不是符号链接/.test(msg)) return `先确认 ${result.link} 里没有你自己的技能（\`ls -la\`），确认后 \`rm -rf\` 掉再重跑。`
  if (/复验失败/.test(msg)) return '检查技能目录是否被移动、或 SKILL.md 的 name 与目录名是否一致，然后重跑。'
  if (/git /.test(msg)) return '看上面 git 的原始报错，修好后重跑；本脚本的提交是原子的，不会留半个提交。'
  return '按上面报错原文排查后重跑。'
}

// ────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    skill: '', repo: '', hostDir: '', profile: 'web',
    commit: true, install: true, push: true, dryRun: false, json: false, help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--skill' || a === '-s') opts.skill = next()
    else if (a === '--repo' || a === '-r') opts.repo = next()
    else if (a === '--host-dir') opts.hostDir = next()
    else if (a === '--profile') opts.profile = next()
    else if (a === '--no-commit') opts.commit = false
    else if (a === '--no-install') opts.install = false
    else if (a === '--no-push') opts.push = false
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--json') opts.json = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (!a.startsWith('-') && !opts.skill) opts.skill = a
    else throw new Error(`无法识别的参数：${a}`)
  }
  return opts
}

const USAGE = `\
把技能入库并安装到本机技能目录。

用法：
  node tools/publish-skill.mjs --skill <技能名> [选项]

选项：
  --skill, -s <名字>   要入库的技能（技能目录名，同时也是 frontmatter 的 name）
  --repo, -r <路径>    技能库根目录（默认：本脚本所在仓库）
  --host-dir <路径>    技能加载目录（默认：$DSH_HOME/skills 或 ~/.dsh/skills）
  --profile <名字>     复验用的 DSH profile（默认 web）
  --no-commit          只改文件，不 git commit
  --no-push            提交但不推送
  --no-install         只入库，不安装到本机
  --dry-run            只校验与预演，不写任何文件
  --json               以 JSON 输出结果
  -h, --help           显示本帮助

退出码：0 成功 / 1 参数或校验错误 / 2 执行失败（提交、安装或复验失败）
`

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`)
    process.exit(1)
  }
  if (opts.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  if (!opts.skill) {
    process.stderr.write(`缺少 --skill <技能名>\n\n${USAGE}`)
    process.exit(1)
  }

  const lines = []
  const log = (s) => lines.push(s)

  const result = runPublish({ ...opts, skillName: opts.skill, log })

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (result.ok) {
    process.stdout.write(`${lines.join('\n')}\n`)
    if (result.warnings.length) {
      process.stdout.write(`\n⚠️  ${result.warnings.map((w) => w).join('\n   ')}\n`)
    }
    if (opts.dryRun) {
      process.stdout.write(`\n（干跑）技能「${result.skill}」校验通过，会入库到 v${result.version}${result.rowAdded ? '（新增清单条目）' : '（更新清单条目）'}，但没有写任何文件。\n`)
    } else if (result.alreadyPublished) {
      process.stdout.write(`\n技能「${result.skill}」已是最新（v${result.version}），本次没有产生改动。\n`)
    } else {
      process.stdout.write(`\n技能「${result.skill}」已入库（${result.commit || '未提交'}）并安装生效。\n`)
      process.stdout.write(`以后只要说"${result.skill}"这个流程相关的话，就按这套干。\n`)
    }
  } else {
    process.stdout.write(`${lines.join('\n')}\n`)
    process.stderr.write(`\n❌ 没做成：${result.error}\n`)
    if (result.plan) process.stderr.write(`\n修复计划：${result.plan}\n`)
  }

  if (!result.ok) process.exit(/校验|缺少|不合语法|不一致|frontmatter|找不到技能/.test(result.error) ? 1 : 2)
  process.exit(0)
}

const isMain = !!process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))
if (isMain) main()
