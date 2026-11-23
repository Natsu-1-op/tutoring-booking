# TutorBooking

TutorBooking 为 1v1 辅导提供学生预约、教师排班和课时费管理。同一个站点也提供在线模拟考试及 839 题库。

## 运行架构

GitHub Pages 从公开仓库 `main` 分支的根目录直接发布静态文件。所有页面均在浏览器中运行，并通过 Firebase Web SDK 直连 Firebase 项目 `class-optic`（Authentication + Realtime Database，RTDB 区域为 `asia-southeast1`）。**当前架构不含 Cloudflare Worker、Firebase App Check、Cloud Functions，也不使用 Google 教师登录**；这些组件曾在历史提交中出现，已随回退提交 `910c730` 移除，仓库中不再保留引用。

题库使用 Firebase Authentication 的 **Email/Password（邮箱密码）** 登录，不提供 Google 登录。学生注册邮箱账号后兑换管理员发放的激活码解锁题库；旧的「内部链接」发放方式仍然可用，两条通道互不影响。数据库规则按管理员邮箱（`auth.token.email`）限制链接列表、激活码和发布配置的访问；管理员身份绑定邮箱而非 UID，删号重建只要邮箱不变，规则无需改动。预约后台、命题评卷和课时费管理入口沿用管理口令，由各页面读取 Realtime Database 的 `admin_auth` 验证（口令命中的节点值为 `true` 即放行）。学生预约使用姓名和班级口令，凭预约码查询或取消。

**题库用户与 1v1 约课学员是两套完全独立的名单**：题库账号存放在 `users/{uid}`，约课名单存放在 `years/{学年}/studentWhitelist`，互不写入、互不校验。

数据库规则现状：`questionBankAccess` 按管理员邮箱限制；`users/{uid}` 仅本人可读自己的访问字段，密钥只有在激活且未过期、未被停用时才可读；`activation_codes/{code}` 由管理员创建，兑换申请只能原子写入一次；`admin_auth` 根节点禁止读写、仅按口令读取；`examRankings`、`submittedExamLocks` 用于成绩排名与交卷锁。`years/{学年}` 下的业务节点（`slots`、`reservations`、`settings`、`studentWhitelist`、`studentHours`、`operationLog`、`metadata`、`dailyLocks`、`feeVault`、`feeVaultDeletedAt`）保留匿名读写以支持无感约课与课时费加密同步，未显式声明的子节点一律拒绝非空写入；管理页面的口令校验只控制界面入口。实际数据库权限以已发布规则为准。

## 页面与代码

| 页面与脚本 | 职责 |
| --- | --- |
| `index.html`、`app.js` | 学生预约入口。查看公告、排班，提交预约，查询、取消及导出日历。 |
| `admin.html`、`admin.js` | 教师工作台。管理学年、排班、学生名单、预约及日志，并进入评卷和课时费页面。 |
| `config/firebase-env.js`、`database.rules.json` | 前者初始化约课及考试的 Firebase 连接并提供按学年访问数据的路径。后者记录 Realtime Database 访问权限和数据校验。各管理页面的登录逻辑在对应脚本内。 |
| `question-bank/index.html`、`question-bank/access.js` | 839 题库学生端。核验账号权限或内部链接，在浏览器中解密并显示题目、公式和图片。 |
| `question-bank/account.js` | 题库邮箱注册、登录、找回密码、退出，以及激活码兑换与到期核验。题库用户档案写入 `users/{uid}`，与约课名单无关。 |
| `question-bank/study.js` | 题库个人做题记忆。已掌握 / 错题 / 收藏 / 笔记先写本机 `localStorage`，再防抖同步到 `users/{uid}/bankMemory`，换设备登录同一邮箱时按题逐条合并。 |
| `question-bank/ai-tutor.js` | 题库本地 BYOK 批改。接口地址、API Key、模型名只存本机，题目原页与学生作答直接发往学生自填的 OpenAI 兼容接口。 |
| `question-bank/manage/index.html`、`question-bank/manage/manage.js` | 题库管理员后台。生成/复制/停用内部链接；批量生成激活码、查看使用情况；查看题库用户并手动续期或停用。 |
| `exam_student.html`、`exam_student.js` | 导入学生卷、答题、交卷、下载答卷并查看复查包。Firebase 记录交卷状态和凭证，学生将下载的答卷 JSON 交给老师。 |
| `exam_teacher.html`、`exam_teacher.js` | 命题、导出母卷和学生卷、导入答卷、评卷以及导出复查包。成绩排名可写入 Firebase。启用 AI 或 OCR 时，相关答题内容会发送到所配置的接口。 |
| `money.html`、`money.css` | 课时费管家。预约入账、补录、对账、统计和备份。账本在浏览器用独立口令加密，再按学年同步到 Firebase，本机保留同步和恢复所需的副本。 |
| `utils/time-parser.js` | 时间解析工具，由 `index.html`、`admin.html`、`money.html` 引入，用于梳理排班时段与预约时间。 |

