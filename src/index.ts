/**
 * Qwen Web2API Server — TS 版入口
 *
 * 启动流程:
 * 1. 无本地凭证 → Playwright launchPersistentContext 登录 → 保存 → 关闭临时 Chrome
 * 2. ChromeManager spawn 后台 Chrome @ 60131（复用 chrome-profile session）
 * 3. 智能打开仪表盘：优先在已运行浏览器中新 tab，否则新开默认浏览器
 * 4. 启动 Fastify API 服务
 *
 * 永不主动退出。凭证失效时用户点击仪表盘按钮手动触发登录。
 */

import { exec, execSync } from "node:child_process";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { setupLogging, getLogger } from "./logger.js";
import { registerOpenAIRoutes } from "./openai-adapter.js";
import { registerAnthropicRoutes } from "./anthropic-adapter.js";
import { ChromeManager } from "./chrome-manager.js";
import { loginAuto, loginWithCredentials, deleteAllChats, hasLocalCredentials } from "./login-qwen.js";

setupLogging();
const log = getLogger();

// ─── 智能仪表盘打开 ──────────────────────────────────────────

/**
 * 尝试在已运行的 Chrome/Edge 浏览器中打开新 tab。
 * 找不到已有浏览器时回退到 start（默认浏览器）。
 */
function openDashboardSmart(port: number): void {
  const url = `http://127.0.0.1:${port}/dashboard`;
  const platform = process.platform;

  if (platform === "win32") {
    // 查找 Chrome 窗口标题（通过 tasklist），有则用 start 打开 tab
    // start 命令对已运行的 Chrome 会自动在新 tab 打开 URL
    try {
      const tasklist = execSync(
        'tasklist /fi "IMAGENAME eq chrome.exe" /fo csv /nh 2>nul',
        { shell: "cmd.exe", timeout: 5000 }
      ).toString().trim();

      if (tasklist && tasklist.length > 0) {
        log.info("[Bootstrap] 检测到 Chrome 进程，在新 tab 打开仪表盘");
        exec(`start "" "${url}"`);
        return;
      }
    } catch {}

    // 也尝试 Edge
    try {
      const tasklist = execSync(
        'tasklist /fi "IMAGENAME eq msedge.exe" /fo csv /nh 2>nul',
        { shell: "cmd.exe", timeout: 5000 }
      ).toString().trim();

      if (tasklist && tasklist.length > 0) {
        log.info("[Bootstrap] 检测到 Edge 进程，在新 tab 打开仪表盘");
        exec(`start msedge "${url}"`);
        return;
      }
    } catch {}
  }

  // macOS 尝试 osascript 在已有 Chrome 开 tab
  if ((platform as string) === "darwin") {
    exec(
      `osascript -e 'tell application "Google Chrome" to open location "${url}"' -e 'activate'`,
      (err) => {
        if (err) {
          // Chrome 没在运行，用 open 默认浏览器
          exec(`open "${url}"`);
        }
      }
    );
    return;
  }

  // 兜底：默认浏览器
  const cmd =
    platform === "win32"
      ? `start "" "${url}"`
      : platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) log.warn("[Bootstrap] 打开仪表盘失败: " + err.message);
  });
  log.info("[Bootstrap] 仪表盘打开中: " + url);
}

// ─── 启动：登录 → spawn Chrome → 仪表盘 → Fastify ───────────

let chrome: ChromeManager | null = null;
let loginSuccess = hasLocalCredentials();

// 步骤 1: 无凭证则登录（Playwright 临时 Chrome → 登录完就关）
if (!loginSuccess) {
  log.info("[Bootstrap] 无本地凭证，启动临时 Chrome 登录...");
  loginSuccess = await loginAuto();
}

// 步骤 2: spawn 后台 Chrome（复用 chrome-profile 中的 session）
try {
  chrome = new ChromeManager();
  await chrome.initialize();
  log.info("[Bootstrap] 后台 Chrome 就绪 (60131)");
} catch (err: any) {
  log.warn("[Bootstrap] 后台 Chrome 启动失败: " + err.message);
}

// 步骤 3: 智能打开仪表盘
openDashboardSmart(config.port);

// ─── Fastify ───────────────────────────────────────────────

const app = Fastify({ logger: false });

await app.register(cors, { origin: "*", credentials: true, methods: ["*"], allowedHeaders: ["*"] });

