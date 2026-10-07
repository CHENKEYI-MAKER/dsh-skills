# 公司资料技能库

把公司的工作流程（SOP）做成 DSH 技能，让每个员工的 AI 助手都会按公司的做法办事。
员工**装一次**，以后你往这个仓库里加技能，他们更新一下就同步到了。

- 安装（员工侧，一条命令）：
  ```sh
  dsh plugin --profile web add github:CHENKEYI-MAKER/dsh-company-skills
  ```
- 更新（你加了新 SOP 之后）：
  ```sh
  dsh plugin --profile web update dsh-company-skills
  ```

---

## 一、这个仓库长什么样

```
dsh-company-skills/
├── package.json              # 声明 dsh.bundle，让 DSH 认识这个包
├── cordis.patch.yml          # 3 行，把 skills/ 目录注册进 DSH 的技能发现
├── skills/                   # ★ 所有技能都在这里，一个 SOP 一个目录
│   ├── expense-report/
│   │   ├── SKILL.md          # 必须叫这个名字，且必须有 frontmatter
│   │   └── references/       # 可选：按需加载的参考资料
│   │       └── limits.md
│   ├── customer-info-registration/
│   │   └── SKILL.md
│   └── deploy-dsh-team-server/
│       └── SKILL.md
├── templates/
│   └── skill-template.md     # 新技能从这复制
└── tools/
    └── validate.mjs          # 校验器：npm run check
```

**核心概念**：技能 = 一个目录 + 里面的 `SKILL.md`。
DSH 启动时扫描技能目录，读到每个技能的 `name` 和 `description`；
只有当模型判断某条描述匹配当前任务时，才会加载那个技能的正文。

> 所以 `description` 是**唯一**决定"技能会不会被用上"的东西 —— 它每次都进上下文，
> 而正文只在被选中时才进。把力气花在 description 上。

---

## 二、写一个新技能

### 1. 建目录

目录名就是技能名，只能小写字母、数字、连字符：

```sh
mkdir -p skills/leave-request
cp templates/skill-template.md skills/leave-request/SKILL.md
```

### 2. 填 frontmatter（最关键的一步）

```yaml
---
name: leave-request
description: 提交请假申请并同步考勤。当员工要请假、调休、补卡或询问还有几天年假时使用，不适用于出差申请。
whenToUse: 用户说要请假、调休、年假、病假、补卡时使用。
metadata:
  author: 你的名字
  version: "0.1.0"
---
```

`description` 必须回答三个问题：

| 问题 | 反面例子 | 正面例子 |
| --- | --- | --- |
| 做什么？ | 「请假流程」 | 「提交请假申请并同步考勤」 |
| 什么时候用？ | （没写） | 「当员工要请假、调休时使用」 |
| 什么时候**不**用？ | （没写） | 「不适用于出差申请」 |

第三问最常被漏掉，也是避免"两个技能互相抢触发"的唯一办法。

### 3. 写正文：给 AI 执行的指令，不是给人看的制度

正文里要有的东西，按重要性排序：

1. **步骤** —— 能写成命令就写命令，能写成检查清单就写清单
2. **判断分支** —— "如果 A 就 X，如果 B 就 Y"，这是 AI 最容易做错的地方
3. **前置信息从哪拿** —— 拿不到时是追问还是停下
4. **常见错误** —— 把踩过的坑写进去，一条顶十条提醒
5. **完成检查清单** —— 让它自己核对

正文里**不要**塞长篇参考资料。举例：报销限额表跟绝大多数报销无关，
所以它放在 `references/limits.md`，正文里只写"接近或超过限额时必须先读它"。
这就是"按需加载"的正确用法 —— 省的是每次会话的上下文。

### 4. 提交前跑校验

```sh
npm run check
```

校验器会检查（零第三方依赖，只用 node 内置模块）：

**格式类（错了 DSH 会静默忽略这个技能，非常难查）**
- 每个技能目录有 `SKILL.md`，且有完整 frontmatter
- `name` 符合语法、全库唯一、与目录名一致
- `description` / `whenToUse` 存在，字数在 12~160 之间
- 正文不为空、不是只剩标题

**能不能被用上（这才是技能多起来之后真正会崩的地方）**
- `description` 里没有"当/需要/用于…"这类触发线索 → 报错
- 两个技能的 `description` 重合度 ≥35% → 报错（它们会互相抢触发，模型随机挑一个）
- 20%~35% → 警告，提醒确认边界

---

## 三、治理规矩（重要）

### 分三层，不要混在一起

| 层 | 放哪 | 谁维护 | 建议数量 |
| --- | --- | --- | --- |
| 公司级 SOP | 本仓库 | 指定审核人 | 20~40 个，多了没人看 |
| 部门级 | 本仓库 `skills/` 下按部门加前缀，如 `hr-leave-request` | 部门负责人 | 每部门几个 |
| 个人草稿 | 各人自己电脑的 `~/.dsh/skills/` | 写的人自己 | 不限 |

个人想把自己的经验升级成公司级，走一个 PR —— 顺手解决了"谁写的、谁维护"。

### 每个技能必须有一个维护人

写在 `metadata.author` 里。**没有维护人的 SOP 三个月后一定是错的**，
而且错得很隐蔽：AI 会一本正经地按过期流程办事。

### 一条红线：公开仓库里只放流程，不放数据

本仓库如果是公开的，**禁止**出现：客户名单、员工姓名与电话、报价与成本、
账号口令、服务器 IP。需要举例时用占位值（如 `[限额]`、`[姓名]`）。
参考资料要放真实数据，就走私有仓库或公司内网。

---

## 四、给管理层看的：为什么值得做

- **新人的上手成本**：师傅带三个月才能干的活，写清楚就是技能，AI 随时能照着做
- **执行一致性**：114 个人问同一个流程，得到的是同一套做法，不再靠口口相传
- **知识不再锁在个人脑子里**：写下来就是公司资产，人走了流程还在
- **改动有痕迹**：谁改的、谁审的、什么时候生效，git 记录全都在

---

## 五、技术说明（给维护这个仓库的人）

DSH 的技能发现只认**机器上的目录**，没有"上传到平台全员可见"的机制。
所以组织级技能库的唯一可行做法是：把技能随一个插件包发出去。

`cordis.patch.yml` 做的就是这件事 —— 把本包的 `skills/` 目录注册进
`skill-filesystem` 的 `customSkillDirs`：

```yaml
- id: skill-filesystem
  config:
    customSkillDirs:
      - !!js >-
        ...createRequire(baseUrl).resolve('dsh-company-skills/package.json').../skills
```

用 `createRequire` 反查路径，是为了让它在 pnpm 的哈希目录结构下也能找到自己
（官方包 `@deepseek-ai/dsh-agent-preset` 用的是同一手法）。

技能目录优先级（DSH 内部，数字越小越优先）：

| 优先级 | 位置 |
| --- | --- |
| 100 | `<项目>/.dsh/skills/` |
| 200 | `<项目>/.agents/skills/` |
| 300 | 插件挂载的 `customSkillDirs` ← **本仓库在这里** |
| 400 | `~/.dsh/skills/` |
| 500 | `~/.agents/skills/` |
| 600 | 随 DSH 分发的内置技能 |

同名的技能，优先级高的覆盖优先级低的。所以员工的个人技能可以覆盖公司技能 ——
这是对的：公司给默认做法，个人可以有自己的变体。
