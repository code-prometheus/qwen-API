// ─── OpenAI 协议模型 ───────────────────────────────────────

export interface OpenAIMessage {
  role: string;
  content: string | Record<string, unknown>[];
  name?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: OpenAITool[];
  // 扩展参数
  thinking?: boolean;
  search?: boolean;
  mode?: string;
}

// ─── Anthropic 协议模型 ────────────────────────────────────

export interface AnthropicMessage {
  role: string;
  content: string | Record<string, unknown>[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessageRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string | Record<string, unknown>[] | null;
  max_tokens?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  temperature?: number;
  thinking?: boolean | { type: string };
  // 扩展参数
  search?: boolean;
  mode?: string;
}

// ─── 内部统一 payload ──────────────────────────────────────

export interface QwenPayload {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  temperature?: number;
  thinking_enabled: boolean;
  search_enabled: boolean;
  max_tokens?: number;
}

// ─── 流式块类型 ────────────────────────────────────────────

export type ChunkType = "reasoning" | "content" | "error" | "tool_call";

export interface StreamChunk {
  type: ChunkType;
  delta?: string;
  content?: string;
  tool?: Record<string, unknown>;
}

// ─── 非流式结果 ────────────────────────────────────────────

export interface NonStreamResult {
  error?: string;
  reasoning?: string;
  content?: string;
  tools?: Record<string, unknown>[];
}