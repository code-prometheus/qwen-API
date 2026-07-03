/**
 * OpenAI 协议适配器
 * POST /v1/chat/completions
 * 完整映射 Python 版 openai_adapter.py
 */

import { FastifyInstance } from "fastify";
import { verifyApiKey } from "./auth.js";
import { config } from "./config.js";
import { acquireOrFail, release } from "./concurrency.js";
import { QwenClient } from "./qwen-client.js";
import { formatToolsToDsml, openaiToolsToDefs } from "./tool-dsml.js";
import { StreamSieve } from "./tool-sieve.js";
import type { OpenAIChatRequest, QwenPayload } from "./models.js";

function buildQwenPayload(request: OpenAIChatRequest): QwenPayload {
  const mode = request.mode || config.mode;
  const thinking =
    request.thinking !== undefined ? request.thinking : config.thinkingEnabled;
  const search =
    request.search !== undefined ? request.search : config.searchEnabled;

  // quick 模式强制关闭 thinking
  const effectiveThinking = mode === "quick" ? false : thinking;

  const messagesPayload = request.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));

  // 工具调用: 将 tools 转换为 DSML 文本追加到最后一条消息
  if (request.tools && request.tools.length > 0) {
    const toolDefs = openaiToolsToDefs(request.tools as any);
    const dsmlText = formatToolsToDsml(toolDefs, "openai");
    if (dsmlText && messagesPayload.length > 0) {
      messagesPayload[messagesPayload.length - 1].content += dsmlText;
    }
  }

  return {
    model: request.model || "qwen-max",
    messages: messagesPayload,
    stream: request.stream || false,
    temperature: request.temperature,
    thinking_enabled: effectiveThinking,
    search_enabled: search,
  };
}

async function* generateOpenAIStream(
  client: QwenClient,
  payload: QwenPayload,
  reqId: string
): AsyncGenerator<string, void, undefined> {
  const sieve = new StreamSieve();
  const created = Math.floor(Date.now() / 1000);
  let hasToolCalls = false; // 标记是否已输出过工具调用

  function makeChunk(delta: Record<string, unknown>): string {
    return JSON.stringify({
      id: reqId,
      object: "chat.completion.chunk",
      created,
      model: payload.model,
      choices: [
        {
          index: 0,
          delta,
          logprobs: null,
          finish_reason: null,
        },
      ],
    });
  }

  for await (const chunk of client.streamChat(payload)) {
    if (chunk.type === "error") {
      yield `data: ${JSON.stringify({
        error: { message: chunk.content || "", type: "upstream_error" },
      })}\n\n`;
      break;
    }

    const events = sieve.processChunk(chunk.type, chunk.delta || "");
    for (const event of events) {
      if (event.type === "reasoning") {
        yield `data: ${makeChunk({ reasoning_content: event.delta })}\n\n`;
      } else if (event.type === "content") {
        // 工具调用后 content 中的标签残留（DSML 碎片）直接丢弃
        if (!hasToolCalls) {
          yield `data: ${makeChunk({ content: event.delta })}\n\n`;
        }
      } else if (event.type === "tool_call" && event.tool) {
        hasToolCalls = true;
        const toolDelta = {
          tool_calls: [
            {
              index: 0,
              type: "function",
              function: {
                name: event.tool.name as string,
                arguments: JSON.stringify(event.tool.arguments || {}),
              },
            },
          ],
        };
        yield `data: ${makeChunk(toolDelta)}\n\n`;
      }
    }
  }

  // flush 阶段同样丢弃工具调用后的标签残留
  if (!hasToolCalls) {
    for (const event of sieve.flush()) {
      if (event.type === "content") {
        yield `data: ${makeChunk({ content: event.delta })}\n\n`;
      }
    }
  }

  const finishObj = JSON.parse(makeChunk({}));
  finishObj.choices[0].finish_reason = hasToolCalls ? "tool_calls" : "stop";
  yield `data: ${JSON.stringify(finishObj)}\n\n`;
  yield "data: [DONE]\n\n";
}

export function registerOpenAIRoutes(app: FastifyInstance): void {
  app.post(
    "/v1/chat/completions",
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
      const body = request.body as OpenAIChatRequest;

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
        const payload = buildQwenPayload(body);
        const reqId = `chatcmpl-${Date.now()}`;

        if (payload.stream) {
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          for await (const chunk of generateOpenAIStream(client, payload, reqId)) {
            reply.raw.write(chunk);
          }
          reply.raw.end();
          return reply;
        } else {
          const result = await client.nonStreamChat(payload);

          if (result.error) {
            return reply.code(500).send({
              error: { message: result.error, type: "api_error" },
            });
          }

          const rawContent = result.content || "";
          const hasTools = result.tools && result.tools.length > 0;

          const responseMsg: Record<string, unknown> = {
            role: "assistant",
            content: hasTools ? "" : rawContent,
          };
          if (result.reasoning) {
            responseMsg.reasoning_content = result.reasoning;
          }

          if (hasTools && result.tools) {
            responseMsg.tool_calls = result.tools.map((tool, i) => ({
              id: `call_${i}_${Date.now()}`,
              type: "function",
              function: {
                name: tool.name,
                arguments: JSON.stringify(tool.arguments || {}),
              },
            }));
          }

          return {
            id: reqId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model || payload.model,
            choices: [
              {
                index: 0,
                message: responseMsg,
                finish_reason: hasTools ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
        }
      } finally {
        release();
      }
    }
  );
}