/**
 * QwenClient: 千问核心底层客户端
 *
 * 职责：封装 Qwen 网页版接口。
 * 永远不进 Mock 模式 —— API 不可用就直接报错拒绝服务。
 */

import { getLogger } from "./logger.js";
import { StreamSieve } from "./tool-sieve.js";
import type { StreamChunk, NonStreamResult, QwenPayload } from "./models.js";
import type { QwenAI } from "./qwen-api.js";

// ─── 后端类型 ──────────────────────────────────────────────

export const BACKEND_QWEN = "qwen";

// 延迟导入 QwenAI
let QwenAIClass: typeof import("./qwen-api.js").QwenAI | null = null;

async function getQwenAIClassOrThrow(): Promise<typeof import("./qwen-api.js").QwenAI> {
  if (QwenAIClass === null) {
    const mod = await import("./qwen-api.js");
    QwenAIClass = mod.QwenAI;
  }
  return QwenAIClass;
}

// ─── 内容提供者接口 ────────────────────────────────────────

export interface ContentProvider {
  streamChat(payload: QwenPayload): AsyncGenerator<StreamChunk, void, undefined>;
  quit(): void;
}

// ─── Qwen 提供者（唯一提供者，无 Mock 回退） ──────────────

class QwenProvider implements ContentProvider {
  private qwenInstance: QwenAI | null = null;

  private async ensureInstance(): Promise<NonNullable<typeof this.qwenInstance>> {
    if (!this.qwenInstance) {
      const Cls = await getQwenAIClassOrThrow();
      this.qwenInstance = new Cls();
    }
    return this.qwenInstance;
  }

  async *streamChat(payload: QwenPayload): AsyncGenerator<StreamChunk, void, undefined> {
    const qwen = await this.ensureInstance();
    const messages = payload.messages || [];
    const model = payload.model || "qwen-max";

    let chunkCount = 0;

    for await (const chunk of qwen.chatStream(messages, model)) {
      chunkCount++;
      if (chunk.type === "error") {
        const errMsg = chunk.content || "Unknown error";
        getLogger().warn(`Qwen 上游返回错误: ${errMsg}`);
        yield { type: "error", content: errMsg };
        return;
      } else if (chunk.type === "thinking") {
        yield { type: "reasoning", delta: chunk.content || "" };
      } else if (chunk.type === "text") {
        yield { type: "content", delta: chunk.content || "" };
      }
    }

    if (chunkCount === 0) {
      getLogger().warn("Qwen 上游无响应 (0 块)");
      yield { type: "error", content: "上游无响应" };
    }
  }

  quit(): void {
    this.qwenInstance = null;
  }
}

// ─── QwenClient 统一入口 ───────────────────────────────────

export class QwenClient {
  authToken?: string;
  provider: ContentProvider;

  constructor(authToken?: string) {
    this.authToken = authToken;
    this.provider = new QwenProvider();
  }

  get isMock(): boolean {
    return false;
  }

  async *streamChat(payload: QwenPayload): AsyncGenerator<StreamChunk, void, undefined> {
    for await (const chunk of this.provider.streamChat(payload)) {
      yield chunk;
    }
  }

  async nonStreamChat(payload: QwenPayload): Promise<NonStreamResult> {
    let fullReasoning = "";
    let fullContent = "";
    const toolCalls: Record<string, unknown>[] = [];
    const sieve = new StreamSieve();

    for await (const chunk of this.streamChat(payload)) {
      if (chunk.type === "error") {
        return { error: chunk.content || "Unknown error" };
      }
      const events = sieve.processChunk(chunk.type, chunk.delta || "");
      for (const ev of events) {
        if (ev.type === "reasoning") {
          fullReasoning += ev.delta || "";
        } else if (ev.type === "content") {
          fullContent += ev.delta || "";
        } else if (ev.type === "tool_call" && ev.tool) {
          toolCalls.push(ev.tool);
        }
      }
    }

    for (const ev of sieve.flush()) {
      if (ev.type === "content") {
        fullContent += ev.delta || "";
      }
    }

    return {
      reasoning: fullReasoning,
      content: fullContent,
      tools: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  quit(): void {
    this.provider.quit();
  }
}