# 专业课辅导预约系统

一个轻量级的大学专业课辅导预约与模拟考试系统，支持学生在线约课、管理员排班管理、模拟考试等功能。

## 功能概览

- **学生端** (`index.html`)：查看公告、约课、查看历史预约记录
- **管理后台** (`admin.html`)：排班管理、预约审批、白名单管理、数据导出
- **模拟考试** (`exam_student.html`)：学生导入试卷并作答交卷
- **命题评卷** (`exam_teacher.html`)：教师出题、评卷打分、成绩排名

## 技术栈

- 纯前端（HTML + CSS + JavaScript），无需构建工具
- Firebase Realtime Database（数据存储）
- MathJax（公式渲染）
- Cropper.js（图片裁剪）

## 快速开始

1. 在 [Firebase Console](https://console.firebase.google.com/) 创建一个 Realtime Database 项目
2. 复制 `config/firebase-env.example.js` 为 `config/firebase-env.js`，填入你的 Firebase 配置
3. 将所有 HTML 文件部署到任意静态托管服务（如 GitHub Pages、Vercel、Netlify）
4. 在 Firebase Database 中手动设置管理员密码：
   ```
   admin_auth/你的密码: true
   ```

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
