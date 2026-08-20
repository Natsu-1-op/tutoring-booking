# 专业课辅导预约系统

一个轻量级的大学专业课辅导预约与模拟考试系统，支持学生在线约课、管理员排班管理、模拟考试等功能。

## 功能概览

- **学生端** (`index.html`)：查看公告、约课、预约凭证、历史预约记录
- **管理后台** (`admin.html`)：今日工作台、排班管理、预约审批、白名单管理、数据导出
- **课时费管家** (`money.html`)：课时记录、统计报表、已完成预约批量入账
- **模拟考试** (`exam_student.html`)：学生导入试卷、作答、交卷凭证和复查
- **命题评卷** (`exam_teacher.html`)：教师出题、评卷打分、批改草稿、成绩排名

## 技术栈

- 静态前端（HTML + CSS + JavaScript）
- Cloudflare Workers（学生敏感操作的受控后端，免费方案）
- Firebase Realtime Database（数据存储）
- Firebase App Check（限制伪造客户端和自动化滥用）
- MathJax（公式渲染）
- Cropper.js（图片裁剪）

## 快速开始

1. 为这套系统创建一个独立的 Firebase 项目和 Realtime Database
2. 在 Authentication 中启用 Google 登录，并把实际部署域名加入授权域名
3. 将 `config/firebase-env.example.js` 复制为 `config/firebase-env.js`，再填入 Firebase Web 配置（Web API Key 本身不是服务端密钥，真正的数据权限由 Database Rules 和 Worker 决定）
4. 在 Firebase App Check 中为 Web 应用启用 reCAPTCHA v3，把 reCAPTCHA 网站密钥填入 `window.__STUDENT_API_CONFIG__.appCheckSiteKey`；reCAPTCHA 私密密钥只填入 Firebase 控制台，不要写入仓库
5. 部署 `workers/` 中的 Cloudflare Worker，并把 `https://your-worker.workers.dev` 替换为 `window.__STUDENT_API_CONFIG__.apiBaseUrl`；Worker 的 Firebase 服务账号私钥只能通过 Cloudflare Secret 保存
6. 将 `.firebaserc.example` 复制为 `.firebaserc`，把项目 ID 改为自己的 Firebase 项目
7. 老师第一次使用 Google 登录后，从 Firebase Authentication 用户列表复制 UID，在数据库写入教师白名单：
   ```text
   teacherAllowlist/<老师的 Firebase UID> = {
     "enabled": true,
     "canManageSystem": true
   }
   ```
   只有 `canManageSystem: true` 的老师可以进入排班管理后台和课时费页面；其他老师配置 `enabled: true` 后可以进入出卷评卷页面。这个节点不能通过前端写入，只能由 Firebase Console 或受保护的管理脚本维护。
8. 按“Worker → Database Rules → 静态页面”的顺序发布：
   ```bash
   firebase deploy --only database --project class-optic
   # 在你的静态托管平台发布页面
   ```
   Worker 部署和服务账号配置见 `workers/README.md`。Firebase 项目保持 Spark 免费方案，不部署 `functions/`。静态页面必须部署到 HTTPS 服务（如 GitHub Pages、Firebase Hosting、Vercel、Netlify）。

## 上线前安全说明

教师端现在使用 Google 登录和教师 UID 白名单，Database Rules 会在服务器端再次验证 Google 身份、邮箱验证状态和白名单。页面上的登录遮罩不是安全边界，真正权限由 Rules 决定；不要把 `teacherAllowlist` 或教师 UID 白名单的写权限开放给浏览器。

学生预约端保持“姓名、班级口令、选择时段”的方式不变。预约提交、历史查询、取消以及考试交卷均通过强制 App Check 的 Cloudflare Worker 完成；Worker 通过服务账号 OAuth2 访问 RTDB，匿名浏览器不能直接写入受保护数据。历史查询成功后使用 15 分钟内存会话取消预约，会话不会写入本地存储。

模拟考试进入时需要额外输入同一个班级预约口令。教师每次生成试卷时会先在 `examDefinitions` 登记随机试卷 ID 和票据哈希，学生文件只携带随机票据；后端会以云端登记的名称和时间为准。交卷锁只允许 Worker 使用服务账号更新，网页不能直接创建或覆盖。旧版学生试卷没有云端登记，升级后需要教师重新导出一次；旧母卷和旧答案仍可配对批改。

班级口令仍是同学之间共享的准入信息，不等同于每位学生的独立身份；若需要防止班内同学冒用姓名，必须进一步为学生绑定 Google 账号或发放个人一次性凭证。当前方案已阻止匿名数据库读取、直接改库、伪造未登记试卷和常规自动化撞库，但无法在不增加个人身份步骤的情况下证明输入姓名的人就是本人。

管理后台和课时费页面必须使用带 `canManageSystem: true` 的 Google 教师账号；课时费页面还需要课时费加密口令，加密口令不是登录凭证。命题评卷页面允许任意启用的教师账号使用。课时费只从云端账本显示，本地旧数据只能在迁移确认期间作为隐藏备份。

上线前至少确认：Worker `/health` 可访问、Worker 已配置服务账号 Secret、App Check 指标中能看到有效请求、最新 Database Rules 已发布、使用 HTTPS、课时费加密口令没有写入代码或数据库明文、已导出一份全量备份，并在无痕窗口验证学生预约/查询/取消、模拟考试交卷与教师登录流程。不要在 App Check 未配置完成时发布收紧后的规则。

## 项目结构

```
├── index.html           # 学生端主页（约课 + 历史记录）
├── admin.html           # 管理后台（排班、审批、数据管理）
├── exam_student.html    # 学生模拟考试端
├── exam_teacher.html    # 教师命题与评卷系统
├── app.js               # 学生端核心逻辑
├── student-api.js       # 学生端 Worker API 调用层
├── workers/             # Cloudflare Worker 后端与测试
├── functions/           # 旧版 Firebase Functions 参考/回退实现，不用于 Spark 部署
├── firebase.json        # 保留的 Firebase Database Rules 部署配置
├── teacher-auth.js      # 教师端 Google 登录和 UID 白名单检查
├── admin.js             # 管理后台核心逻辑
├── style.css            # 全局样式
├── config/
│   └── firebase-env.js  # Firebase Web 与 App Check 配置（复用时必须替换）
└── utils/
    └── time-parser.js   # 时间解析工具
```

## 数据年度管理

系统支持多学年分流架构，每年数据独立存储于 `years/{年份}/` 路径下。管理员可通过下拉菜单切换学年，不影响学生端当前开放学年。
