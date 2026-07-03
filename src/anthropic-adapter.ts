/**
 * Anthropic 协议适配器
 * POST /v1/messages
 * 完整映射 Python 版 anthropic_adapter.py
 */

import { FastifyInstance } from "fastify";
import { verifyApiKey } from "./auth.js";
import { config } from "./config.js";
import { acquireOrFail, release } from "./concurrency.js";
import { QwenClient } from "./qwen-client.js";
import { formatToolsToDsml, anthropicToolsToDefs } from "./tool-dsml.js";
import { StreamSieve } from "./tool-sieve.js";
import type { AnthropicMessageRequest, QwenPayload } from "./models.js";

// ─── 工具函数 ──────────────────────────────────────────────

function resolveSystemText(system: string | Record<string, unknown>[] | null | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b): b is Record<string, unknown> & { text: string } =>
        typeof b === "object" && b.type === "text"
      )
      .map((b) => b.text)
      .join("\n");
  }
  return String(system);
}

function resolveThinking(
  thinking: boolean | { type: string } | undefined,
  defaultVal: boolean
): boolean {
  if (thinking === undefined) return defaultVal;
  if (typeof thinking === "boolean") return thinking;
  if (typeof thinking === "object") return true; // { type: "adaptive" } 视为启用
  return defaultVal;
}

function buildQwenPayloadFromAnthropic(request: AnthropicMessageRequest): QwenPayload {
  const mode = request.mode || config.mode;
  const thinking = resolveThinking(request.thinking, config.thinkingEnabled);
  const search = request.search !== undefined ? request.search : config.searchEnabled;

  const effectiveThinking = mode === "quick" ? false : thinking;

  const messagesPayload: { role: string; content: string }[] = [];

  const systemText = resolveSystemText(request.system);
  if (systemText) {
    messagesPayload.push({ role: "system", content: systemText });
  }

  for (const m of request.messages) {
    const content = m.content;

    if (typeof content === "string") {
      messagesPayload.push({ role: m.role, content });
    } else if (Array.isArray(content)) {
      const textParts: string[] = [];

      for (const b of content) {
        if (typeof b !== "object") continue;
        const btype = (b as any).type || "";

        if (btype === "text") {
          textParts.push((b as any).text || "");
        } else if (btype === "tool_result") {
          const inner = (b as any).content;
          const toolId = (b as any).tool_use_id || "";
          if (typeof inner === "string") {
            textParts.push(`[工具 ${toolId} 返回]: ${inner}`);
          } else if (Array.isArray(inner)) {
            const texts = inner
              .filter((ib: any) => ib.type === "text")
              .map((ib: any) => ib.text || "")
              .join("\n");
            if (texts) textParts.push(`[工具 ${toolId} 返回]: ${texts}`);
          }
        } else if (btype === "tool_use") {
          textParts.push(
            `[使用工具: ${(b as any).name || ""}, 参数: ${JSON.stringify((b as any).input || {}, null, 2)}]`
          );
        }
      }

      messagesPayload.push({ role: m.role, content: textParts.join("\n") });
    }
  }

  // 工具调用: 将 tools 转换为 DSML 文本追加到最后一条消息
  if (request.tools && request.tools.length > 0) {
    const toolDefs = anthropicToolsToDefs(request.tools as any);
    const dsmlText = formatToolsToDsml(toolDefs, "anthropic");
    if (dsmlText && messagesPayload.length > 0) {
      messagesPayload[messagesPayload.length - 1].content += dsmlText;
    }
  }

  return {
    model: request.model || "qwen-reasoner",
    messages: messagesPayload,
    stream: request.stream || false,
    temperature: request.temperature,
    thinking_enabled: effectiveThinking,
    search_enabled: search,
    max_tokens: request.max_tokens,
  };
}

