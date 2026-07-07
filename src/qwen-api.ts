/**
 * QwenAI: Qwen 网页版 API 核心封装
 *
 * 使用 undici/fetch 直接调用千问网页版 API，完全脱离浏览器。
 * 完整映射 Python 版 qwen_api.py 的行为。
 *
 * 流程:
 *   chat_stream(messages, model)
 *     → 解析模型名
 *     → 构造千问消息体（fid, parentId, feature_config 等）
 *     → _createChat() 创建对话获得 chat_id
 *     → POST chat/completions 获取 SSE 流
 *     → _parseSSEChunk() 解析千问专有 SSE 格式
 *     → yield {type, content} 块
 */

import { v4 as uuidv4 } from "uuid";
import { getLogger } from "./logger.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cdpFetch } from "./cdp-proxy.js";

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

  // 跳过创建事件
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

// ─── 获取 acw_tc cookie（WAF 防护） ──────────────────────────

let _acwTc = "";

async function refreshAcwTc(): Promise<string> {
  try {
    const resp = await fetch(BASE_URL, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
    });
    // 从 set-cookie 中提取 acw_tc
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
  lastReloginTime = 0;
  readonly RELOGIN_COOLDOWN = 120;
  // WAF 重试计数器
  private wafRetries = 0;
  readonly MAX_WAF_RETRIES = 3;

  constructor() {
    this.auth = loadCredentials();
  }

  /** 加载/刷新凭证 */
  loadCredentials(): boolean {
    this.auth = loadCredentials();
    return this.auth !== null && !!this.auth.access_token && !!this.auth.cookies;
  }

  /** 检查是否有可用凭证（供健康检查调用） */
  hasCredentials(): boolean {
    this.auth = loadCredentials();
    return this.auth !== null && !!this.auth.access_token && !!this.auth.cookies;
  }

  /** 获取 token（去掉 Bearer 前缀） */
  get token(): string {
    return this.auth?.access_token?.replace(/^Bearer /, "").replace(/"/g, "").trim() ?? "";
  }

  /**
   * 构建 cookie header 字符串
   */
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
   * 创建新对话
   */
  private async createChat(model: string): Promise<string> {
    const payload = {
      title: "New Chat",
      models: [model],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
      project_id: "",
    };

    const headers = buildBaseHeaders(this.token);
    headers.Cookie = this.buildCookieHeader();
    headers["X-Request-Id"] = genId();

    // Phase 1: 直连 fetch (最多 2 次)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(API_CHAT_NEW, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        const ct = resp.headers.get("content-type") || "";
        if (resp.ok && ct.includes("json")) {
          const data = (await resp.json()) as any;
          if (data.success) return data.data.id;
        }

        const isWaf = resp.headers.get("bxpunish") || ct.includes("html");
        if (isWaf) {
          getLogger().warn({ attempt }, "[createChat] WAF — falling back to CDP");
          break; // 跳出 fetch 循环，走 CDP
        }
      } catch (err) {
        getLogger().warn({ err, attempt }, "[createChat] fetch error");
        break;
      }
    }

    // Phase 2: CDP proxy
    getLogger().info("[createChat] CDP proxy...");
    const cdpResult = await cdpFetch(API_CHAT_NEW, payload);
    if (cdpResult.ok && cdpResult.data?.success) {
      getLogger().info("[createChat] CDP proxy OK");
      return cdpResult.data.data.id;
    }

    throw new Error(
      "创建对话失败: fetch + CDP 均失败。" +
      "请检查凭证是否有效、网络是否可达、或千问 API 是否变更。"
    );
  }

  /**
   * 构造千问消息体
   */
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

  /**
   * 流式对话 — 通过 fetch 直接调用千问 API
   */
  async *chatStream(
    messages: { role: string; content: string }[],
    model = "qwen-max"
  ): AsyncGenerator<StreamResult, void, undefined> {
    const qwenModel = resolveModel(model);
    const thinkingEnabled = model.includes("-thinking") || model.toLowerCase().includes("thinking");

    // 1. 准备凭证
    if (!this.auth) {
      yield { type: "error", content: "未加载凭证，请先登录" };
      return;
    }

    // 2. 构造消息
    const processedMessages = this.constructMessages(messages, qwenModel, thinkingEnabled);

    // 3. 创建对话
    const chatId = await this.createChat(qwenModel);

    // 4. 发送流式请求
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

    const url = `${API_COMPLETION}?chat_id=${chatId}`;

    let chunkCount = 0;
    let lastThinkingLen = 0;
    let fetchOk = false;

    // Phase 1: fetch SSE (最多 2 次)
    for (let attempt = 0; attempt < 2 && !fetchOk; attempt++) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        const ct = resp.headers.get("content-type") || "";
        const bxpunish = resp.headers.get("bxpunish") || "";

        if (bxpunish || (ct.includes("html") && resp.status === 200)) {
          getLogger().warn({ attempt }, "[chatStream] WAF (fetch)");
          break; // 切 CDP
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

        fetchOk = true;
      } catch (err: any) {
        getLogger().warn({ err }, "[chatStream] fetch error");
        break;
      }
    }

    if (fetchOk) {
      if (chunkCount === 0) yield { type: "text", content: "" };
      return;
    }

    // Phase 2: CDP proxy (non-streaming)
    getLogger().info("[chatStream] CDP proxy (non-streaming)...");
    const nonStreamPayload = { ...payload, stream: false };
    const cdpResult = await cdpFetch(url, nonStreamPayload);
    if (cdpResult.ok && cdpResult.data?.choices?.length) {
      const msg = cdpResult.data.choices[0].message || cdpResult.data.choices[0].delta || {};
      if (msg.reasoning_content) {
        yield { type: "thinking", content: msg.reasoning_content as string };
      }
      if (msg.content) {
        yield { type: "text", content: msg.content as string };
      }
      if (!msg.reasoning_content && !msg.content) {
        yield { type: "text", content: "" };
      }
      return;
    }

    yield {
      type: "error",
      content: "请求失败: fetch + CDP 均无法完成。请检查凭证或网络。",
    };
  }

  /**
   * WAF 拦截检测（映射 Python 版的检测逻辑）
   */
  private detectWaf(
    resp: Response,
    ct: string,
    bxpunish: string,
    status: number
  ): boolean {
    if (bxpunish) return true;
    if (ct.includes("html") && status === 200) return true;
    if (ct.includes("json")) return false; // JSON 不视为 WAF
    if (ct.includes("event-stream")) return false; // SSE 正常
    if (status !== 200) return true; // 非 200 视为 WAF
    return false;
  }
}