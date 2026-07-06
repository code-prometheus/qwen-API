/**
 * Qwen Web2API Server — TS 版入口
 *
 * 启动流程:
 * 1. 检测 60131 端口 → 已有已登录 Chrome 则复用
 * 2. 无 → Playwright launchPersistentContext 启动 Chrome → 自动登录 → 保存 session
 *     → 关掉 Playwright context（不关 Chrome，保持 60131 占用）
 * 3. 在用户默认浏览器打开仪表盘（不占用 Chrome 60131 的窗口）
 *
 * 永不主动退出。凭证失效时用户点击仪表盘按钮手动触发登录。
 */

import { exec } from "node:child_process";
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

// ─── Chrome：检测 60131 → 无则登录 → 默认浏览器开仪表盘 ────

let chrome: ChromeManager | null = null;
let loginSuccess = hasLocalCredentials();

/** 在默认浏览器中打开仪表盘 */
function openDashboardInDefaultBrowser(port: number): void {
  const url = `http://127.0.0.1:${port}/dashboard`;
  const platform = process.platform;
  const cmd =
    platform === "win32"
      ? `start "" "${url}"`
      : platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) log.warn("[Bootstrap] 默认浏览器打开仪表盘失败: " + err.message);
    else log.info("[Bootstrap] 仪表盘已在默认浏览器打开: " + url);
  });
}

try {
  chrome = new ChromeManager();
  await chrome.initialize();
  log.info("[Bootstrap] Chrome CDP 已连接");

  // 如果 Chrome 是本次新启动的（之前没有登录 session），执行登录
  if (!loginSuccess) {
    log.info("[Bootstrap] 无本地凭证，自动登录...");
    loginSuccess = await loginAuto();
  }

  // 在默认浏览器打开仪表盘（不抢占 Chrome 60131 的窗口）
  openDashboardInDefaultBrowser(config.port);
} catch (err: any) {
  log.warn("[Bootstrap] Chrome 初始化失败: " + err.message);
}

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

// 手动触发登录（仪表盘按钮 → 开 tab 登录，不抢焦点）
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