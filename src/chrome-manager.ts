/**
 * ChromeManager: CDP 连接 + 自动启停 Chrome
 *
 * 架构：
 * 1. 检测 60131 端口是否在监听（是否已有 Chrome 远程调试）
 * 2. 有 → 直接通过 CDP 连接
 * 3. 无 → 启动 Chrome 并打开远程调试
 * 4. 所有应用共用同一个 Chrome 实例（BS 模式）
 */

import { spawn, exec } from "node:child_process";
import { createConnection } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import CDP from "chrome-remote-interface";

// ─── 常量 ──────────────────────────────────────────────────

const CDP_PORT = 60131;
const CDP_HOST = "127.0.0.1";

/** Chrome 远程调试入口 */
function getDebuggerUrl(): string {
  return `http://${CDP_HOST}:${CDP_PORT}`;
}

/** 项目根下的 Chrome Profile 路径（独立部署，不依赖 AIQuantTrade） */
function getProfilePath(): string {
  // qwen/src/chrome-manager.ts → qwen → qwen/chrome-profile
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, "..", "chrome-profile");
}

// ─── 端口检测 ──────────────────────────────────────────────

function checkPort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.on("connect", () => {
      socket.end();
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

// ─── Chrome 启动 ───────────────────────────────────────────

function findChrome(): string {
  // 尝试常见 Chrome 安装路径
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`
      : null,
  ].filter(Boolean) as string[];

  // 如果上面都没找到，通过 where 命令查找
  try {
    const { execSync } = require("node:child_process");
    const out = execSync('where chrome 2>nul || echo ""', { shell: "cmd.exe" }).toString().trim();
    if (out) candidates.unshift(out.split("\n")[0].trim());
  } catch {
    // ignore
  }

  return candidates[0] || "chrome";
}

function launchChrome(): Promise<{ pid: number | null }> {
  return new Promise((resolve, reject) => {
    const chromeExe = findChrome();
    const profilePath = getProfilePath();

    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
    ];

    const child = spawn(chromeExe, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });

    const childPid = child.pid;

    child.on("error", (err) => {
      reject(new Error(`Chrome 启动失败: ${err.message}`));
    });

    child.unref();

    // 等待 Chrome 就绪（轮询 CDP 端口）
    let attempts = 0;
    const maxAttempts = 30;
    const interval = setInterval(async () => {
      attempts++;
      const ready = await checkPort(CDP_PORT);
      if (ready) {
        clearInterval(interval);
        resolve({ pid: childPid ?? null });
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        reject(new Error("Chrome 启动超时，CDP 端口未就绪"));
      }
    }, 1000);
  });
}

// ─── CDP 客户端 ────────────────────────────────────────────

export interface ChromeTab {
  id: string;
  url: string;
  title: string;
}

export class CDPClient {
  private client: any = null;

  async connect(): Promise<void> {
    if (this.client) return; // 已连接
    try {
      this.client = await CDP({ host: CDP_HOST, port: CDP_PORT });
      await this.client.Page.enable();
      await this.client.Runtime.enable();
      await this.client.Network.enable();
    } catch (err: any) {
      throw new Error(`CDP 连接失败: ${err.message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch {}
      this.client = null;
    }
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  /** 获取所有打开的 tabs */
  async listTabs(): Promise<ChromeTab[]> {
    if (!this.client) return [];
    try {
      // 通过 HTTP 版本获取 tabs（CDP 本身不提供 tab 列表 API）
      const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
      return await resp.json() as ChromeTab[];
    } catch {
      return [];
    }
  }

  /** 新建 tab 并导航到指定 URL */
  async newTab(url: string): Promise<string> {
    if (!this.client) throw new Error("CDP 未连接");
    const result = await this.client.Page.navigate({ url });
    return result.frameId || "";
  }

  /** 在当前活动 tab 中导航 */
  async navigate(url: string): Promise<void> {
    await this.newTab(url);
  }

  /** 在页面中执行 JS */
  async evaluate<T>(expression: string): Promise<T> {
    if (!this.client) throw new Error("CDP 未连接");
    const result = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`CDP eval 异常: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result?.value as T;
  }

  /** 等待页面加载 */
  async waitForLoad(timeout = 30000): Promise<void> {
    if (!this.client) throw new Error("CDP 未连接");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("页面加载超时")), timeout);
      const handler = () => {
        clearTimeout(timer);
        resolve();
      };
      this.client.Page.loadEventFired(handler);
    });
  }

  /** 从 CDP 页面提取 cookies */
  async getCookies(): Promise<{ name: string; value: string }[]> {
    if (!this.client) return [];
    try {
      const result = await this.client.Network.getCookies();
      return (result.cookies || []).map((c: any) => ({
        name: c.name,
        value: c.value,
      }));
    } catch {
      return [];
    }
  }

  /** 获取 localStorage 中的某个 key */
  async getLocalStorage(key: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.evaluate<string | null>(
        `(function(){ try { return localStorage.getItem(${JSON.stringify(key)}); } catch(e) { return null; } })()`
      );
    } catch {
      return null;
    }
  }

  /** 等待选择器出现 */
  async waitForSelector(selector: string, timeout = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const exists = await this.evaluate<boolean>(
          `!!document.querySelector(${JSON.stringify(selector)})`
        );
        if (exists) return true;
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }
}

// ─── ChromeManager 统一入口 ────────────────────────────────

export class ChromeManager {
  cdp: CDPClient;
  private ready = false;

  constructor() {
    this.cdp = new CDPClient();
  }

  /**
   * 初始化 Chrome 连接:
   * 1. 检测 60131 端口
   * 2. 无 → 启动 Chrome
   * 3. 有 → 直接连接 CDP
   */
  async initialize(): Promise<void> {
    const portOpen = await checkPort(CDP_PORT);

    if (!portOpen) {
      console.log(`[Chrome] 60131 端口未监听，启动 Chrome...`);
      await launchChrome();
      console.log(`[Chrome] Chrome 已启动`);
    } else {
      console.log(`[Chrome] 60131 端口已有 Chrome 实例，复用`);
    }

    await this.cdp.connect();
    this.ready = true;
    console.log(`[Chrome] CDP 连接就绪`);
  }

  /** 关闭 CDP 连接（不关闭 Chrome） */
  async shutdown(): Promise<void> {
    this.ready = false;
    await this.cdp.disconnect();
  }

  get isReady(): boolean {
    return this.ready;
  }
}