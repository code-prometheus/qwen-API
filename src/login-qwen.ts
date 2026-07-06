/**
 * LoginQwen: Qwen 网页版自动登录（Playwright keyboard 操作弹窗）
 *
 * 千问 /auth 页面会弹出一个浏览器原生弹窗（抢焦点），
 * Playwright 的 page.keyboard 操作直接作用于该弹窗，
 * Tab 切换 input → type 输入 → Enter 提交。
 */

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_CACHE_PATH = resolve(__dirname, "..", "qwen_auth.json");
const BASE_URL = "https://chat.qwen.ai";

export interface QwenAuthData {
  access_token: string;
  cookies: Record<string, string>;
  user_agent: string;
}

export async function deleteAllChats(page: any, log: any): Promise<{ deleted: number; total: number }> {
  try {
    log.info("[Cleanup] 删除所有历史对话...");
    // 获取对话列表
    const listResp = await page.evaluate(async () => {
      const resp = await fetch("https://chat.qwen.ai/api/v2/chats?page=1&page_size=100", {
        credentials: "include",
      });
      return JSON.stringify(await resp.json());
    });
    const chats = JSON.parse(listResp).data || [];
    log.info(`[Cleanup] 共 ${chats.length} 个对话`);

    // 逐个删除
    let deleted = 0;
    for (const chat of chats) {
      const result = await page.evaluate(async (id: string) => {
        const resp = await fetch(`https://chat.qwen.ai/api/v2/chats/${id}`, {
          method: "DELETE",
          credentials: "include",
        });
        const body = await resp.json();
        return JSON.stringify({ status: resp.status, success: body?.success });
      }, chat.id);
      if (JSON.parse(result).success) deleted++;
      // 间隔 100ms 防止触发限流
      await new Promise(r => setTimeout(r, 100));
    }
    log.info(`[Cleanup] 已删除 ${deleted}/${chats.length} 个对话`);
    return { deleted, total: chats.length };
  } catch (err: any) {
    log.warn(`[Cleanup] 删除对话出错: ${err.message}`);
    return { deleted: 0, total: 0 };
  }
}

function saveToken(token: string, cookies: Record<string, string>, userAgent: string): void {
  const data: QwenAuthData = {
    access_token: token,
    cookies,
    user_agent:
      userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/249.0.0.0 Safari/537.36",
  };
  writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(data, null, 2), "utf-8");
  getLogger().info(`凭证已保存 (token_len=${token.length}, cookies=${Object.keys(cookies).length})`);
}

export async function loginWithCredentials(
  email: string,
  password: string
): Promise<boolean> {
  const log = getLogger();
  const { chromium } = await import("playwright");
  const { ChromeManager } = await import("./chrome-manager.js");

  let browser: any = null;
  try {
    // 确保 Chrome 在 60131 运行（没有则 spawn 启动）
    const cm = new ChromeManager();
    await cm.initialize();

    // 始终通过 CDP 连接（connectOverCDP 的 close() 不关 Chrome）
    log.info("[Login] 连接 Chrome CDP...");
    browser = await chromium.connectOverCDP("http://127.0.0.1:60131");
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    // 1. 导航到 /auth（弹窗在这里出现，抢走焦点）
    log.info("[Login] 导航到 /auth...");
    await page.goto(`${BASE_URL}/auth`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // 2. 键盘操作弹窗 — Tab→email→Tab→password→Enter
    log.info("[Login] 键盘操作弹窗...");
    await page.keyboard.press("Tab");
    await page.keyboard.type(email, { delay: 30 });
    await page.keyboard.press("Tab");
    await page.keyboard.type(password, { delay: 30 });
    await page.keyboard.press("Enter");
    log.info("[Login] 弹窗已提交");

    // 3. 等待登录完成
    await page.waitForTimeout(5000);

    // 4. 提取 token
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const token = await page.evaluate(() => {
      try { return localStorage.getItem("token"); } catch { return null; }
    });

    if (!token) {
      log.error("[Login] 未获取到 token");
      await browser.close();
      return false;
    }

    log.info(`[Login] token 获取成功 (${token.length} 字符)`);

    // 5. 保存凭证
    const playwrightCookies = await context.cookies();
    const cookieDict: Record<string, string> = {};
    for (const c of playwrightCookies) cookieDict[c.name] = c.value;
    const ua = await page.evaluate(() => navigator.userAgent);

    saveToken(token, cookieDict, ua);
    log.info(`[Login] 登录完成 (token=${token.length}字符, cookies=${Object.keys(cookieDict).length})`);

    // 关掉千问 tab
    try {
      const pages = context.pages();
      for (const p of pages) {
        const u = (await p.evaluate("location.href").catch(() => "")) as string;
        if (u.includes("qwen.ai") || u.includes("auth")) {
          await p.close();
        }
      }
      log.info("[Login] 千问 tab 已关闭");
    } catch {}

    // 断开 Playwright CDP（不关 Chrome）
    await browser.close();
    return true;
  } catch (err: any) {
    log.error({ err }, "[Login] 登录异常");
    await browser?.close().catch(() => {});
    return false;
  }
}

export async function loginAuto(): Promise<boolean> {
  const email = process.env.QWEN_EMAIL || process.env.EMAIL;
  const password = process.env.QWEN_PASSWORD || process.env.PASSWORD;

  if (!email || !password) {
    getLogger().warn("[Login] 未设置 QWEN_EMAIL/QWEN_PASSWORD");
    return false;
  }

  getLogger().info("[Login] 自动登录");
  return loginWithCredentials(email, password);
}

export function hasLocalCredentials(): boolean {
  if (!existsSync(TOKEN_CACHE_PATH)) return false;
  try {
    const data = JSON.parse(readFileSync(TOKEN_CACHE_PATH, "utf-8"));
    return !!data.access_token && !!data.cookies;
  } catch {
    return false;
  }
}