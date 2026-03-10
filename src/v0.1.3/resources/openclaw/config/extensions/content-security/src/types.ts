export const enum SessionType {
  QUESTION = 1,
  ANSWER = 2,
  ANSWER_END = 3,
}

export type MediaType =
  | "Text"       // 纯文本
  | "Picture"    // 图片（URL）
  | "Video"      // 视频（URL）
  | "Audio"      // 音频（URL）
  | "OutLink"    // 外链
  | "Livevideo"  // 直播视频
  | "File";      // 文件

export const enum ResultCode {
  PASS = 0,
  BLOCK = 1,
  PASS_2 = 2,
}


export type SceneType = "prompt" | "output";

/**
 */
export interface MediaItem {
  /** 审核内容。文本类型填实际文本；图片/音频/视频填 URL */
  Data: string;
  /** 媒体类型 */
  MediaType: MediaType;
}


export interface CreateTaskRequest {
  scene: SceneType;
  request_id: string;
  openclaw_channel_token: string;
  data: {
    Comm: {
      SendTime: number;
    };
    Content: {
      QAID?: string;
      SessionID: string;
      SessionType: SessionType;
      Msg: {
        Media: MediaItem[];
        MsgMap: Record<string, any>;
      };
    };
  };
}


export interface FirstLabelItem {
  uiLabel: number;
  uilevel: number;
  strMeaning: string;
}

export interface CreateTaskResponse {
  /** 通用响应头 */
  common: {
    code: number;
    message: string;
  };
  data: {
    ResultCode: number;
    ResultType?: number;
    ResultTypeLevel?: number;
    ResultMsg?: string;
    ResultFirstLabel?: string;
    ResultSecondLabel?: string;
    Operator?: string;
    WhiteBoxAnswer?: string;
    StdRetMsg?: string;
    StdRetCode?: number;
    TraceID?: string;
  } | null;
}

export interface CreateTaskClientOptions {
  endpoint: string;
  openclawChannelToken: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;

}

export interface PluginConfig {
  endpoint?: string;
  token?: string;
  openClawDir?: string;
  logRecord?: boolean;
  enableFetch?: boolean;
  enableBeforeToolCall?: boolean;
  enableAfterToolCall?: boolean;
  failureThreshold?: number;
  retryInterval?: number;
  maxRetryInterval?: number;
  timeoutMs?: number;
  blockLevel?: number;
}

export interface SecurityCheckResult {
  blocked: boolean;
  level?: number;
  resultType?: number;
  labels: Record<string, FirstLabelItem>;
  traceId?: string;
}


export interface SecurityConfig {
  failureThreshold?: number;
  baseRetryIntervalMs?: number;
  maxRetryIntervalMs?: number;
  blockLevel?: number;
}

export interface InterceptorConfig {
  api: any;
  client: any;
  enableLogging: boolean;
  shieldEndpoint: string;
}

export interface NormalizedMessage {
  role: string;
  content: string;
}
