import type {
  CreateTaskClientOptions,
  CreateTaskRequest,
  CreateTaskResponse,
  MediaItem,
  SessionType,
  SceneType,
} from "./types";
import { generateRequestId, getCurrentTimestamp } from "./utils";

/**
 * HTTP 错误
 *
 * 当 CreateTask 接口返回非 200 状态码，或业务层返回 common.code !== 0 时抛出。
 * 调用方可通过 `instanceof HttpError` 区分网络/超时错误与 HTTP 错误。
 */
export class HttpError extends Error {
  /** HTTP 状态码，如 400、500 */
  status: number;
  /** HTTP 状态文本，如 "Bad Request" */
  statusText: string;
  /** 响应体（已尝试 JSON 解析，失败则为原始字符串） */
  body: any;

  constructor(message: string, status: number, statusText: string, body: any) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export class CreateTaskClient {
  private endpoint: string;
  private openclawChannelToken: string;
  private timeoutMs: number;
  /**
   * 实际使用的 fetch 函数。
   * 必须是拦截器注册前保存的原始 fetch，避免审核请求被自身拦截。
   */
  private fetchFn: typeof fetch;
  constructor(options: CreateTaskClientOptions) {
    this.endpoint = options.endpoint;
    this.openclawChannelToken = options.openclawChannelToken;
    this.timeoutMs = options.timeoutMs ?? 5000;

    // 优先使用调用方传入的 fetchFn（通常是拦截器注册前保存的原始 fetch）
    // 若未传则使用 globalThis.fetch，但此时需确保拦截器尚未注册
    const fn = options.fetchFn ?? globalThis.fetch;
    if (!fn) {
      throw new Error("global fetch 不可用，请提供 fetchFn 参数");
    }
    // bind(globalThis) 确保 fetch 在正确的 this 上下文中执行
    this.fetchFn = fn.bind(globalThis);
  }


  async createTask(
    scene: SceneType,
    media: MediaItem[],
    sessionId: string,
    sessionType: SessionType,
    qaid?: string,
  ): Promise<CreateTaskResponse> {
    // 每次请求生成唯一的 request_id，用于链路追踪
    const requestId = generateRequestId();

    const request: CreateTaskRequest = {
      scene,
      request_id: requestId,
      openclaw_channel_token: this.openclawChannelToken,
      data: {
        Comm: {
          // SendTime 要求秒级 Unix 时间戳
          SendTime: getCurrentTimestamp(),
        },
        Content: {
          SessionID: sessionId,
          SessionType: sessionType,
          Msg: {
            Media: media,
            MsgMap: {},
          },
          // QAID 仅在有值时传入，避免接口报参数错误
          ...(qaid ? { QAID: qaid } : {}),
        },
      },
    };

    const url = this.endpoint;
    // AbortController 用于实现请求超时：超时后 abort() 会让 fetch 抛出 AbortError
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    // 打印请求数据（含完整 URL 和请求体，便于排查问题）

    try {
      const resp = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      const text = await resp.text();

      // HTTP 状态码非 200 时，尝试解析响应体后抛出 HttpError
      if (resp.status !== 200) {
        let parsed: any = text;
        try {
          parsed = text ? JSON.parse(text) : text;
        } catch {
          // JSON 解析失败，保留原始文本作为 body
        }
        throw new HttpError(
          `CreateTask 请求失败，状态码 ${resp.status}`,
          resp.status,
          resp.statusText,
          parsed,
        );
      }

      try {
        const rawResponse = text ? JSON.parse(text) : {};
        const response: CreateTaskResponse = rawResponse?.data?.resp ?? rawResponse;

        if (response.common && response.common.code !== 0) {
          throw new HttpError(
            `CreateTask 业务错误: code=${response.common.code} - ${response.common.message}`,
            400,
            "Business Error",
            response,
          );
        }

        return response;
      } catch (e: any) {
        if (e instanceof HttpError) throw e;
        throw new Error(`JSON 解析失败: ${e.message}`, { cause: e });
      }
    } catch (e: any) {
      if (!(e instanceof HttpError)) {
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

}
