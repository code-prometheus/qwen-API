import { FastifyRequest } from "fastify";
import { config } from "./config.js";

export interface AuthResult {
  apiKey: string;
}

/**
 * 验证 API Key：从 Authorization header 或 x-api-key header 中提取。
 * 如果未配置密钥，返回 anonymous。
 */
export function verifyApiKey(request: FastifyRequest): AuthResult {
  // 如果系统未配置任何 Key，视为不鉴权
  if (!config.apiKeys.length || config.apiKeys[0] === "") {
    return { apiKey: "anonymous" };
  }

  const authHeader = request.headers.authorization;
  const apiKeyHeader = request.headers["x-api-key"] as string | undefined;

  let token: string | undefined;

  if (apiKeyHeader) {
    token = apiKeyHeader;
  } else if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      token = parts[1];
    }
  }

  if (!token) {
    throw {
      statusCode: 401,
      error: "Unauthorized",
      message: "Missing authentication token. Provide 'Authorization: Bearer <key>' or 'x-api-key: <key>'",
    };
  }

  if (!config.apiKeys.includes(token)) {
    throw {
      statusCode: 403,
      error: "Forbidden",
      message: "Invalid API Key",
    };
  }

  return { apiKey: token };
}