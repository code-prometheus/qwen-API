/**
 * StreamSieve: 流式筛分引擎
 *
 * 负责从原始 SSE 流中剥离 `<｜tool calls begin｜>` 等 DSML 标签，
 * 分离出 reasoning (思考过程)、content (正文)、tool_call (工具调用)。
 *
 * 映射 Python 版 tool_sieve.py，保持 1:1 行为一致。
 *
 * 关键区别：
 * - 工具提取正则只匹配 <｜tool[ _]call[ _]begin｜>...<｜tool[ _]call[ _]end｜>（单数 call）
 *   <｜tool calls begin｜> 只是 wrapper 标签，不代表单个工具调用。
 * - 标签清理正则会移除所有变体（call/calls，空格/下划线）
 */

// 全角竖线 ｜ (U+FF5C)
const FW = "｜";

// 空格或下划线
const WS = "[ _]";

/**
 * 工具调用提取正则。
 * 只匹配单数 call 变体 <｜tool call begin｜>...<｜tool call end｜>
 * 不匹配 wrapper <｜tool calls begin｜>...<｜tool calls end｜>
 */
const TOOL_CALL_PATTERN = new RegExp(
  `<${FW}tool${WS}call${WS}begin${FW}>` +
  "(.*?)" +
  `<${FW}tool${WS}call${WS}end${FW}>`,
  "gs"
);

/**
 * 标签清理正则。
 * 移除所有 DSML 标签变体：
 * - <｜tool calls begin｜> / <｜tool calls end｜> (wrapper, 空格)
 * - <｜tool_calls_begin｜> / <｜tool_calls_end｜> (wrapper, 下划线)
 * - <｜tool call begin｜> / <｜tool call end｜> (单个工具, 空格)
 * - <｜tool_call_begin｜> / <｜tool_call_end｜> (单个工具, 下划线)
 */
const TAG_CLEAN_PATTERNS = [
  new RegExp(`<${FW}tool${WS}calls?${WS}(?:begin|end)${FW}>`, "g"),
];

export interface SieveEvent {
  type: "reasoning" | "content" | "tool_call";
  delta?: string;
  tool?: Record<string, unknown>;
}

export class StreamSieve {
  rawBuffer = "";
  cleanOut = "";
  private lastToolKeys = new Set<string>();

  /** 标准化原始内容：移除零宽空格 etc */
  private normalize(text: string): string {
    return text.replace(/​/g, "");
  }

  /**
   * 处理一个流式块，返回本次新增的事件列表
   */
  processChunk(chunkType: string, deltaText: string): SieveEvent[] {
    const events: SieveEvent[] = [];

    if (chunkType === "reasoning") {
      return [{ type: "reasoning", delta: deltaText }];
    }

    // 1. 标准化
    deltaText = this.normalize(deltaText);

    // 2. 累积原始内容
    this.rawBuffer += deltaText;

    // 3. 提取新工具调用（只匹配单数 call）
    const tools = this.extractNewToolCalls();
    for (const t of tools) {
      events.push({ type: "tool_call", tool: t });
    }

    // 4. 计算新的 clean 文本（移除所有标签变体）
    const newClean = this.cleanText();

    // 5. 输出新增纯文本（减去之前已输出的部分）
    if (newClean.length > this.cleanOut.length) {
      const added = newClean.slice(this.cleanOut.length);
      if (added) {
        events.push({ type: "content", delta: added });
      }
      this.cleanOut = newClean;
    }

    // 6. 定期清理 rawBuffer
    this.compact();

    return events;
  }

  /**
   * 刷新剩余内容（流结束时调用）
   */
  flush(): SieveEvent[] {
    const events: SieveEvent[] = [];

    const finalClean = this.cleanText();
    if (finalClean.length > this.cleanOut.length) {
      const added = finalClean.slice(this.cleanOut.length);
      if (added) {
        events.push({ type: "content", delta: added });
      }
      this.cleanOut = finalClean;
    }

    this.rawBuffer = "";
    this.cleanOut = "";
    this.lastToolKeys.clear();
    return events;
  }

  /** 提取新的工具调用，去重后返回 */
  private extractNewToolCalls(): Record<string, unknown>[] {
    const matches = this.rawBuffer.matchAll(TOOL_CALL_PATTERN);
    const newTools: Record<string, unknown>[] = [];

    for (const m of matches) {
      try {
        const toolData = JSON.parse(m[1].trim()) as Record<string, unknown>;
        const key = JSON.stringify(toolData);
        if (!this.lastToolKeys.has(key)) {
          this.lastToolKeys.add(key);
          newTools.push(toolData);
        }
      } catch {
        // JSON parse 失败则跳过（碎片化跨 chunk 导致）
      }
    }

    return newTools;
  }

  /** 移除 rawBuffer 中的所有 DSML 标签，返回纯文本 */
  private cleanText(): string {
    let result = this.normalize(this.rawBuffer);
    for (const pattern of TAG_CLEAN_PATTERNS) {
      result = result.replace(pattern, "");
    }
    return result;
  }

  /** rawBuffer 过大时清理已处理部分，保留尾部防止标签跨 chunk 截断 */
  private compact(): void {
    const KEEP = 120;
    if (this.rawBuffer.length > KEEP * 4) {
      this.rawBuffer = this.rawBuffer.slice(-KEEP);
      this.cleanOut = this.cleanText();
    }
  }
}