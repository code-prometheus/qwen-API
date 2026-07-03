import { resolve, dirname } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─── 端口配置（独立部署，不读 AIQuantTrade config.py）────────────
const DEFAULT_PORT = 5419;

export type Mode = "expert" | "quick";

export interface ServerConfig {
  apiKeys: string[];
  mode: Mode;
  thinkingEnabled: boolean;
  searchEnabled: boolean;
  host: string;
  port: number;
  maxConcurrent: number;
  failFast: boolean;
}

function envBool(key: string, defaultVal: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return defaultVal;
  return ["true", "1", "yes"].includes(v.toLowerCase());
}

export const config: ServerConfig = {
  apiKeys: (process.env.API_KEYS ?? "sk-deepseek-default-key").split(",").map(s => s.trim()),
  mode: (process.env.MODE as Mode | undefined) ?? "expert",
  thinkingEnabled: envBool("THINKING", true),
  searchEnabled: envBool("SEARCH", false),
  host: process.env.HOST ?? "0.0.0.0",
  port: parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10),
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT ?? "5", 10),
  failFast: envBool("FAIL_FAST", true),
};