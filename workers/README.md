# Cloudflare Worker 后端

学生预约和考试接口通过这个 Worker 访问 Firebase Realtime Database。前端不再直接调用 Firebase Functions；学生端的姓名、班级口令、预约和考试操作方式保持不变。

## 部署前准备

1. 在 Google Cloud 为 `class-optic` 创建专用服务账号，只授予 `Firebase Realtime Database Admin`（`roles/firebasedatabase.admin`）角色。
2. 为这个服务账号生成 JSON 私钥。私钥只保存在 Cloudflare Secret，不要提交到 Git、不要放进网页配置。
3. 在 Cloudflare 创建免费 Worker，并在本目录执行 `npm install`。

## 部署

```bash
npx wrangler login
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler deploy
```

部署后先访问：

```text
https://<worker-name>.<account>.workers.dev/health
```

看到 `{"ok":true}` 后，把这个 Worker 的基础地址填入 `config/firebase-env.js` 的 `apiBaseUrl`，再部署静态页面。

Worker 会验证 `X-Firebase-AppCheck`，再通过 Google OAuth2 服务账号令牌访问 RTDB。服务账号令牌和私钥只在 Worker 侧存在；不要把它们放入学生端代码。Firebase REST API 的 OAuth2 认证说明见 Firebase 官方文档。
