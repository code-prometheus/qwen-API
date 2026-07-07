/**
 * LoginQwen: Qwen 网页版自动登录（Playwright keyboard 操作弹窗）
 *
 * 千问 /auth 页面会弹出一个浏览器原生弹窗（抢焦点），
 * Playwright 的 page.keyboard 操作直接作用于该弹窗，
 * Tab 切换 input → type 输入 → Enter 提交。
 *
 * 登录流程:
 * 1. launchPersistentContext 启动临时 Playwright Chrome (60131)
 * 2. 键盘操作弹窗登录
 * 3. 提取 token + cookies → 保存 qwen_auth.json
 * 4. context.close() 关闭这个临时 Chrome
 * 5. 后续 chrome-manager spawn 后台 Chrome 复用 profile 中的 session
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
    const listResp = await page.evaluate(async () => {
      const resp = await fetch("https://chat.qwen.ai/api/v2/chats?page=1&page_size=100", {
        credentials: "include",
      });
      return JSON.stringify(await resp.json());
    });
    const chats = JSON.parse(listResp).data || [];
    log.info(`[Cleanup] 共 ${chats.length} 个对话`);

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

/**
 * 用 Playwright launchPersistentContext 做登录（弹出可见 Chrome 窗口）。
 * 如果后台 Chrome 在 60131 运行中，先关掉它释放 profile 锁。
 * 登录完成后关掉临时 Chrome，重新 spawn 后台 Chrome。
 */
export async function loginWithCredentials(
  email: string,
  password: string
): Promise<boolean> {
  const log = getLogger();
  const { chromium } = await import("playwright");
  const profilePath = resolve(__dirname, "..", "chrome-profile");

  let context: any = null;
  try {
    // 关掉已有的后台 Chrome 释放 profile 锁
    log.info("[Login] 关闭后台 Chrome (释放 chrome-profile 锁)...");
    try {
      const { execSync } = await import("node:child_process");
      if (process.platform === "win32") {
        execSync('taskkill /F /IM chrome.exe 2>nul', { shell: "cmd.exe", timeout: 5000 });
      } else {
        execSync('pkill -f "chrome.*remote-debugging-port=60131" || true', { shell: "/bin/sh", timeout: 5000 });
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));

    log.info("[Login] 启动临时 Playwright Chrome 用于登录...");
    context = await chromium.launchPersistentContext(profilePath, {
      channel: "chrome",
      headless: false,
      args: [
        "--remote-debugging-port=60131",
        "--no-first-run",
        "--no-proxy-server",
        "--disable-extensions",
        "--disable-sync",
        "--disable-features=ChromePasswordManager,CredentialManagementUIShell",
      ],
      viewport: { width: 1280, height: 800 },
    });

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
      await context.close();
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

    // 6. 关闭临时 Chrome（session 已写入 chrome-profile）
    log.info("[Login] 关闭临时 Chrome...");
    await context.close();
    await new Promise(r => setTimeout(r, 2000));

    // 7. 重新 spawn 后台 Chrome（复用新 session）
    log.info("[Login] 重新启动后台 Chrome...");
    try {
      const { ChromeManager } = await import("./chrome-manager.js");
      const cm = new ChromeManager();
      await cm.initialize();
      log.info("[Login] 后台 Chrome 已重新启动 (60131)");
    } catch (e: any) {
      log.warn("[Login] 后台 Chrome 重启失败: " + e.message);
    }

    return true;
  } catch (err: any) {
    log.error({ err }, "[Login] 登录异常");
    try { await context?.close(); } catch {}
    await new Promise(r => setTimeout(r, 2000));
    // 登录失败了也尝试恢复后台 Chrome
    try {
      const { ChromeManager } = await import("./chrome-manager.js");
      const cm = new ChromeManager();
      await cm.initialize();
    } catch {}
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
