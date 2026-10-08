// tools/sensitive-scan.mjs 的测试。
//
// 运行： node --test "tools/test/*.test.mjs"   （Node 25 下必须用引号包 glob）
//
// ⚠️ 本文件里**全部是合成值**：RFC 5737 的文档专用 IP 段（203.0.113.x）、
// 随机拼的假密钥、示例公司名。绝不使用真实公司 / 真实 IP / 真实凭据 ——
// 否则测试文件自己就成了泄密源。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { scanSensitive, scanFiles, DEFAULT_RULES } from '../sensitive-scan.mjs'

// ── 合成样本（全部为假值） ────────────────────────────────────
const FAKE_IP = '203.0.113.7' // RFC 5737 文档专用段
const FAKE_IP2 = '198.51.100.42' // RFC 5737 文档专用段
const FAKE_COMPANY = '温州示例科技有限公司'
const FAKE_COMPANY2 = '示例集团'
const FAKE_DOMAIN = 'dsh.example-corp.cn'
const FAKE_PATH = '/Users/someone/Desktop/project'
const FAKE_PATH2 = '/home/someone/work'
const FAKE_ROOT = '/root/deploy-app'
const FAKE_SK = 'sk-Abc123Def456Ghi789Jkl012' // 28 位，非真实
const FAKE_GHP = 'ghp_Abc123Def456Ghi789Jkl012Mno'
const FAKE_AWS = 'AKIAIOSFODNN7EXAMPLE' // AWS 官方文档里的示例串
const FAKE_SLACK = 'xoxb-123456789012-abcdefghijkl'
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'
const FAKE_MOBILE = '13912345678'
const FAKE_ID = '11010119900307123X'
const FAKE_MAIL = 'zhangsan@example.com'

/** 只取某个规则 / 某些规则的命中 */
const hitsOf = (text, ruleId) =>
  scanSensitive(text).hits.filter((h) => (ruleId ? h.rule === ruleId : true))
const rulesOf = (text) => scanSensitive(text).hits.map((h) => h.rule)

describe('DEFAULT_RULES 形状', () => {
  test('每条规则都有 id / severity / re / message，且 id 唯一', () => {
    assert.ok(DEFAULT_RULES.length >= 9, `规则数应 ≥ 9，实际 ${DEFAULT_RULES.length}`) // #1
    const ids = new Set()
    for (const rule of DEFAULT_RULES) {
      assert.equal(typeof rule.id, 'string', `规则缺 id：${JSON.stringify(rule)}`) // #2
      assert.ok(['problem', 'warn'].includes(rule.severity), `${rule.id} severity 非法`) // #3
      assert.ok(rule.re instanceof RegExp, `${rule.id} 的 re 不是正则`) // #4
      assert.ok(rule.message.length > 4, `${rule.id} 的 message 太短`) // #5
      assert.ok(!ids.has(rule.id), `规则 id 重复：${rule.id}`) // #6
      ids.add(rule.id)
    }
  })

  test('预期的 9 条规则 id 齐全', () => {
    assert.deepEqual(
      DEFAULT_RULES.map((r) => r.id).sort(),
      [
        'api-key-shape',
        'cn-id-card',
        'cn-mobile',
        'credential-assignment',
        'email-address',
        'local-abs-path',
        'public-ip',
        'real-company-name',
        'real-domain',
      ],
    ) // #7
  })

  test('problem/warn 分级符合约定', () => {
    const byId = Object.fromEntries(DEFAULT_RULES.map((r) => [r.id, r.severity]))
    assert.equal(byId['public-ip'], 'problem') // #7
    assert.equal(byId['api-key-shape'], 'problem') // #8
    assert.equal(byId['local-abs-path'], 'problem') // #9
    assert.equal(byId['credential-assignment'], 'problem') // #10
    assert.equal(byId['cn-mobile'], 'problem') // #11
    assert.equal(byId['cn-id-card'], 'problem') // #12
    assert.equal(byId['real-company-name'], 'warn') // #13
    assert.equal(byId['email-address'], 'warn') // #14
    assert.equal(byId['real-domain'], 'warn') // #15
  })
})

