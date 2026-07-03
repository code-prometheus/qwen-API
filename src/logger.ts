import pino from "pino";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getLogPath(): string {
  try {
    // qwen 项目 src/logger.ts → 向上到项目根 → logs/
    const projectDir = resolve(__dirname, "..");
    const logDir = resolve(projectDir, "logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    return resolve(logDir, "app_debug.log");
  } catch {
    return "app_debug.log";
  }
}

let _logger: pino.Logger | null = null;

export function setupLogging(): pino.Logger {
  if (_logger) return _logger;

  const isDev = process.env.NODE_ENV !== "production";

  _logger = pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      transport: isDev
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
              ignore: "pid,hostname",
            },
          }
        : undefined,
    },
    isDev
      ? undefined // pino-pretty writes to stdout
      : pino.destination({
          dest: getLogPath(),
          sync: false,
        })
  );

  _logger.info("日志系统初始化完成");
  return _logger;
}

/** 获取全局 logger 实例 */
export function getLogger(): pino.Logger {
  if (!_logger) return setupLogging();
  return _logger;
}