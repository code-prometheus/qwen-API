import { config } from "./config.js";
import { getLogger } from "./logger.js";

let _semaphore: { acquire(): Promise<void>; release(): void; locked(): boolean } | null = null;

interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  locked(): boolean;
}

function createSemaphore(max: number): Semaphore {
  let available = max;
  const waiting: Array<() => void> = [];

  return {
    async acquire(): Promise<void> {
      if (available > 0) {
        available--;
        return;
      }
      return new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    },
    release(): void {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        available++;
      }
    },
    locked(): boolean {
      // 当所有槽位被占满时即视为锁定，不要求同时有等待者。
      // 之前的 available <= 0 && waiting.length > 0 会导致
      // 最后一个槽被占用后、队列为空时，下一个请求不会被拒绝而是
      // 进入 acquire() 阻塞等待，打破 failFast 语义。
      return available <= 0;
    },
  };
}

function getSemaphore(): Semaphore | null {
  if (_semaphore === null) {
    if (config.maxConcurrent > 0) {
      _semaphore = createSemaphore(config.maxConcurrent);
      getLogger().info(`[Concurrency] 并发限制: 最大 ${config.maxConcurrent} 个请求并发`);
    } else {
      getLogger().info("[Concurrency] 并发限制: 不限");
    }
  }
  return _semaphore;
}

/**
 * 尝试获取并发名额。
 * 返回 true 表示获取成功，false 表示超限被拒绝。
 */
export async function acquireOrFail(): Promise<boolean> {
  const sem = getSemaphore();
  if (!sem) return true;

  if (config.failFast) {
    if (sem.locked()) {
      return false;
    }
    await sem.acquire();
    return true;
  } else {
    await sem.acquire();
    return true;
  }
}

/** 释放并发名额 */
export function release(): void {
  const sem = getSemaphore();
  if (sem) sem.release();
}