describe('正例：每条规则都能命中合成值', () => {
  test('public-ip 命中公网 IP，severity=problem', () => {
    const hits = hitsOf(`服务器地址是 ${FAKE_IP}，请记下来`, 'public-ip')
    assert.equal(hits.length, 1) // #16
    assert.equal(hits[0].severity, 'problem') // #17
    assert.equal(scanSensitive(`host: ${FAKE_IP2}`).counts.problem >= 1, true) // #18
  })

  test('local-abs-path 命中 macOS / Linux 本机路径', () => {
    assert.equal(hitsOf(`同步 ${FAKE_PATH} 到服务器`, 'local-abs-path').length, 1) // #19
    assert.equal(hitsOf(`linux 上放在 ${FAKE_PATH2}`, 'local-abs-path').length, 1) // #20
    assert.equal(hitsOf(`服务跑在 ${FAKE_ROOT} 下`, 'local-abs-path').length, 1) // #21
  })

  test('api-key-shape 命中各家的密钥形状', () => {
    assert.equal(hitsOf(`OPENAI_APIKEY=${FAKE_SK}`, 'api-key-shape').length, 1) // #22
    assert.equal(hitsOf(`token: ${FAKE_GHP}`, 'api-key-shape').length, 1) // #23
    assert.equal(hitsOf(`aws_key ${FAKE_AWS}`, 'api-key-shape').length, 1) // #24
    assert.equal(hitsOf(`slack ${FAKE_SLACK}`, 'api-key-shape').length, 1) // #25
    assert.equal(hitsOf(`jwt ${FAKE_JWT}`, 'api-key-shape').length, 1) // #26
  })

  test('credential-assignment 命中"凭据 = 真值"', () => {
    assert.equal(hitsOf('password: hunter2secret', 'credential-assignment').length, 1) // #27
    assert.equal(hitsOf('密码：wodemima1234', 'credential-assignment').length, 1) // #28
    assert.equal(hitsOf('api_key = "abcdef123456"', 'credential-assignment').length, 1) // #29
    assert.equal(hitsOf('token: `zzzzzzzz9999`', 'credential-assignment').length, 1) // #30
  })

  test('cn-mobile 命中 11 位手机号', () => {
    assert.equal(hitsOf(`联系人电话 ${FAKE_MOBILE}`, 'cn-mobile').length, 1) // #31
    assert.equal(scanSensitive(`电话：${FAKE_MOBILE}`).counts.problem, 1) // #32
  })

  test('cn-id-card 命中 18 位身份证', () => {
    assert.equal(hitsOf(`身份证 ${FAKE_ID}`, 'cn-id-card').length, 1) // #33
  })

  test('real-company-name 命中中文公司全称（warn）', () => {
    const hits = hitsOf(`合同抬头是 ${FAKE_COMPANY}`, 'real-company-name')
    assert.equal(hits.length, 1) // #34
    assert.equal(hits[0].severity, 'warn') // #35
    assert.equal(hitsOf(`母公司 ${FAKE_COMPANY2} 下属`, 'real-company-name').length, 1) // #36
  })

  test('email-address 命中邮箱（warn）', () => {
    const hits = hitsOf(`发到 ${FAKE_MAIL}`, 'email-address')
    assert.equal(hits.length, 1) // #37
    assert.equal(hits[0].severity, 'warn') // #38
  })

  test('real-domain 命中白名单之外的真实域名（warn）', () => {
    const hits = hitsOf(`看板域名 ${FAKE_DOMAIN}`, 'real-domain')
    assert.equal(hits.length, 1) // #39
    assert.equal(hits[0].severity, 'warn') // #40
    assert.equal(hits[0].excerpt, 'dsh.****.cn') // #41
  })
})

