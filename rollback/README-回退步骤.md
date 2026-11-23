# 回退到 6654ea8（无 Google 授权时代）步骤说明

> **⚠️ 历史参考说明（请先读）**
> 本文档撰写时，"当前系统"是 **Google 教师登录 + Cloudflare Worker + App Check + 紧急直连通道** 架构。
> 该架构已经通过回退提交 `910c730` 回退，**当前线上运行的是"静态页面 + 浏览器直连 Firebase RTDB（`class-optic`）+ 管理口令"模式，不含 Worker / App Check / Google 教师登录**。
> 因此，本文档描述的回退动作实际上**已经完成**；`rollback/6654ea8/` 仅作为历史快照与参考资料保留，不代表当前架构。
> 若将来仍需回退或恢复，请注意：旧版 `database.rules.json` 采用宽松规则（`years` 匿名整写、缺少 `studentHours` / `feeVault` / `feeVaultDeletedAt` 等节点校验），**不应直接覆盖当前已收紧的规则**，否则会重新放开匿名写入并可能阻断课时费同步。
>
> 目的（历史语境）：原"当前系统"若出现无法修复的问题，可一键回退到 `6654ea8`（密码登录教师端、无 Google 授权、无 Worker、规则宽松）的旧版系统。
> **数据完全兼容**（两个版本都使用 `years/$year` 树状结构），回退不丢任何预约/课时费数据。

---

## 一、回退前置：生成回退数据包（在**当前**系统里做）

1. 教师登录当前后台（Google 登录）→ 数据管理 → **「生成 6654 回退包」**
2. 会下载两个文件：
   - `回退备份_全量_<日期>.json` —— 当前全部数据快照（含 Google 时代节点，**保留以防万一**，可用于还原当前版本）
   - `回退数据_6654修剪版_<日期>.json` —— 已移除 `teacherAllowlist / emergencyBookingRequests / emergencySlotClaims / emergencyCancelRequests / emergencyExamSessions / examDefinitions / privateRuntime / studentWhitelistIndex / reservationTombstones`，可直接用于旧版

## 二、部署旧版代码（GitHub Pages）

把本目录（`rollback/6654ea8/`）下的全部文件上传覆盖到 GitHub Pages 对应位置：
`index.html / app.js / style.css / admin.html / admin.js / admin.css / money.html / money.css / exam_student.html / exam_student.js / exam_teacher.html / exam_teacher.js / config/firebase-env.js / utils/time-parser.js`

> 旧版 `config/firebase-env.js` 里的 `apiKey / databaseURL` 与当前相同（同一 Firebase 项目），无需修改。

## 三、发布旧版规则

Firebase 控制台 → Realtime Database → 规则 → 全选替换为 **`database.rules.json`**（本目录内旧版）→ 发布。

旧版规则要点：`years` 公开读、`years/$year` 任意写（宽松）、教师端靠密码登录（`admin_auth` 节点）。

## 四、导入修剪版数据（可选，但推荐）

1. Firebase 控制台 → Realtime Database → 数据
2. 若数据库中还有 `teacherAllowlist / emergency* / examDefinitions / privateRuntime / studentWhitelistIndex / reservationTombstones` 节点 → 手动删除（修剪版数据不含它们）
3. 导入 `回退数据_6654修剪版_<日期>.json`（或直接点“导入 JSON”合并覆盖）

> 不导入也可以：旧版规则下这些多余节点无害（只是占空间）。导入修剪版是为了干净。

## 五、创建教师密码

旧版教师端是**密码登录**（不是 Google 登录）：

1. Firebase 控制台 → Realtime Database → 数据 → 根节点下创建：
   - 节点名：`admin_auth`
   - 子节点：`<你的密码>`，值：`true`
2. 打开教师端 → 输入该密码登录

> 密码即节点名，注意区分大小写；想改密码就删除旧节点重建。

## 六、验证

- 学生端：打开学生页 → 正常约课、查历史、取消（旧版直接读写数据库，无 Worker/App Check 依赖）
- 教师端：密码登录 → 排班、预约管理、课时费管家（money.html）正常
- 考试：旧版考试流程（提交锁 + 成绩排名）正常

## 七、回退后想回到新版？

用「回退备份_全量_<日期>.json」+ 当前版本代码/规则恢复即可（数据都在备份里）。

---

## 附：旧版与已废弃的 Google+Worker 版差异速览

> 下表的"Google+Worker 版"是曾短暂上线、现已通过 `910c730` 回退的架构。当前线上运行方式与左列"旧版 6654ea8"一致（口令登录、浏览器直连 RTDB、无 Worker）。

| 项 | 旧版 6654ea8（≈ 当前线上形态） | Google+Worker 版（已废弃） |
|---|---|---|
| 教师登录 | 密码（`admin_auth/<密码>=true`） | Google 账号（teacherAllowlist） |
| 学生预约 | 直连数据库（accessCode + 白名单 + 规则校验） | 直连应急通道（accessCode+白名单+时间窗规则） |
| Worker | 无 | Cloudflare Worker（App Check + 挑战） |
| 学生历史/取消 | 直连读/写 | 直连通道 + 本机记录兜底 |
| 安全强度 | 依赖规则校验（无独立身份会话） | 规则校验 + 服务端身份 |
| 大陆可用性 | 完全可用（无外部依赖） | 需处理 reCAPTCHA 不可达的降级路径 |
