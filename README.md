# 专业课辅导预约系统

一个轻量级的大学专业课辅导预约与模拟考试系统，支持学生在线约课、管理员排班管理、模拟考试等功能。

## 功能概览

- **学生端** (`index.html`)：查看公告、约课、预约凭证、历史预约记录
- **管理后台** (`admin.html`)：今日工作台、排班管理、预约审批、白名单管理、数据导出
- **课时费管家** (`money.html`)：课时记录、统计报表、已完成预约批量入账
- **模拟考试** (`exam_student.html`)：学生导入试卷、作答、交卷凭证和复查
- **命题评卷** (`exam_teacher.html`)：教师出题、评卷打分、批改草稿、成绩排名

## 技术栈

- 纯前端（HTML + CSS + JavaScript），无需构建工具
- Firebase Realtime Database（数据存储）
- MathJax（公式渲染）
- Cropper.js（图片裁剪）

## 快速开始

1. 在 [Firebase Console](https://console.firebase.google.com/) 创建一个 Realtime Database 项目
2. 在 `config/firebase-env.js` 中填入 Firebase Web 配置（Web API Key 本身不是服务端密钥，真正的数据权限由 Database Rules 决定）
3. 在 Realtime Database 控制台发布仓库中的 `database.rules.json`
4. 在 Firebase Database 中手动设置管理员口令：
   ```
   admin_auth/你的密码: true
   ```
5. 将所有 HTML 文件部署到支持 HTTPS 的静态托管服务（如 GitHub Pages、Vercel、Netlify）

## 上线前安全说明

当前版本没有接入 Firebase Auth。管理员口令页只能减少误入和口令枚举，不能把公开前端变成可信后端；知道数据库地址的人仍可绕过页面直接请求允许匿名写入的预约、学年和成绩路径。若要防止恶意改排班、改成绩或删除数据，需要把教师写操作迁入受保护的服务端 API（例如 Cloudflare Worker / Firebase Functions，并使用 HttpOnly 会话），或后续接入可靠的身份认证。

上线前至少确认：已发布最新 Database Rules、使用 HTTPS、管理员和财务加密口令互不复用、已导出一份全量备份，并在无痕窗口验证学生预约与考试流程。

## 项目结构

```
├── index.html           # 学生端主页（约课 + 历史记录）
├── admin.html           # 管理后台（排班、审批、数据管理）
├── exam_student.html    # 学生模拟考试端
├── exam_teacher.html    # 教师命题与评卷系统
├── app.js               # 学生端核心逻辑
├── admin.js             # 管理后台核心逻辑
├── style.css            # 全局样式
├── config/
│   └── firebase-env.js  # Firebase 配置（需自行创建，已 gitignore）
└── utils/
    └── time-parser.js   # 时间解析工具
```

## 数据年度管理

系统支持多学年分流架构，每年数据独立存储于 `years/{年份}/` 路径下。管理员可通过下拉菜单切换学年，不影响学生端当前开放学年。
