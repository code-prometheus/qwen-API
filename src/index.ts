/**
 * Qwen Web2API Server — TS 版入口
 *
 * 启动流程:
 * 1. 检测/启动 Chrome @ 60131
 * 2. 第一时间：最大化窗口、打开仪表盘、关掉其他 tab
 * 3. 检查凭证可用性
 * 4. 启动 Fastify API 服务
 *
 * 永不主动退出。凭证失效时用户点击仪表盘按钮手动触发登录。
 */

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

// ─── Chrome：启动/连接，最大化 + 仪表盘 ────────────────────

let chrome: ChromeManager | null = null;
let loginSuccess = hasLocalCredentials();

try {
  chrome = new ChromeManager();
  await chrome.initialize();
  log.info("[Bootstrap] Chrome CDP 已连接");

  // 第一时间：最大化 + 开仪表盘 + 关其他 tab
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:60131");
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();

  // 最大化
  if (pages.length > 0) {
    const cdp = await ctx.newCDPSession(pages[0]);
    await cdp.send("Browser.setWindowBounds", { windowId: 1, bounds: { windowState: "maximized" } }).catch(() => {});
  }

  // 关掉所有现有 tab
  for (const p of pages) {
    const u = (await p.evaluate("location.href").catch(() => "")) as string;
    if (!u.includes("dashboard")) await p.close();
  }

  // 等待 Tab 能力就绪（重试 newPage）
  let dash: any = null;
  for (let i = 0; i < 5; i++) {
    try {
      dash = await ctx.newPage();
      break;
    } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  if (dash) {
    await dash.goto(`http://127.0.0.1:${config.port}/dashboard`, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    await dash.bringToFront();
    log.info("[Bootstrap] 仪表盘已打开，窗口已最大化");
  }

  await browser.close(); // 只断开 Playwright，不关 Chrome
} catch (err: any) {
  log.warn("[Bootstrap] Chrome 仪表盘初始化失败: " + err.message);
}

// ─── Fastify ───────────────────────────────────────────────

const app = Fastify({ logger: false });

await app.register(cors, { origin: "*", credentials: true, methods: ["*"], allowedHeaders: ["*"] });

registerOpenAIRoutes(app);
registerAnthropicRoutes(app);

let activeConnections = 0;
app.addHook("onRequest", async () => { activeConnections++; });
app.addHook("onResponse", async () => { activeConnections--; });

// 仪表盘 HTML（优先从文件读，exe 模式下用 bundle 内联版本）
app.get("/dashboard", async (_req, reply) => {
  let html = "";
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "dashboard.html"), "utf-8");
  } catch {
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