async function* generateAnthropicStream(
  client: QwenClient,
  payload: QwenPayload
): AsyncGenerator<string, void, undefined> {
  const sieve = new StreamSieve();
  const reqId = `msg_${Date.now()}`;

  // 1. message_start
  yield `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: reqId,
      type: "message",
      role: "assistant",
      content: [],
      model: payload.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}\n\n`;

  let contentBlockIndex = 0;
  let toolCallIndex = 0;
  let textBlockActive = false;

  for await (const chunk of client.streamChat(payload)) {
    if (chunk.type === "error") {
      yield `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message: chunk.content || "" },
      })}\n\n`;
      break;
    }

    const events = sieve.processChunk(chunk.type, chunk.delta || "");

    for (const event of events) {
      if (event.type === "reasoning") {
        // 推理内容作为文本块输出
        if (!textBlockActive) {
          yield `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "text", text: "" },
          })}\n\n`;
          textBlockActive = true;
        }
        yield `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "text_delta", text: event.delta },
        })}\n\n`;
      } else if (event.type === "content") {
        if (!textBlockActive) {
          yield `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "text", text: "" },
          })}\n\n`;
          textBlockActive = true;
        }
        yield `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "text_delta", text: event.delta },
        })}\n\n`;
      } else if (event.type === "tool_call") {
        // 关闭前面可能的文本块
        if (textBlockActive) {
          yield `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: contentBlockIndex,
          })}\n\n`;
          textBlockActive = false;
          contentBlockIndex++;
        }

        const tcIndex = contentBlockIndex;
        const toolId = `toolu_${Date.now()}_${toolCallIndex}`;
        toolCallIndex++;

        yield `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: tcIndex,
          content_block: {
            type: "tool_use",
            id: toolId,
            name: event.tool?.name,
            input: {},
          },
        })}\n\n`;

        yield `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: tcIndex,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(event.tool?.arguments || {}),
          },
        })}\n\n`;

        yield `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: tcIndex,
        })}\n\n`;

        contentBlockIndex++;
      }
    }
  }

  // flush 剩余内容
  for (const event of sieve.flush()) {
    if (event.type === "content") {
      if (!textBlockActive) {
        yield `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: contentBlockIndex,
          content_block: { type: "text", text: "" },
        })}\n\n`;
        textBlockActive = true;
      }
      yield `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: contentBlockIndex,
        delta: { type: "text_delta", text: event.delta },
      })}\n\n`;
    }
  }

  if (textBlockActive) {
    yield `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: contentBlockIndex,
    })}\n\n`;
  }

  const stopReason = toolCallIndex > 0 ? "tool_use" : "end_turn";
  yield `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  })}\n\n`;
  yield `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}

export function registerAnthropicRoutes(app: FastifyInstance): void {
  app.post(
    "/v1/messages",
    {
      preHandler: (req, reply, done) => {
        try {
          verifyApiKey(req);
          done();
        } catch (err: any) {
          reply.code(err.statusCode || 401).send(err);
        }
      },
    },
    async (request, reply) => {
      const body = request.body as AnthropicMessageRequest;

      // 并发控制
      const acquired = await acquireOrFail();
      if (!acquired) {
        return reply.code(503).send({
          error: {
            message: "服务器并发数已满，请稍后重试",
            type: "server_error",
            code: 503,
          },
        });
      }

      const client = new QwenClient();
      try {
        const payload = buildQwenPayloadFromAnthropic(body);

        if (payload.stream) {
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          for await (const chunk of generateAnthropicStream(client, payload)) {
            reply.raw.write(chunk);
          }
          reply.raw.end();
          return reply;
        } else {
          const result = await client.nonStreamChat(payload);

          if (result.error) {
            return reply.code(500).send({
              type: "error",
              error: { type: "api_error", message: result.error },
            });
          }

          const contentBlocks: Record<string, unknown>[] = [];
          let fullText = "";

          if (result.reasoning) {
            fullText += `<thinking>\n${result.reasoning}\n</thinking>\n`;
          }

          const hasTools = result.tools && result.tools.length > 0;
          if (!hasTools) {
            fullText += result.content || "";
          }

          if (fullText) {
            contentBlocks.push({ type: "text", text: fullText });
          }

          if (hasTools && result.tools) {
            for (let i = 0; i < result.tools.length; i++) {
              contentBlocks.push({
                type: "tool_use",
                id: `toolu_${Math.floor(Date.now() / 1000)}_${i}`,
                name: result.tools[i].name,
                input: result.tools[i].arguments || {},
              });
            }
          }

          return {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            model: body.model || payload.model,
            content: contentBlocks,
            stop_reason: hasTools ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        }
      } finally {
        release();
      }
    }
  );
}