registerOpenAIRoutes(app);
registerAnthropicRoutes(app);

let activeConnections = 0;
app.addHook("onRequest", async () => { activeConnections++; });
app.addHook("onResponse", async () => { activeConnections--; });

// 仪表盘 HTML — 从多个路径查找（开发 dist/、源码 src/、ZIP 根目录）
app.get("/dashboard", async (_req, reply) => {
  let html = "";
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const searchPaths = [
      resolve(process.cwd(), "dashboard.html"),
      resolve(__dirname, "dashboard.html"),
      resolve(__dirname, "..", "src", "dashboard.html"),
    ];
    for (const p of searchPaths) {
      if (existsSync(p)) { html = readFileSync(p, "utf-8"); break; }
    }
  } catch {}
  if (!html) {
    try {
      const m = await (new Function("return import('./dashboard_html.mjs')")()) as any;
      html = m.DASHBOARD_HTML;
    } catch {}
  }
  return reply.type("text/html").send(html);
});

app.get("/", async () => {
  return {
    service: "Qwen Web2API Server (TS)",
    mode: config.mode,
    thinking_enabled: config.thinkingEnabled,
    search_enabled: config.searchEnabled,
    chrome_connected: chrome?.isReady ?? false,
    login_ok: loginSuccess || hasLocalCredentials(),
    connections: activeConnections,
  };
});

// ─── 健康检查 ───────────────────────────────────────────────

app.get("/health", async () => {
  const credOk = hasLocalCredentials();
  let qwenStatus = "unknown";
  try {
    const { QwenAI } = await import("./qwen-api.js");
    const inst = new QwenAI();
    qwenStatus = inst.hasCredentials() ? "ok" : "token_invalid";
  } catch (err: any) {
    qwenStatus = "error: " + (err.message || String(err));
  }
  return {
    status: credOk && qwenStatus === "ok" ? "healthy" : "degraded",
    credentials: credOk,
    qwen_api: qwenStatus,
    chrome: chrome?.isReady ?? false,
    connections: activeConnections,
    uptime: process.uptime(),
    mode: config.mode,
  };
});

// 手动触发登录（仪表盘按钮）
app.post("/relogin", async (_req, reply) => {
  log.info("[API] 手动触发登录...");
  const email = process.env.QWEN_EMAIL || process.env.EMAIL;
  const password = process.env.QWEN_PASSWORD || process.env.PASSWORD;
  if (!email || !password) {
    return { ok: false, error: "未配置 QWEN_EMAIL/QWEN_PASSWORD 环境变量，无法登录。请在环境变量中设置后重试。" };
  }
  loginWithCredentials(email, password).then(ok => {
    loginSuccess = ok;
    log.info("[API] 登录结果: " + (ok ? "成功" : "失败"));
  }).catch(err => log.error({ err }, "[API] 登录异常"));
  return { ok: true, message: "登录流程已触发" };
});

// 删除所有对话
app.post("/delete-chats", async (_req, reply) => {
  log.info("[API] 触发删除所有对话...");
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP("http://127.0.0.1:60131");
    const p = browser.contexts()[0].pages().find(pg => {
      try { return pg.url().includes("qwen.ai"); } catch { return false; }
    }) || browser.contexts()[0].pages()[0];
    await p.goto("https://chat.qwen.ai", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(2000);
    const { deleted, total } = await deleteAllChats(p, log);
    await browser.close();
    return { ok: true, deleted, total };
  } catch (err: any) {
    log.error({ err }, "[API] 删除对话异常");
    return { ok: false, error: err.message };
  }
});

app.setErrorHandler((error: Error, _request, reply) => {
  log.error({ err: error }, "未捕获异常");
  reply.code(500).send({ error: { message: error.message, type: "server_error" } });
});

// ─── 启动 ──────────────────────────────────────────────────

log.info(`[Qwen] Starting on ${config.host}:${config.port} | Mode=${config.mode.toUpperCase()} | Chrome=${chrome?.isReady ? "OK" : "NO"}`);
try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  log.error({ err }, "启动失败");
  process.exit(1);
}

process.on("SIGINT", async () => { log.info("Shutting down..."); await chrome?.shutdown(); process.exit(0); });
process.on("SIGTERM", async () => { await chrome?.shutdown(); process.exit(0); });
