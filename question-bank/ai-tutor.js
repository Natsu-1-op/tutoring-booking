"use strict";
/**
 * 839 题库 · 本地 BYOK AI 批改
 * 接口地址、API Key、模型名只保存在当前浏览器 localStorage，绝不上传 Firebase。
 * 请求直接由浏览器发往学生自己填写的 OpenAI 兼容接口。
 */
(() => {
    const STORE = "hust839-ai-config";
    const MAX_IMAGES = 3;
    const MAX_EDGE = 1280;
    const QUALITY = 0.72;

    const defaults = { base: "https://api.openai.com/v1", key: "", model: "gpt-4o-mini" };

    function readConfig() {
        try {
            const raw = localStorage.getItem(STORE);
            const parsed = raw ? JSON.parse(raw) : {};
            return {
                base: typeof parsed.base === "string" && parsed.base ? parsed.base : defaults.base,
                key: typeof parsed.key === "string" ? parsed.key : "",
                model: typeof parsed.model === "string" && parsed.model ? parsed.model : defaults.model,
            };
        } catch {
            return { ...defaults };
        }
    }

    function writeConfig(config) {
        try {
            localStorage.setItem(STORE, JSON.stringify(config));
            return true;
        } catch {
            return false;
        }
    }

    function endpoint(base) {
        const trimmed = String(base || "").trim().replace(/\/+$/, "");
        if (!trimmed) throw new Error("请先在设置里填写接口地址。");
        if (/\/chat\/completions$/.test(trimmed)) return trimmed;
        return trimmed + "/chat/completions";
    }

    function assetType(id) {
        const path = (window.qbankBank?.assetPaths || {})[id] || "";
        const ext = path.split(".").pop().toLowerCase();
        return { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" }[ext] || "image/png";
    }

    async function toDataURL(blob, maxEdge = MAX_EDGE, quality = QUALITY) {
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();
        const scaled = await new Promise((resolve, reject) => {
            canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("图片压缩失败"))), "image/jpeg", quality);
        });
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("图片读取失败"));
            reader.readAsDataURL(scaled);
        });
    }

    // 题目原页图片：走现有按需解密接口，解密后压缩再送给模型
    async function protectedImage(id) {
        if (!id || !window.loadProtectedAsset) return "";
        const url = await window.loadProtectedAsset(id, assetType(id));
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            return await toDataURL(blob);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    function questionImages(question, context) {
        const scans = context?.scans || [];
        if (scans.length) return scans.slice(0, 2);
        if (question["题面原页"] && context?.links?.length) {
            const bank = window.qbankBank || {};
            const link = context.links[0];
            const key = link["附件"];
            const pages = bank.previews?.[key];
            if (pages) {
                const wanted = (Array.isArray(link["页码或位置"]) ? link["页码或位置"] : [])[0];
                const pageKey = wanted && pages[wanted] ? pages[wanted] : pages[Object.keys(pages)[0]];
                if (pageKey) return [pageKey];
            }
            if (bank.assetPaths?.[key] && /\.(webp|jpe?g|png)$/i.test(bank.assetPaths[key])) return [key];
        }
        return [];
    }

    function escapeHTML(text) {
        return String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    function renderRich(container, text) {
        container.replaceChildren();
        const lines = String(text || "").split(/\r?\n/);
        let list = null;
        const inline = value => escapeHTML(value)
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/`([^`]+)`/g, "<code>$1</code>");
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) {
                list = null;
                continue;
            }
            const bullet = line.match(/^[-*•]\s+(.*)$/);
            if (bullet) {
                if (!list) {
                    list = document.createElement("ul");
                    container.append(list);
                }
                const item = document.createElement("li");
                item.innerHTML = inline(bullet[1]);
                list.append(item);
                continue;
            }
            list = null;
            const heading = line.match(/^#{1,6}\s+(.*)$/);
            const node = document.createElement("p");
            if (heading) {
                node.className = "ai-score";
                node.innerHTML = inline(heading[1]);
            } else if (/^(得分|评分|分数|总分|Score)/i.test(line)) {
                node.className = "ai-score";
                node.innerHTML = inline(line);
            } else {
                node.innerHTML = inline(line);
            }
            container.append(node);
        }
    }

    function buildPrompt(question, answer, images) {
        const lines = [];
        lines.push("请按华科 839《物理光学》《激光原理》课程的阅卷口径批改这道题。");
        lines.push("");
        lines.push("【题目编号】" + question["编号"]);
        lines.push("【学科】" + question["学科"]);
        lines.push("【模块】" + (question["模块"] || []).join("、"));
        lines.push("【考点】" + (question["考点标签"] || []).join("、"));
        if (question["来源"]) lines.push("【来源】" + question["来源"] + (question["原题号"] ? " · " + question["原题号"] : ""));
        lines.push("");
        lines.push("【题干】");
        lines.push((question["题干"] || "").trim() || "（题干以随附原页图片为准）");
        if (question["检索转录"]) lines.push("【题面摘要】" + question["检索转录"]);
        if (question["核对说明"]) lines.push("【审查说明】" + question["核对说明"]);
        if (question["备注"]) lines.push("【备注】" + question["备注"]);
        if (question["备考判断依据"]) lines.push("【备考依据】" + question["备考判断依据"]);
        if (images.length) lines.push("【附图】随附 " + images.length + " 张图片，第一张是本题原页或题面截图。");
        lines.push("");
        lines.push("【学生作答】");
        lines.push(answer.trim() || "（学生未提交文字作答，请从作答图片判断。）");
        lines.push("");
        lines.push("输出要求：");
        lines.push("1. 先给一行「得分：X/Y」，Y 按本题分值估计，无法判断时按 10 分制；");
        lines.push("2. 逐点列出得分点与失分点，指出公式、量纲、光路或物理概念上的错误；");
        lines.push("3. 最后给出 1—3 条改进建议，必要时补上正确解法要点；");
        lines.push("4. 用简体中文，公式用行内 LaTeX，不要输出与批改无关的客套话。");
        return lines.join("\n");
    }

    async function request(config, prompt, images, signal) {
        const content = [{ type: "text", text: prompt }];
        for (const url of images) content.push({ type: "image_url", image_url: { url } });
        const response = await fetch(endpoint(config.base), {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.key },
            body: JSON.stringify({
                model: config.model,
                temperature: 0.2,
                max_tokens: 1600,
                messages: [
                    { role: "system", content: "你是华中科技大学 839 光学课程的阅卷老师，批改严谨、指出问题具体、不敷衍。" },
                    { role: "user", content },
                ],
            }),
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            if (response.status === 401 || response.status === 403) throw new Error("密钥无效或没有权限（HTTP " + response.status + "）。");
            if (response.status === 404) throw new Error("接口地址或模型名不存在（HTTP 404），请检查设置。");
            if (response.status === 429) throw new Error("请求过于频繁或额度用尽（HTTP 429）。");
            throw new Error("接口返回 HTTP " + response.status + (detail ? "：" + detail.slice(0, 200) : ""));
        }
        const data = await response.json();
        const message = data?.choices?.[0]?.message?.content;
        if (Array.isArray(message)) return message.map(part => part?.text || "").join("\n");
        if (typeof message === "string" && message.trim()) return message;
        throw new Error("接口没有返回批改内容。");
    }

    function settingsDialog(onSave) {
        const dialog = document.createElement("dialog");
        dialog.className = "ai-dialog";
        const head = document.createElement("header");
        const title = document.createElement("h2");
        title.textContent = "本地 AI 批改设置";
        const close = document.createElement("form");
        close.method = "dialog";
        const closeButton = document.createElement("button");
        closeButton.textContent = "关闭";
        close.append(closeButton);
        head.append(title, close);

        const body = document.createElement("div");
        body.className = "dialog-body";
        const form = document.createElement("div");
        form.className = "ai-settings";

        const fields = [
            { key: "base", label: "接口地址（OpenAI 兼容）", placeholder: "https://api.openai.com/v1", type: "url" },
            { key: "key", label: "API Key（仅存本机）", placeholder: "sk-...", type: "password" },
            { key: "model", label: "模型名称", placeholder: "gpt-4o-mini / qwen-vl-max / doubao-1.5-vision-pro", type: "text" },
        ];
        const inputs = {};
        const current = readConfig();
        for (const field of fields) {
            const label = document.createElement("label");
            label.textContent = field.label;
            const input = document.createElement("input");
            input.type = field.type;
            input.placeholder = field.placeholder;
            input.value = current[field.key] || "";
            input.autocomplete = "off";
            input.spellcheck = false;
            label.append(input);
            form.append(label);
            inputs[field.key] = input;
        }

        const note = document.createElement("p");
        note.className = "ai-note";
        note.textContent = "Key 只写进当前浏览器的 localStorage，不会上传到 Firebase，也不经过本站服务器；请求由浏览器直接发往你填写的接口。换浏览器或清空站点数据后需要重新填写。";

        const actions = document.createElement("div");
        actions.className = "ai-row";
        const save = document.createElement("button");
        save.type = "button";
        save.className = "primary";
        save.textContent = "保存";
        const clear = document.createElement("button");
        clear.type = "button";
        clear.textContent = "清除密钥";
        const state = document.createElement("span");
        state.className = "study-hint";
        actions.append(save, clear, state);

        save.addEventListener("click", () => {
            const ok = writeConfig({
                base: inputs.base.value.trim() || defaults.base,
                key: inputs.key.value.trim(),
                model: inputs.model.value.trim() || defaults.model,
            });
            state.textContent = ok ? "已保存到本机。" : "浏览器不允许写入本地存储。";
            if (ok) onSave?.();
        });
        clear.addEventListener("click", () => {
            inputs.key.value = "";
            writeConfig({ base: inputs.base.value.trim() || defaults.base, key: "", model: inputs.model.value.trim() || defaults.model });
            state.textContent = "密钥已清除。";
            onSave?.();
        });

        body.append(form, note, actions);
        dialog.append(head, body);
        return { dialog, refresh: () => { const next = readConfig(); for (const key of Object.keys(inputs)) inputs[key].value = next[key] || ""; } };
    }

    // 设置弹窗全站复用一份，避免每渲染一道题就多一个 dialog
    let settingsUI = null;
    let settingsSaver = null;

    function ensureSettings() {
        if (settingsUI) return settingsUI;
        settingsUI = settingsDialog(() => settingsSaver?.());
        document.body.append(settingsUI.dialog);
        return settingsUI;
    }

    function mount(marks, question, context) {
        const panel = document.createElement("section");
        panel.className = "ai-panel";
        const head = document.createElement("h3");
        head.append(document.createTextNode("本地 AI 批改"));
        const settings = document.createElement("button");
        settings.type = "button";
        settings.textContent = "设置";
        head.append(settings);
        panel.append(head);

        const hint = document.createElement("p");
        hint.className = "study-hint";
        const area = document.createElement("textarea");
        area.placeholder = "写下你的作答（含关键公式与推导），也可以只传草稿照片";
        area.setAttribute("aria-label", "你的作答");
        const thumbs = document.createElement("div");
        thumbs.className = "ai-thumbs";
        const row = document.createElement("div");
        row.className = "ai-row";
        const pick = document.createElement("button");
        pick.type = "button";
        pick.textContent = "添加草稿图片";
        const run = document.createElement("button");
        run.type = "button";
        run.className = "primary";
        run.textContent = "批改";
        const clear = document.createElement("button");
        clear.type = "button";
        clear.textContent = "清空";
        const file = document.createElement("input");
        file.type = "file";
        file.accept = "image/*";
        file.multiple = true;
        file.hidden = true;
        row.append(pick, run, clear, file);
        const result = document.createElement("div");
        result.className = "ai-result";
        panel.append(hint, area, thumbs, row, result);

        const attached = [];
        let controller = null;

        settings.addEventListener("click", () => {
            settingsSaver = paintHint;
            const ui = ensureSettings();
            ui.refresh();
            ui.dialog.showModal();
        });

        function paintHint() {
            const config = readConfig();
            if (!config.key) {
                hint.textContent = "先点「设置」填写接口地址、API Key 和模型名，密钥只存在本机。";
                hint.dataset.kind = "warn";
            } else {
                hint.textContent = "当前模型：" + config.model + " · 密钥仅存本机浏览器。";
                delete hint.dataset.kind;
            }
        }

        function paintThumbs() {
            thumbs.replaceChildren();
            attached.forEach((item, index) => {
                const figure = document.createElement("figure");
                const image = document.createElement("img");
                image.src = item.url;
                image.alt = "作答图片 " + (index + 1);
                const remove = document.createElement("button");
                remove.type = "button";
                remove.textContent = "×";
                remove.setAttribute("aria-label", "移除第 " + (index + 1) + " 张图片");
                remove.addEventListener("click", () => {
                    attached.splice(index, 1);
                    paintThumbs();
                });
                figure.append(image, remove);
                thumbs.append(figure);
            });
        }

        async function addFiles(files) {
            for (const item of files) {
                if (attached.length >= MAX_IMAGES) break;
                if (!item.type.startsWith("image/")) continue;
                try {
                    attached.push({ url: await toDataURL(item), name: item.name || "草稿" });
                } catch (error) {
                    result.textContent = error.message;
                }
            }
            paintThumbs();
        }

        pick.addEventListener("click", () => file.click());
        file.addEventListener("change", () => {
            addFiles([...file.files]);
            file.value = "";
        });
        area.addEventListener("paste", event => {
            const files = [...(event.clipboardData?.items || [])]
                .filter(item => item.kind === "file" && item.type.startsWith("image/"))
                .map(item => item.getAsFile())
                .filter(Boolean);
            if (!files.length) return;
            event.preventDefault();
            addFiles(files);
        });
        clear.addEventListener("click", () => {
            area.value = "";
            attached.length = 0;
            paintThumbs();
            result.replaceChildren();
        });

        run.addEventListener("click", async () => {
            const config = readConfig();
            if (!config.key) {
                paintHint();
                settingsSaver = paintHint;
                const ui = ensureSettings();
                ui.refresh();
                ui.dialog.showModal();
                return;
            }
            if (!area.value.trim() && !attached.length) {
                result.textContent = "请先写下作答，或添加一张草稿图片。";
                return;
            }
            controller?.abort();
            controller = new AbortController();
            run.disabled = true;
            result.className = "ai-result";
            result.textContent = "正在批改…";
            try {
                const images = [];
                for (const id of questionImages(question, context)) {
                    try {
                        const url = await protectedImage(id);
                        if (url) images.push(url);
                    } catch {
                        // 原页解密失败不阻塞文字批改
                    }
                }
                for (const item of attached) images.push(item.url);
                const prompt = buildPrompt(question, area.value, images);
                const text = await request(config, prompt, images, controller.signal);
                renderRich(result, text);
            } catch (error) {
                if (error.name === "AbortError") return;
                result.textContent = "批改失败：" + (error.message || "未知错误") + "\n如果提示网络或跨域错误，说明该接口不允许浏览器直接访问，请换用支持浏览器直连的 OpenAI 兼容服务。";
            } finally {
                run.disabled = false;
            }
        });

        paintHint();
        marks.append(panel);
    }

    window.qbankAi = { mount, readConfig };
})();
