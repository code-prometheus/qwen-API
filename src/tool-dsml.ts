/**
 * DSML (DeepSeek Markup Language) 工具格式转换
 *
 * 将标准 Function Calling 工具列表转换为千问兼容的 DSML 提示词格式。
 * 映射 Python 版 tool_dsml.py。
 */

export interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
}

/**
 * 将工具列表转换为 DSML 指令文本，追加到消息末尾。
 * @param tools 工具定义列表（已转成统一格式）
 * @param protocol "openai" 或 "anthropic"
 */
export function formatToolsToDsml(
  tools: ToolDef[],
  protocol: "openai" | "anthropic" = "openai"
): string {
  if (!tools || tools.length === 0) return "";

  const lines: string[] = [];
  lines.push("\n\n<｜tool instructions begin｜>");
  lines.push(
    "You have access to the following tools. You can use them to help answer the user's request."
  );
  lines.push(
    'To use a tool, output a block like this:\n<｜tool calls begin｜><｜tool call begin｜>{"name": "tool_name", "arguments": {"arg1": "value1"}}<｜tool call end｜><｜tool calls end｜>'
  );
  lines.push("");
  lines.push("Available Tools:");

  for (const tool of tools) {
    let name: string;
    let desc: string;
    let params: Record<string, unknown>;

    if (protocol === "openai") {
      name = tool.name || "unknown";
      desc = tool.description || "";
      params = (tool.parameters || {}) as Record<string, unknown>;
    } else {
      name = tool.name || "unknown";
      desc = tool.description || "";
      params = (tool.input_schema || {}) as Record<string, unknown>;
    }

    const toolDef = { name, description: desc, parameters: params };
    lines.push(JSON.stringify(toolDef));
  }

  lines.push("<｜tool instructions end｜>\n");
  return lines.join("\n");
}

/**
 * 将 OpenAI 格式的 tools 转为统一 ToolDef[]
 */
export function openaiToolsToDefs(
  tools: { type: "function"; function: Record<string, unknown> }[]
): ToolDef[] {
  return tools.map((t) => {
    const fn = t.function as Record<string, unknown>;
    return {
      name: (fn.name as string) || "unknown",
      description: (fn.description as string) || "",
      parameters: (fn.parameters as Record<string, unknown>) || {},
    };
  });
}

/**
 * 将 Anthropic 格式的 tools 转为统一 ToolDef[]
 */
export function anthropicToolsToDefs(
  tools: { name: string; description?: string; input_schema: Record<string, unknown> }[]
): ToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.input_schema || {},
  }));
}