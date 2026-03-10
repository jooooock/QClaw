import { SessionType, ResultCode } from "./types";
import type { MediaItem, SecurityCheckResult, SecurityConfig, SceneType } from "./types";
import type { CreateTaskClient } from "./client";

// ==================== 模块级状态（熔断降级） ====================
// 以下变量维护熔断器的运行状态，模块级单例，所有审核调用共享。

/** 是否处于降级模式（熔断已触发） */
let isDegraded = false;
/** 是否正在进行探测请求（防止并发探测） */
let isProbing = false;
/** 连续失败次数，达到 failureThreshold 时触发熔断 */
let consecutiveFailures = 0;
/** 上次探测时间（毫秒时间戳），用于计算下次探测时机 */
let lastRetryTime = 0;

/** 触发熔断的连续失败次数阈值，默认 3 次 */
let failureThreshold = 3;
/** 熔断后首次探测等待时间（毫秒），默认 60 秒 */
let baseRetryIntervalMs = 60 * 1000;
/** 当前探测等待时间（毫秒），每次探测失败后指数增长 */
let currentRetryIntervalMs = baseRetryIntervalMs;
/** 探测等待时间上限（毫秒），默认 1 小时，防止无限增长 */
let maxRetryIntervalMs = 3600 * 1000;
/** ResultTypeLevel > 此值时判定为打击，默认 200 */
let blockLevel = 200;

/**
 * 更新安全/降级配置
 *
 * 在插件 register 阶段调用，将插件配置（PluginConfig）中的参数同步到模块级变量。
 * 未传入的字段保持默认值不变。
 *
 * @param config - 安全配置对象（SecurityConfig）
 */
export const setSecurityConfig = (config: SecurityConfig): void => {
  if (config.failureThreshold !== undefined) failureThreshold = config.failureThreshold;
  if (config.baseRetryIntervalMs !== undefined) {
    baseRetryIntervalMs = config.baseRetryIntervalMs;
    // 重置当前重试间隔，避免旧值影响新配置
    currentRetryIntervalMs = baseRetryIntervalMs;
  }
  if (config.maxRetryIntervalMs !== undefined) maxRetryIntervalMs = config.maxRetryIntervalMs;
  if (config.blockLevel !== undefined) blockLevel = config.blockLevel;
};


export const checkContentSecurity = async (
  api: any,
  client: CreateTaskClient,
  scene: SceneType,
  media: MediaItem[],
  sessionId: string,
  sessionType: SessionType,
  source: string,
  enableLogging: boolean,
  logTag: string = "",
  qaid?: string,
): Promise<SecurityCheckResult> => {
  // 降级/错误时的默认返回值：不打击（放行）
  const passResult: SecurityCheckResult = { blocked: false, labels: {} };

  // ==================== 降级模式处理 ====================
  if (isDegraded) {
    const now = Date.now();

    // 判断是否到了探测时机，且当前没有正在进行的探测请求
    if (now - lastRetryTime > currentRetryIntervalMs && !isProbing) {
      isProbing = true;
      try {
        // 发送最简探测请求（固定内容 "hello"），验证接口是否恢复
        await client.createTask(
          scene,
          [{ Data: "hello", MediaType: "Text" }],
          sessionId,
          SessionType.QUESTION,
        );

        // 探测成功：恢复正常模式，重置所有熔断状态
        isDegraded = false;
        isProbing = false;
        consecutiveFailures = 0;
        currentRetryIntervalMs = baseRetryIntervalMs;
        // 探测成功后继续执行正常审核（不 return，让代码继续往下走）
      } catch {
        // 探测失败：更新下次探测时间，指数增长等待间隔（上限 maxRetryIntervalMs）
        lastRetryTime = Date.now();
        isProbing = false;
        currentRetryIntervalMs = Math.min(currentRetryIntervalMs * 2, maxRetryIntervalMs);
        // 探测失败：继续降级，直接返回放行结果
        return passResult;
      }
    } else {
      // 还未到探测时机，或正在探测中：直接返回放行结果
      return passResult;
    }
  }

  // ==================== 正常审核请求 ====================

  // 记录审核前的日志（仅在 enableLogging=true 时输出）
  //   recordLogEvent(
  //   api,
  //   logTag,
  //   `${source}(check)`,
  //   { scene, sessionId, sessionType, mediaCount: media.length },
  //   enableLogging,
  // );

  let attempt = 0;
  const maxAttempts = 2; // 最多尝试 2 次（1 次正常 + 1 次重试）

  while (attempt < maxAttempts) {
    try {
      const response = await client.createTask(scene, media, sessionId, sessionType, qaid);

      // 记录审核结果日志
      // recordLogEvent(api, logTag, `${source}(result)`, { response }, enableLogging);

      // 审核成功：重置连续失败计数和重试间隔
      consecutiveFailures = 0;
      currentRetryIntervalMs = baseRetryIntervalMs;

      const data = response.data;
      if (!data) {
        // 响应体中没有 data 字段（接口异常），默认放行
        return passResult;
      }

      // 解析一级标签（ResultFirstLabel 是 JSON 字符串，需要手动解析）
      let labels: Record<string, any> = {};
      if (data.ResultFirstLabel) {
        try {
          labels = JSON.parse(data.ResultFirstLabel);
        } catch {
          // 解析失败忽略，labels 保持空对象
        }
      }

      // 打击判断（满足任一条件即打击）：
      // 方式1：ResultCode === 1（接口明确返回打击）
      // 方式2：ResultTypeLevel > blockLevel（等级超过阈值才打击，等于阈值不打击）
      const blocked =
        data.ResultCode === ResultCode.BLOCK ||
        (data.ResultTypeLevel !== undefined && data.ResultTypeLevel > blockLevel);

      const result: SecurityCheckResult = {
        blocked,
        level: data.ResultTypeLevel,
        resultType: data?.ResultType,
        labels,
        traceId: data.TraceID, // TraceID 用于向信安团队排查问题
      };

      if (blocked) {
        // 被打击
      }

      return result;
    } catch (error: any) {
      attempt++;

      // 判断是否为可重试的瞬时错误：
      // - AbortError：请求超时（AbortController.abort() 触发）
      // - 5xx：服务端临时错误
      const isTimeout = error?.name === "AbortError" || error?.message?.includes("timeout");
      const isTransient = isTimeout || (error?.status >= 500 && error?.status < 600);
      const errorMsg = isTimeout ? "请求超时" : String(error);

      if (isTransient && attempt < maxAttempts) {
        // 瞬时错误且还有重试机会：等待 500ms 后重试
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      // 不可重试的错误（或已达最大重试次数）：累加连续失败计数
      consecutiveFailures++;
      // recordLogEvent(
      //   api,
      //   logTag,
      //   `${source}(error)`,
      //   { error: errorMsg, consecutiveFailures },
      //   enableLogging,
      // );

      // 连续失败达到阈值：触发熔断，进入降级模式
      if (consecutiveFailures >= failureThreshold) {
        isDegraded = true;
        lastRetryTime = Date.now();
      }

      // 错误时返回放行结果（降级策略：不打击）
      return passResult;
    }
  }

  // while 循环正常退出（理论上不会到达这里），兜底返回放行
  return passResult;
};