describe('负例：占位符与豁免形态不该命中', () => {
  test('尖括号占位符全部豁免', () => {
    for (const s of ['<HOST>', '<SRC_DIR>', '<DEPLOY_DIR>', '<RUN_DIR>', '<PORT>', '<SERVICE>', '<服务名>']) {
      assert.equal(scanSensitive(`ssh root@${s}`).hits.length, 0, `${s} 应被豁免`) // #42-49
    }
  })

  test('方括号占位符全部豁免', () => {
    assert.equal(scanSensitive('单笔超过 [限额] 元要审批').hits.length, 0) // #43
    assert.equal(scanSensitive('客户名写 [客户名]').hits.length, 0) // #44
    assert.equal(scanSensitive('跟进人 [员工名]').hits.length, 0) // #45
  })

  test('连续打码豁免，但真值不豁免', () => {
    assert.equal(scanSensitive('password: ******').hits.length, 0) // #46
    assert.equal(scanSensitive('密码: xxxxxxxx').hits.length, 0) // #47
    assert.equal(scanSensitive('token: XXXXXX').hits.length, 0) // #48
    assert.equal(scanSensitive('password: hunter2').hits.length, 1) // #49 真值仍然要抓
  })

  test('明确的无值标记豁免', () => {
    for (const s of ['password: TBD', 'token: TODO', 'secret: CHANGEME', '密码：your-password-here']) {
      assert.equal(scanSensitive(s).hits.length, 0, `${s} 应被豁免`) // #50-60
    }
    assert.equal(scanSensitive('password:（无）').hits.length, 0) // #51
  })

  test('凭据值太短或只是占位词时不算命中', () => {
    assert.equal(scanSensitive('password: abc').hits.length, 0) // #52 长度 < 6
    assert.equal(scanSensitive('Secret: none').hits.length, 0) // #53
  })
})

describe('负例：私有 / 特殊 IP 不算公网 IP', () => {
  test('内网、回环、链路本地、0.x、广播地址都不命中', () => {
    const specials = ['10.0.0.5', '192.168.1.1', '127.0.0.1', '172.20.3.4', '169.254.1.1', '0.0.0.0', '255.255.255.255']
    for (const ip of specials) {
      assert.equal(hitsOf(`监听 ${ip}`, 'public-ip').length, 0, `${ip} 不该被判为公网 IP`) // #54-70
    }
    assert.equal(scanSensitive('127.0.0.1 是回环地址').hits.length, 0) // #55
    assert.equal(scanSensitive('curl http://127.0.0.1:<PORT>/').hits.length, 0) // #56
  })

  test('172.16–172.31 是私有段，172.15 / 172.32 不是', () => {
    assert.equal(hitsOf('172.16.0.1', 'public-ip').length, 0) // #57
    assert.equal(hitsOf('172.31.255.254', 'public-ip').length, 0) // #58
    assert.equal(hitsOf('172.15.0.1', 'public-ip').length, 1) // #59
    assert.equal(hitsOf('172.32.0.1', 'public-ip').length, 1) // #60
  })
})

describe('负例：公共域名白名单', () => {
  test('白名单域名不算 real-domain', () => {
    for (const d of ['github.com', 'npmjs.com', 'nodejs.org', 'deepseek.com', 'example.com', 'example.org', 'localhost']) {
      assert.equal(hitsOf(`见 https://${d}/x`, 'real-domain').length, 0, `${d} 在白名单里`) // #61-82
    }
  })

  test('*.example.* 通配白名单', () => {
    assert.equal(hitsOf('foo.example.com', 'real-domain').length, 0) // #62
    assert.equal(hitsOf('bar.example.net', 'real-domain').length, 0) // #63
    assert.equal(hitsOf('example-corp.example.com', 'real-domain').length, 0) // #64
  })

  test('白名单外的域名照抓', () => {
    assert.equal(hitsOf('dsh.example-corp.cn', 'real-domain').length, 1) // #65
    assert.equal(hitsOf('panel.example-corp.online', 'real-domain').length, 1) // #66
  })
})