题库原稿和发布脚本维护在私有题库仓库。公开仓库的 `question-bank/content/` 用于发布学生版加密文件。

## 题库账号与激活码

**学生流程**：打开题库页 → 注册邮箱账号 → 输入管理员发放的激活码（格式 `XXXX-XXXX-XXXX`）→ 通过后立即解锁。到期或未激活时，页面只显示登录/激活界面，不加载任何题目内容。忘记密码通过「找回密码」发送 Firebase 重置邮件。

**数据结构**：

| 节点 | 内容 | 写入方 |
| --- | --- | --- |
| `users/{uid}` | `email`、`createdAt`、`disabled`、`claimedCodes/{code}` | 本人建档；`disabled` 仅管理员 |
| `users/{uid}/bankAccess` | `active`、`expiresAt`、`days`、`key`、`release`、`updatedAt` | 本人兑换时写入；管理员可续期 |
| `users/{uid}/bankMemory/{编号}` | `state`（`mastered`/`wrong`/空）、`star`、`note`、`updatedAt` | 仅本人 |
| `activation_codes/{code}` | `days`、`durationMs`、`note`、`createdAt`、`createdBy`、`release`、`key`、`revoked` | 仅管理员 |
| `activation_codes/{code}/claim` | `usedBy`、`usedAt`、`expiresAt`、`email` | 兑换者，且仅能写一次 |

**兑换规则**：`claim` 用 `.transaction()` 原子写入，`usedBy == null` 时才成功，因此同一个码并发兑换只有一人成功；到期时间按「未过期则在原到期时间上叠加，已过期则从当前时间起算」计算。密钥放在激活码节点内，只有在 `claim.usedBy` 等于本人时才可读，未兑换的码读不到密钥。

**管理后台**（`question-bank/manage/`）：按数量、天数、备注批量生成激活码，一键复制本次生成或全部未使用的码；查看每个码的使用者与到期时间；查看题库用户列表并手动续期（叠加天数）或停用/启用。所有操作只作用于 `activation_codes` 与 `users`，不会读写 `years/{学年}/studentWhitelist`。

**已知边界（无服务端架构的固有上限）**：

- 解密在浏览器完成，密钥一旦下发，已获得权限的人在到期后仍可能用本地留存的密钥与文件离线解密。到期与停用能阻止「再次获取密钥」，不能回收已下发的密钥。
- 规则把本人可写的 `expiresAt` 限制在 `now + 1095 天` 以内作为硬上限；管理员侧以 `activation_codes` 的 `claim` 记录为审计依据。
- 题库页新增 Firebase Auth（`firebase-auth.js`）与 `identitytoolkit` / `securetoken` 接口依赖；大陆网络若无法直连这些 Google 域名，邮箱登录会失败（错误提示会显示网络原因）。内部链接方式不依赖 Auth，仍可用。

**上线前置**：Firebase 控制台 Authentication 需已启用「电子邮件/密码」提供商；规则需单独 `firebase deploy --only database --project class-optic` 才会生效。

## 题库做题记忆与本地批改

**筛选与题面展示**：在原有学科、模块、来源、年份、备考范围、实考状态之外，新增三个筛选项——「考点标签」（题库现有 80 个标签，按拼音排序）、「题面形态」（`题面原页` 有/无）、「审查状态」（有核对说明 / 有备注 / 题干以扫描为准），以及「我的标记」（已掌握 / 错题 / 收藏 / 有笔记 / 未标记）。搜索索引同时纳入 `核对说明`、`备注`、`题干状态`、`指定考点`。

对 `题面原页 === true` 的题目，详情页在题干位置展示「本题原页」区块：有单题裁切图（`banks.scans`，717 题）时直接显示裁切图并可展开完整原页；只有完整原页时（约 600 题）直接把原页翻页控件放到题干位置，不再藏在折叠层里。题干为空的题不再渲染空白题干区。`核对说明` 与 `备注` 统一放进题干下方的独立提示块。

