/**
 * QwenAI: Qwen 网页版 API 核心封装 — 纯 HTTP
 *
 * 流程:
 *   chatStream(messages, model)
 *     → createChat() → completions SSE → parseSSEChunk → yield
 *
 * WAF/凭证失效时自动调用 refreshCredentials() 重新登录刷新 token，
 * 然后重试请求。
 */

import { v4 as uuidv4 } from "uuid";
import { getLogger } from "./logger.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── 类型 ──────────────────────────────────────────────────

export interface QwenAuth {
  access_token: string;
  cookies: Record<string, string>;
  user_agent: string;
}

export interface StreamResult {
  type: "thinking" | "text" | "error";
  content?: string;
  delta?: string;
}

// ─── 常量 ──────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_CACHE_PATH = resolve(__dirname, "..", "qwen_auth.json");

const BASE_URL = "https://chat.qwen.ai";
const API_COMPLETION = "https://chat.qwen.ai/api/v2/chat/completions";
const API_CHAT_NEW = "https://chat.qwen.ai/api/v2/chats/new";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const MODEL_MAP: Record<string, string> = {
  "qwen-max": "qwen3.7-plus",
  "qwen3-max": "qwen3.7-plus",
  "qwen-plus": "qwen3.7-plus",
  "qwen-turbo": "qwen3.6-plus",
  "qwen-lite": "qwen3.6-plus",
  "qwen3.6-plus": "qwen3.6-plus",
  "qwen3.7-plus": "qwen3.7-plus",
  default: "qwen3.7-plus",
};

// ─── 工具函数 ──────────────────────────────────────────────

function genId(): string {
  return uuidv4();
}

function resolveModel(inputModel: string): string {
  if (!inputModel) return MODEL_MAP.default;
  return MODEL_MAP[inputModel] ?? MODEL_MAP.default;
}

function loadCredentials(): QwenAuth | null {
  if (!existsSync(TOKEN_CACHE_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKEN_CACHE_PATH, "utf-8")) as QwenAuth;
    return data;
  } catch {
    return null;
  }
}

function buildBaseHeaders(token: string): Record<string, string> {
  const cleanToken = token.replace(/^Bearer /, "").replace(/"/g, "").trim();
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    Referer: BASE_URL + "/",
    Version: "0.2.65",
    source: "web",
    Origin: BASE_URL,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Authorization: cleanToken ? `Bearer ${cleanToken}` : "",
    "X-Request-Id": genId(),
  };
}

/**
 * 解析千问 SSE data 行
 */
function parseSSEChunk(dataStr: string): StreamResult | null {
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(dataStr);
  } catch {
    return null;
  }

  if ("response.created" in chunk) return null;

  const choices = (chunk as any).choices;
  if (!choices || !choices.length) return null;

  const delta = choices[0].delta || {};
  const phase = delta.phase || "";

  if (phase === "thinking_summary") {
    const extra = delta.extra || {};
    const thoughts = extra.summary_thought?.content;
    if (Array.isArray(thoughts) && thoughts.length > 0) {
      const content = thoughts[thoughts.length - 1];
      if (content) return { type: "thinking", content };
    }
    return null;
  }

  if (phase === "answer") {
    const content = delta.content || "";
    if (content) return { type: "text", content };
    if (delta.status === "finished") return null;
    return null;
  }

  return null;
}

// ─── acw_tc cookie ──────────────────────────────────────────

let _acwTc = "";

async function refreshAcwTc(): Promise<string> {
  try {
    const resp = await fetch(BASE_URL, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
    });
    const setCookie = resp.headers.get("set-cookie") || "";
    const m = setCookie.match(/acw_tc=([^;]+)/);
    if (m) _acwTc = m[1];
  } catch {
    // ignore
  }
  return _acwTc;
}

// ─── QwenAI 类 ─────────────────────────────────────────────

export class QwenAI {
  private auth: QwenAuth | null = null;

  constructor() {
    this.auth = loadCredentials();
  }

  /** 重新加载凭证文件 */
  reloadCredentials(): boolean {
    this.auth = loadCredentials();
    return this.auth !== null && !!this.auth.access_token && !!this.auth.cookies;
  }

  hasCredentials(): boolean {
    return this.auth !== null && !!this.auth.access_token && !!this.auth.cookies;
  }