describe('excerpt 脱敏', () => {
  test('IP 保留首尾段', () => {
    const [hit] = hitsOf(`服务器 ${FAKE_IP}`, 'public-ip')
    assert.equal(hit.excerpt, '203.***.***.7') // #67
    assert.ok(!hit.excerpt.includes(FAKE_IP), 'IP 原文不能出现在 excerpt 里') // #68
  })

  test('密钥只留前 4 字符 + 长度', () => {
    const [hit] = hitsOf(`key ${FAKE_SK}`, 'api-key-shape')
    assert.equal(hit.excerpt, `sk-A…(${FAKE_SK.length} 字符)`) // #69
    assert.ok(!hit.excerpt.includes(FAKE_SK.slice(4)), '密钥其余字符不能出现') // #70
  })

  test('域名保留第一段和 TLD', () => {
    const [hit] = hitsOf(`域名 ${FAKE_DOMAIN}`, 'real-domain')
    assert.equal(hit.excerpt, 'dsh.****.cn') // #71
  })

  test('本机路径打码用户名', () => {
    const [hit] = hitsOf(`路径 ${FAKE_PATH}`, 'local-abs-path')
    assert.equal(hit.excerpt, '/Users/***/Desktop/project') // #72
    assert.ok(!hit.excerpt.includes('someone'), '用户名不能出现在 excerpt 里') // #73
  })

  test('/root/ 路径只留根', () => {
    const [hit] = hitsOf(`路径 ${FAKE_ROOT}`, 'local-abs-path')
    assert.equal(hit.excerpt, '/root/***') // #74
  })

  test('中文企业全称保留前 2 字 + …', () => {
    const [hit] = hitsOf(`抬头 ${FAKE_COMPANY}`, 'real-company-name')
    assert.equal(hit.excerpt, '温州…') // #75
  })

  test('手机号中间打码', () => {
    const [hit] = hitsOf(`电话 ${FAKE_MOBILE}`, 'cn-mobile')
    assert.equal(hit.excerpt, '139****5678') // #76
  })

  test('身份证中间打码', () => {
    const [hit] = hitsOf(`证件 ${FAKE_ID}`, 'cn-id-card')
    assert.equal(hit.excerpt, '110****X') // #77
    assert.ok(!hit.excerpt.includes('19900307'), '身份证中间段不能出现') // #78
  })

  test('邮箱打码本地部分', () => {
    const [hit] = hitsOf(`邮箱 ${FAKE_MAIL}`, 'email-address')
    assert.equal(hit.excerpt, '***@example.com') // #79
  })

  test('所有命中片段的长度都短于原值（没有完整回显）', () => {
    const text = [FAKE_IP, FAKE_SK, FAKE_PATH, FAKE_COMPANY, FAKE_MOBILE, FAKE_ID, FAKE_MAIL, FAKE_DOMAIN].join('\n')
    const { hits } = scanSensitive(text)
    assert.ok(hits.length >= 8, `应至少 8 个命中，实际 ${hits.length}`) // #80
    for (const h of hits) {
      assert.ok(!h.excerpt.includes(FAKE_IP), `excerpt 回显了 IP：${h.excerpt}`) // #81
      assert.ok(!h.excerpt.includes('someone'), `excerpt 回显了用户名：${h.excerpt}`) // #82
      assert.ok(!h.excerpt.includes(FAKE_MOBILE), `excerpt 回显了手机号：${h.excerpt}`) // #83
    }
  })
})

describe('行号 / 列号', () => {
  test('命中在第 5 行就报 5', () => {
    const text = ['第一行', '第二行', '第三行', '第四行', `第五行有 ${FAKE_IP}`].join('\n')
    const hits = hitsOf(text, 'public-ip')
    assert.equal(hits.length, 1) // #84
    assert.equal(hits[0].line, 5) // #85
    assert.equal(hits[0].column, '第五行有 '.length + 1) // #86
  })

  test('列号是 1-based，命中在行首时列为 1', () => {
    const text = ['第一行', `${FAKE_IP} 在行首`].join('\n')
    const [hit] = hitsOf(text, 'public-ip')
    assert.equal(hit.line, 2) // #87
    assert.equal(hit.column, 1) // #88
  })

  test('同一行多个命中各自的列号不同', () => {
    const text = `${FAKE_IP} 和 ${FAKE_IP2}`
    const hits = hitsOf(text, 'public-ip')
    assert.equal(hits.length, 2) // #89
    assert.notEqual(hits[0].column, hits[1].column) // #90
  })

  test('多行文本的行号随内容递增', () => {
    const text = ['a', 'b', `c ${FAKE_PATH}`, 'd', 'e', `f ${FAKE_PATH2}`].join('\n')
    const hits = hitsOf(text, 'local-abs-path')
    assert.deepEqual(hits.map((h) => h.line), [3, 6]) // #91
  })
})