**做题记忆**：每道题可标记「已掌握 / 错题待重做 / 收藏」并写个人笔记。写入顺序是先 `localStorage`（键 `hust839-bank-memory`），再 900ms 防抖写 `users/{uid}/bankMemory`。换设备登录同一邮箱时，按 `updatedAt` 逐题取较新的一份合并：云端有本地无则拉回，本地有云端无则回传，两边都有则本地较新的回传、云端较新的采纳，因此不会出现整份覆盖导致记录丢失。未登录（内部链接通道）时只存本机，页面会显示提示。

**本地 BYOK 批改**：题目下方提供作答框、草稿图片上传（支持粘贴，自动压缩到 1280px 长边 / JPEG 0.72，最多 3 张）与批改按钮。设置弹窗填写接口地址（OpenAI 兼容，自动补 `/chat/completions`）、API Key、模型名。

- **API Key 只写本机 `localStorage`（键 `hust839-ai-config`），不上传 Firebase，也不经过本站服务器**；请求由浏览器直接发往学生自己填写的接口。换浏览器或清空站点数据后需重新填写。
- 发往模型的内容：题号、学科、模块、考点、题干、检索转录、核对说明、备注、备考依据、学生作答，以及该题原页/裁切图（经现有按需解密接口取出后压缩），提示词要求先给「得分：X/Y」再逐点分析。
- 需要服务商允许浏览器直连（CORS）。OpenAI 官方接口、DeepSeek、通义、豆包等 OpenAI 兼容端点多数可用；若接口拦截跨域，页面会提示具体原因。

## 题库发布流程（重要）

公开仓库的 `question-bank/` 是**产物目录**：`index.html`、`access.js`、`account.js`、`study.js`、`ai-tutor.js`、`manage/`、`content/*.bin` 都由私有题库仓库的 `docs/index.html` 与 `delivery/` 脚本生成。直接改公开仓库能立即上线，但**下次执行发布脚本会被覆盖**。

同步约定：题库前端改动需同时落到私有仓 `docs/index.html`（应用脚本）与 `delivery/`（`internal-client.js`、`account.js`、`study.js`、`ai-tutor.js`、`gate.html`、`gate.css`、`link-admin/`），发布命令为：

```bash
python3 delivery/publish-internal.py <公开仓 question-bank 路径> <settings.json> --release internal-v2
```

脚本会注入门禁页面与样式、Firebase SDK、四个前端脚本和 `internal-config`（`release`/`database`/`indexPath`/`apiKey`/`authDomain`），并复制 `manage/`。本轮改动已按此约定同步到私有仓。

## 历史遗留与回退

- `papers/`（模拟卷领取登记页 `papers/index.html`，含 A/B 卷答案 PDF、补充说明 PDF 与 8 张答案页图片）**暂时保留**。主站页面与脚本（`index.html`、`app.js`、`admin.js` 等）均不链接到它，只能通过 `/papers/` 直接访问；页面内的领取登记指向两个腾讯文档表单，属站外链接。该目录与主站功能独立，后续要下线时直接删除即可，不影响预约、考试与题库。
- `workers/`、`functions/`、`teacher-auth.js` 等 Worker / Cloud Functions / 教师登录相关文件已在回退提交 `910c730` 中移除，代码与页面不再引用（仅本段作为历史说明保留名称）。
- `rollback/6654ea8/` 与 `rollback/README-回退步骤.md` 是 6654ea8 旧版（口令登录、无 Worker）的历史快照与回退说明，**仅作历史回退参考**，不属于当前运行架构；其中的旧版 `database.rules.json` 不应覆盖当前规则。

## 本地检查与发布

- 从仓库根目录运行 `python3 -m http.server 8000`，通过 HTTP 打开页面检查资源和导航。当前配置指向线上数据库，本地检查时请使用只读流程，或换成独立测试项目。
- 运行 `node --test tests/*.test.js` 执行回归测试。`firebase.emulator.test.json` 和 `tests/database-rules.integration.cjs` 用于本地 Realtime Database 规则测试。
- 静态文件随 GitHub Pages 发布。数据库规则独立部署：`firebase deploy --only database --project class-optic`。部署会以本文件整体替换线上规则；本文件已保留共用同一数据库的 `blinkConsole`（眨眼控制台）节点规则，其余与本系统无关的节点（如 `ieltsReading`）已移除——若这些节点对应的其他应用仍在使用同一数据库，请先在 Firebase 控制台核对其规则并在部署前合并，避免误删。修改规则前先比对 Firebase 当前生效的版本。
