---
name: dsh-skills
version: 0.1.0
maintainer: 陈炯
updated: 2026-10-07
---

# 技能清单（capabilities.md）

这个文件是**技能仓库的数字 DNA**：一份机器可读 + 人能扫的清单。

- 每入库一个技能，`tools/publish-skill.mjs` 会自动在这里加一行，并把 `version` +1
- 表格已按 `name` 字母序排列，不要手改顺序（脚本会重排）
- `VERSION` 文件与这里的 `version` 保持一致，代表**技能库整体版本**（不是单个技能的版本）

| name | 触发条件（一句话） | 维护人 | 版本 | 入库时间 |
| --- | --- | --- | --- | --- |
| customer-info-registration | 拿到新客户联系方式、要建档时 | 陈炯 | 0.1.0 | 2026-10-07 |
| deploy-dsh-team-server | 要部署、上线或排查服务没起来时 | 陈炯 | 0.1.0 | 2026-10-07 |
| expense-report | 要提交差旅、采购或招待费用报销时 | 陈炯 | 0.1.0 | 2026-10-07 |
| sop-to-skill | 把一段业务访谈整理成标准技能（SKILL.md）并写入技能目录 | 陈炯 | 0.1.1 | 2026-10-07 |
