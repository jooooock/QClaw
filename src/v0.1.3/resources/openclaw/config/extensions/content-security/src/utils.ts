import crypto from "node:crypto";
import type { NormalizedMessage } from "./types";

export const generateRequestId = (): string => {
  return crypto.randomUUID();
};


export const getCurrentTimestamp = (): number => {
  return Math.floor(Date.now() / 1000);
};

export const normalizeMessage = (message: any, format: string = "openai"): NormalizedMessage => {
  if (format === "openai") {
    let content = "";
    if (typeof message.content === "string") {
      // 简单字符串格式（最常见）
      content = message.content;
    } else if (Array.isArray(message.content)) {
      // 多模态格式：提取所有 type=text 的部分，用换行拼接
      content = message.content
        .filter((part: any) => part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n");
    }
    return {
      role: message.role || "",
      content,
    };
  }

  // 非 OpenAI 格式：content 直接转为字符串
  return {
    role: message.role || "",
    content:
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content || ""),
  };
};


export const extractLastUserMessage = (body: any): NormalizedMessage[] => {
  if (!body || typeof body !== "object") return [];

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const lastMessage = body.messages[body.messages.length - 1];
    const normalized = normalizeMessage(lastMessage, "openai");
    if (normalized.role !== "user") {
      return [];
    }
    if (normalized.content.length > 0) {
      return [normalized];
    }
    return [];
  }

  // 旧版 Completion API：prompt 字段
  if (typeof body.prompt === "string") return [{ role: "user", content: body.prompt }];
  // 自定义 API：input 字段
  if (typeof body.input === "string") return [{ role: "user", content: body.input }];

  return [];
};


export const sliceText = (text: string, maxLength: number): string[] => {
  if (text.length <= maxLength) {
    return [text];
  }

  const slices: string[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    slices.push(text.substring(i, i + maxLength));
  }
  return slices;
};


export const recordLogEvent = (
  _api: any,
  _tag: string,
  _hook: string,
  _data: any,
  _logRecord: boolean,
): void => {
  // 日志已禁用
};


export const injectSecurityMarker = (
  content: any,
  securityReason: string,
  blocked: boolean,
): any => {
  if (typeof content === "string") {
    if (blocked) {
      return securityReason;
    }
    return `${content}\n${securityReason}`;
  }

  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (part.type === "text" && typeof part.text === "string") {
        return {
          ...part,
          text: injectSecurityMarker(part.text, securityReason, blocked),
        };
      }
      // 非文本部分（图片、音频等）保持不变
      return part;
    });
  }

  // 其他类型（null、object 等）保持不变
  return content;
};


export const extractAssistantContent = (body: any): string => {
  if (!body || typeof body !== "object") return "";

  // OpenAI Chat Completion 格式
  if (Array.isArray(body.choices) && body.choices.length > 0) {
    const choice = body.choices[0];
    const message = choice.message;
    if (!message) return "";

    if (typeof message.content === "string") {
      return message.content;
    }
    // 多模态格式：提取所有 type=text 的部分
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part: any) => part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n");
    }
  }

  return "";
};