describe('返回结构与 counts', () => {
  test('counts 只统计 problem / warn 两类', () => {
    const text = [`${FAKE_IP}`, FAKE_COMPANY, FAKE_MAIL, 'password: hunter2secret'].join('\n')
    const { counts, hits } = scanSensitive(text)
    assert.deepEqual(Object.keys(counts).sort(), ['problem', 'warn']) // #92
    assert.equal(counts.problem, hits.filter((h) => h.severity === 'problem').length) // #93
    assert.equal(counts.warn, hits.filter((h) => h.severity === 'warn').length) // #94
    assert.ok(counts.problem >= 2) // #95
    assert.ok(counts.warn >= 2) // #96
  })

  test('干净文本返回空命中', () => {
    const { hits, counts } = scanSensitive('# 标题\n\n这是一段正常的中文说明，没有任何敏感信息。')
    assert.deepEqual(hits, []) // #97
    assert.deepEqual(counts, { problem: 0, warn: 0 }) // #98
  })

  test('空输入 / 非字符串不抛异常', () => {
    assert.deepEqual(scanSensitive('').hits, []) // #99
    assert.deepEqual(scanSensitive(undefined).hits, []) // #100
    assert.deepEqual(scanSensitive(null).counts, { problem: 0, warn: 0 }) // #101
  })

  test('每个命中都带完整的字段', () => {
    const { hits } = scanSensitive(`服务器 ${FAKE_IP}`)
    const [hit] = hits
    assert.deepEqual(Object.keys(hit).sort(), ['column', 'excerpt', 'line', 'message', 'rule', 'severity']) // #102
    assert.equal(hit.rule, 'public-ip') // #103
    assert.equal(typeof hit.line, 'number') // #104
    assert.equal(typeof hit.column, 'number') // #105
    assert.match(hit.message, /公网 IP/) // #106
  })

  test('传入 file 时命中带 file 字段', () => {
    const { hits } = scanSensitive(`x ${FAKE_IP}`, { file: 'skills/demo/SKILL.md' })
    assert.equal(hits[0].file, 'skills/demo/SKILL.md') // #107
  })

  test('可以只跑部分规则（rules 覆盖）', () => {
    const onlyIp = DEFAULT_RULES.filter((r) => r.id === 'public-ip')
    const { hits } = scanSensitive(`${FAKE_IP} ${FAKE_COMPANY}`, { rules: onlyIp })
    assert.equal(hits.length, 1) // #108
    assert.equal(hits[0].rule, 'public-ip') // #109
  })
})

describe('scanFiles', () => {
  test('按文件聚合命中并给出 totals', () => {
    const { files, totals } = scanFiles([
      { path: 'skills/a/SKILL.md', content: `地址 ${FAKE_IP}` },
      { path: 'skills/a/references/x.md', content: `抬头 ${FAKE_COMPANY}` },
      { path: 'skills/b/SKILL.md', content: '干净内容，无敏感信息。' },
    ])
    assert.equal(files.length, 3) // #110
    assert.equal(files[0].path, 'skills/a/SKILL.md') // #111
    assert.equal(files[0].counts.problem, 1) // #112
    assert.equal(files[1].counts.warn, 1) // #113
    assert.equal(files[2].hits.length, 0) // #114
    assert.deepEqual(totals, { problem: 1, warn: 1 }) // #115
  })

  test('空数组 / 缺字段不抛异常', () => {
    assert.deepEqual(scanFiles([]).totals, { problem: 0, warn: 0 }) // #116
    assert.deepEqual(scanFiles().totals, { problem: 0, warn: 0 }) // #117
    assert.deepEqual(scanFiles([{}]).totals, { problem: 0, warn: 0 }) // #118
  })
})

describe('负例：正常文档内容不该被误判', () => {
  test('常见技能写法零命中', () => {
    const doc = [
      '---',
      'name: demo-skill',
      'description: 示例技能。当需要演示时使用。',
      'metadata:',
      '  version: "0.1.0"',
      '---',
      '',
      '## 步骤',
      '',
      '1. 运行 `node tools/validate.mjs`',
      '2. 读 `references/limits.md`',
      '3. 单笔超过 [限额] 元时先读 `templates/expense.xlsx`',
      '4. 监听 127.0.0.1:<PORT>，不要监听 0.0.0.0',
      '5. 参考 https://github.com/nodejs/node 与 https://example.com/doc',
      '6. 提交前跑 npm run verify（EXIT=0）',
      '',
      '## 坑',
      '',
      '- ❌ 把口令写成真实值 → ✅ 写成 <TOKEN> 或 TBD',
    ].join('\n')
    const { hits } = scanSensitive(doc)
    assert.deepEqual(
      hits.map((h) => `${h.rule}@${h.line}`),
      [],
    ) // #140
    assert.deepEqual(scanSensitive(doc).counts, { problem: 0, warn: 0 }) // #119
  })
})
