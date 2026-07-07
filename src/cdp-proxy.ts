/**
 * CDP Proxy: 通过后台 Chrome (60131) page.evaluate 代理 HTTP 请求
 * 用于绕过阿里云 WAF 的 TLS 指纹检测。完全无 UI 操作。
 */
import { getLogger } from "./logger.js";

const CDP_ENDPOINT = "http://127.0.0.1:60131";

let _browser: any = null;
let _refCount = 0;

async function getBrowser(): Promise<any> {
  if (!_browser) {
    const { chromium } = await import("playwright");
    _browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  }
  _refCount++;
  return _browser;
}

async function releaseBrowser(): Promise<void> {
  _refCount--;
  if (_refCount <= 0 && _browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    _refCount = 0;
  }
}

/**
 * 通过 Chrome CDP page.evaluate 代理 POST 请求。
 * 浏览器上下文中的 fetch 拥有真实 Chrome TLS 指纹。
 * 完全静默 — 不开窗口、不抢焦点。
 */
export async function cdpFetch(
  apiUrl: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: any }> {
  const log = getLogger();
  const browser = await getBrowser();
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    // 确保页面在千问域以便 cookie 自动附加
    try {
      await page.goto("https://chat.qwen.ai", {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
    } catch {}

    const result = await page.evaluate(
      async ({ url, body }: { url: string; body: any }) => {
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(body),
          });
          const data = await resp.json();
          return JSON.stringify({ ok: resp.ok, status: resp.status, data });
        } catch (e: any) {
          return JSON.stringify({ ok: false, status: 0, error: e.message });
        }
      },
      { url: apiUrl, body: payload },
    );

    return JSON.parse(result);
  } finally {
    await releaseBrowser();
  }
}