  get token(): string {
    return this.auth?.access_token?.replace(/^Bearer /, "").replace(/"/g, "").trim() ?? "";
  }

  private buildCookieHeader(): string {
    const cookies = this.auth?.cookies ?? {};
    const parts: string[] = [];
    if (this.token) parts.push(`token=${this.token}`);
    for (const [k, v] of Object.entries(cookies)) {
      if (k !== "acw_tc") parts.push(`${k}=${v}`);
    }
    if (_acwTc) parts.push(`acw_tc=${_acwTc}`);
    return parts.join("; ");
  }

  /**
   * 凭证刷新回调 — 全局（所有 QwenAI 实例共享）。
   * 由 index.ts 在启动时注入。
   */
  static refreshCallback: (() => Promise<boolean>) | null = null;

  static setRefreshCallback(cb: () => Promise<boolean>): void {
    QwenAI.refreshCallback = cb;
  }

  /**
   * 触发凭证刷新：调用 login-qwen 重新登录 → 重新加载凭证文件
   */
  private async refreshCredentials(): Promise<boolean> {
    if (!QwenAI.refreshCallback) return false;
    getLogger().info("[QwenAI] 触发凭证刷新...");
    const ok = await QwenAI.refreshCallback();
    if (ok) {
      this.reloadCredentials();
      getLogger().info("[QwenAI] 凭证刷新成功");
    } else {
      getLogger().warn("[QwenAI] 凭证刷新失败");
    }
    return ok && this.hasCredentials();
  }

  // ─── createChat ──────────────────────────────────────────

  private async createChat(model: string): Promise<string> {
    const payload = {
      title: "New Chat",
      models: [model],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
      project_id: "",
    };

    return await this.fetchWithCDPFallback(
      "createChat",
      API_CHAT_NEW,
      payload,
      (data) => data.success ? (data.data?.id as string) : null,
      (data) => data.success, // status check: resp.ok && ct json
    );
  }

  /**
   * fetch → WAF 时自动切 CDP page.evaluate 代理
   * CDP 连接复用，不做 UI 操作
   */
  private async fetchWithCDPFallback<T>(
    phase: string,
    apiUrl: string,
    payload: Record<string, unknown>,
    extract: (data: any) => T | null,
    _checkOk?: (data: any) => boolean,
  ): Promise<T> {
    // Phase 1: 纯 HTTP fetch (最多 2 次)
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = buildBaseHeaders(this.token);
      headers.Cookie = this.buildCookieHeader();
      headers["X-Request-Id"] = genId();

      try {
        const resp = await fetch(apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        const ct = resp.headers.get("content-type") || "";
        if (resp.ok && ct.includes("json")) {
          const data = (await resp.json()) as any;
          const result = extract(data);
          if (result) return result;
        }

        const isWaf = resp.headers.get("bxpunish") || ct.includes("html");
        if (isWaf) {
          getLogger().warn({ attempt }, `[${phase}] WAF (fetch)`);
          if (attempt === 0) {
            await this.refreshCredentials();
            continue;
          }
        }
      } catch (err) {
        getLogger().warn({ err, attempt }, `[${phase}] fetch error`);
      }
    }

    // Phase 2: CDP proxy (real browser TLS)
    return await this.cdpProxyRequest<T>(phase, apiUrl, payload, extract);
  }

  /**
   * 通过 Chrome CDP page.evaluate 代理请求。
   * 复用已有的 CDP 连接，不做 UI 操作。
   */
  private async cdpProxyRequest<T>(
    phase: string,
    apiUrl: string,
    payload: Record<string, unknown>,
    extract: (data: any) => T | null,
  ): Promise<T> {
    getLogger().info(`[${phase}] CDP proxy via Chrome...`);
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP("http://127.0.0.1:60131");
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] || await context.newPage();
      // 确保页面在千问域下（cookie 关联）
      await page.goto("https://chat.qwen.ai", {
        waitUntil: "domcontentloaded", timeout: 10000,
      }).catch(() => {});

      const result = await page.evaluate(
        async ({ url, payload }: { url: string; payload: any }) => {
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(payload),
          });
          const data = await resp.json();
          return JSON.stringify({ ok: resp.ok, status: resp.status, data });
        },
        { url: apiUrl, payload },
      );

      const parsed = JSON.parse(result);
      if (parsed.ok && parsed.data) {
        const extracted = extract(parsed.data);
        if (extracted) {
          getLogger().info(`[${phase}] CDP proxy OK`);
          return extracted;
        }
      }
      getLogger().warn({ result: parsed }, `[${phase}] CDP proxy unexpected response`);
      throw new Error(`${phase} CDP proxy failed: unexpected response`);
    } catch (cdpErr: any) {
      getLogger().warn({ err: cdpErr }, `[${phase}] CDP proxy error`);
      throw new Error(`${phase} failed: fetch + CDP both exhausted. ${cdpErr.message}`);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // ─── 构造消息 ────────────────────────────────────────────

  constructMessages(
    messages: { role: string; content: string }[],
    qwenModel: string,
    thinkingEnabled: boolean
  ): Record<string, unknown>[] {
    if (!messages.length) return [];

    return messages.map((m, i) => {
      const msg: Record<string, unknown> = {
        fid: genId(),
        parentId: null,
        childrenIds: [],
        role: m.role,
        content: m.content,
        user_action: "chat",
        files: [],
        timestamp: Date.now(),
        models: [qwenModel],
        chat_type: "t2t",
        sub_chat_type: "t2t",
        extra: { meta: { subChatType: "t2t" } },
      };

      if (i === messages.length - 1) {
        msg.feature_config = {
          thinking_enabled: thinkingEnabled,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: true,
          thinking_mode: "Auto",
          thinking_format: "summary",
          auto_search: true,
        };
      }

      return msg;
    });
  }

  // ─── 流式对话 ────────────────────────────────────────────

  async *chatStream(
    messages: { role: string; content: string }[],
    model = "qwen-max"
  ): AsyncGenerator<StreamResult, void, undefined> {
    const qwenModel = resolveModel(model);
    const thinkingEnabled =
      model.includes("-thinking") || model.toLowerCase().includes("thinking");

    if (!this.auth) {
      // 尝试重新加载凭证
      if (!this.reloadCredentials()) {
        yield { type: "error", content: "未加载凭证，请先登录" };
        return;
      }
    }

    const processedMessages = this.constructMessages(
      messages,
      qwenModel,
      thinkingEnabled
    );

    const chatId = await this.createChat(qwenModel);

    const payload = {
      stream: true,
      version: "2.1",
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model: qwenModel,
      parent_id: null,
      messages: processedMessages,
      timestamp: Date.now(),
    };

    const url = `${API_COMPLETION}?chat_id=${chatId}`;

    let chunkCount = 0;
    let wafRetries = 0;
    let lastThinkingLen = 0;
    const MAX_WAF = 2;

    // Phase 1: fetch SSE
    for (wafRetries = 0; wafRetries < MAX_WAF; wafRetries++) {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Referer: `${BASE_URL}/c/${chatId}`,
        Version: "0.2.65",
        source: "web",
        Origin: BASE_URL,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        Authorization: `Bearer ${this.token}`,
        "X-Accel-Buffering": "no",
        "X-Request-Id": genId(),
        Cookie: this.buildCookieHeader(),
      };

      try {
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        const ct = resp.headers.get("content-type") || "";
        const bxpunish = resp.headers.get("bxpunish") || "";

        if (bxpunish || (ct.includes("html") && resp.status === 200)) {
          getLogger().warn({ wafRetry: wafRetries }, "[chatStream] WAF (fetch)");
          if (wafRetries === 0) {
            await this.refreshCredentials();
            continue;
          }
          break; // 切 CDP fallback
        }

        if (resp.status !== 200) {
          yield { type: "error", content: `HTTP ${resp.status}` };
          return;
        }

        if (!resp.body) {
          yield { type: "error", content: "响应体为空" };
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr) continue;

            const parsed = parseSSEChunk(dataStr);
            if (parsed) {
              chunkCount++;
              if (parsed.type === "thinking") {
                const current = parsed.content || "";
                if (current.length > lastThinkingLen) {
                  yield { type: "thinking", content: current.slice(lastThinkingLen) };
                  lastThinkingLen = current.length;
                }
              } else {
                yield { type: "text", content: parsed.content || "" };
              }
            }
          }
        }

        if (chunkCount === 0) yield { type: "text", content: "" };
        return;
      } catch (err: any) {
        getLogger().warn({ err }, "[chatStream] fetch error");
        // retry or fall through to CDP
        if (wafRetries < MAX_WAF - 1) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        break;
      }
    }

    // Phase 2: CDP proxy (non-streaming, via browser)
    try {
      getLogger().info("[chatStream] CDP proxy (non-streaming)...");
      const { chromium } = await import("playwright");
      const browser = await chromium.connectOverCDP("http://127.0.0.1:60131");
      try {
        const context = browser.contexts()[0];
        const page = context.pages()[0] || await context.newPage();
        await page.goto(`https://chat.qwen.ai/c/${chatId}`, {
          waitUntil: "domcontentloaded", timeout: 10000,
        }).catch(() => {});

        const nonStreamPayload = { ...payload, stream: false };
        const result = await page.evaluate(
          async ({ url, payload }: { url: string; payload: any }) => {
            const resp = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify(payload),
            });
            const data = await resp.json();
            return JSON.stringify({ ok: resp.ok, status: resp.status, data });
          },
          { url, payload: nonStreamPayload },
        );

        const parsed = JSON.parse(result);
        if (parsed.ok && parsed.data?.choices?.length) {
          const choice = parsed.data.choices[0];
          const msg = choice.message || choice.delta || {};
          if (msg.reasoning_content) {
            yield { type: "thinking", content: msg.reasoning_content };
          }
          if (msg.content) {
            yield { type: "text", content: msg.content };
          }
          if (!msg.reasoning_content && !msg.content) {
            yield { type: "text", content: "" };
          }
          return;
        }
        getLogger().warn({ result: parsed }, "[chatStream] CDP proxy unexpected");
        yield { type: "error", content: "CDP proxy: unexpected response" };
      } finally {
        await browser.close().catch(() => {});
      }
    } catch (cdpErr: any) {
      getLogger().warn({ err: cdpErr }, "[chatStream] CDP proxy error");
      yield { type: "error", content: cdpErr?.message || "CDP proxy error" };
    }
  }
}
