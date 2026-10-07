---
name: deploy-dsh-team-server
description: 把 DSH 团队版部署或升级到服务器并完成上线自检。当需要首次部署、更新代码或排查服务未启动时使用。
whenToUse: 用户说要部署、上线、更新服务器上的 DSH 团队版，或者后台打不开 / 服务没起来时使用。
metadata:
  author: 陈炯
  version: "0.1.0"
---

# DSH 团队版部署到服务器

> 本技能是**真实流程**（来自本项目的实际部署记录），可作为"操作类技能"的范本：
> 命令是能直接跑的，关键处写了"为什么"，并明确标出了危险的坑。
>
> **占位值约定**（真实地址、路径、域名不写进公开技能里，执行时从现场取）：
>
> | 占位值 | 含义 | 现场取值方式 |
> | --- | --- | --- |
> | `<HOST>` | 服务器地址 | 问一次记下来，或读项目里的部署文档 |
> | `<SRC_DIR>` | 本地代码目录 | 当前工作目录的绝对路径 |
> | `<DEPLOY_DIR>` | 服务器上用于接收发布的目录 | 默认 `<DEPLOY_DIR>=/root/<项目名>` |
> | `<RUN_DIR>` | 服务实际运行目录（**不是** `<DEPLOY_DIR>`） | `systemctl show <服务名> -p WorkingDirectory` |
> | `<PORT>` | 服务监听端口 | `Environment=TEAM_BIND_PORT` 或 `ss -lntp` |
> | `<SERVICE>` | systemd 服务名 | `systemctl list-units --type=service | grep -i dsh` |

## 触发条件

- 需要把 `<DEPLOY_DIR>` 的代码发布到服务器、重启服务、并确认看板可用时加载本技能
- 用户会这么说：「部署一下」「上线」「更新服务器」「后台打不开了」「服务是不是挂了」
- **不适用**：
  - 修改业务代码本身 → 那是开发，不是部署
  - 配置 DNS 或证书 → 一次性动作，见部署文档

## 步骤

0. **前置确认**（不通过就不要往下走）
   - 输入：本地仓库
   - 做什么：① `ssh root@<HOST>` 免密可用；② 本地 `npm run verify` 全绿（EXIT=0）
   - 产出：可部署的确认

1. **同步代码到服务器**（在本地执行）
   - 做什么：
     ```sh
     rsync -az --delete --exclude node_modules --exclude .git \
       <SRC_DIR>/ root@<HOST>:<DEPLOY_DIR>/
     ```
   - 产出：服务器 `<DEPLOY_DIR>` 是最新代码

2. **发布到运行目录**（在服务器执行）
   - 做什么：
     ```sh
     bash <DEPLOY_DIR>/deploy/01-install.sh --force
     ```
   - 产出：`<RUN_DIR>` 已更新，并留下一个回滚点 `<RUN_DIR>.prev.<时间戳>`

3. **确认服务起来了**
   - 做什么：
     ```sh
     systemctl status <SERVICE> --no-pager
     ss -lntp | grep <PORT>                                  # 期望只监听 127.0.0.1:<PORT>
     curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<PORT>/   # 期望 200
     ```
   - 产出：服务 active、端口正确、本机 200

4. **自检数据完整性**
   - 做什么：
     ```sh
     systemctl show <SERVICE> -p ExecMainStatus   # 期望 0
     journalctl -u <SERVICE> -n 30 --no-pager | grep -E '自检|员工|账号|设备|事件'
     ```
   - 产出：`自检 ✓` 且员工/账号数符合预期

5. **公网验收**
   - 做什么：浏览器打开看板域名，用管理员账号登录，确认概览数字与第 4 步一致
   - 产出：可对外使用的确认

6. **清理旧回滚点**（确认新版稳定运行后再做，只保留最近一个）
   - 做什么：
     ```sh
     ls -d <RUN_DIR>.prev.* | head -n -1 | xargs -r rm -rf
     ```
   - 产出：只留一个回滚点

**判断分支**

| 情况 | 怎么做 |
| --- | --- |
| `systemctl status` 是 failed | `journalctl -u <SERVICE> -n 80 --no-pager` 看真实报错，多半是权限或数据库路径 |
| 端口不对或监听在 0.0.0.0 | 检查环境文件里的 `TEAM_BIND_PORT`，**不要**为了省事让它监听公网 |
| 公网 502 / 打不开 | 先确认本机 `curl 127.0.0.1:<PORT>` 通；通了说明是 Nginx 或证书问题，不是应用问题 |
| 改了口令却发现没生效 | 口令存在两处：库里的 `admins.password_hash` 和 `/etc/<服务名>/team.env`。后者**只在空库首次启动时**被读走 ⇒ 必须用 `reset-password.mjs --sync-env` 同时改两边 |

## 坑

- ❌ 只改 `<DEPLOY_DIR>` 就重启服务 → ✅ 必须先跑 `01-install.sh --force` 发布到 `<RUN_DIR>`
  （原因：**服务实际跑的是 `<RUN_DIR>`**，不发布等于没改。这是最容易白忙一场的坑）
- ❌ 本地跑测试写成 `node --test packages/server/test` → ✅ 用 `npm run verify`，或 `node --test "packages/server/test/*.test.mjs"`
  （原因：Node 25 下传目录会失败）
- ❌ 用 `pkill -f "packages/server/src/index.js"` 清理进程 → ✅ 先 `ps` 确认 PID 再 `kill`
  （原因：模式太宽会误杀常驻服务）
- ⚠️ **接收发布的目录常对服务账号不可读**（`Permission denied`）。要以服务身份跑脚本，必须用已发布、权限放开的 `<RUN_DIR>`
- ⚠️ 部分精简服务器上**没有 `timeout` 命令**；macOS 的 `pgrep` 不支持 `-c`，要用 `pgrep -f ... | wc -l`

## 验收标准

- [ ] `npm run verify` 在本地 EXIT=0
- [ ] 已 rsync 到 `<DEPLOY_DIR>`
- [ ] 已跑 `deploy/01-install.sh --force` 发布到 `<RUN_DIR>`
- [ ] `systemctl show <SERVICE> -p ExecMainStatus` = 0
- [ ] 只监听 `127.0.0.1:<PORT>`（不是 `0.0.0.0`）
- [ ] 公网能登录，且概览数字与自检一致
- [ ] 旧回滚点已清理，只剩最近一个
