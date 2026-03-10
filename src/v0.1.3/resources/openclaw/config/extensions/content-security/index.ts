import fs from "node:fs";
import path from "node:path";
import { SessionType } from "./src/types";
import type { PluginConfig } from "./src/types";
import { CreateTaskClient } from "./src/client";
import { setSecurityConfig, checkContentSecurity } from "./src/security";
import { setupFetchInterceptor } from "./src/interceptor";
import { getSessionId, getQAID } from "./src/session";
import { sliceText } from "./src/utils";

const OUTPUT_MAX_LENGTH = 120;

const LOG_TAG = "content-security";

const plugin = {
  id: "content-security",
  name: "内容安全",
  description: "内容安全",

  register(api: any) {
    const pluginCfg: PluginConfig = api.pluginConfig ?? {};
    const {
      endpoint,   // CreateTask 接口完整地址
      token,      // OpenClaw Channel Token，用于鉴权
    } = pluginCfg;

    // ----------------------------------------------------------
    // 1. 读取功能开关配置
    // ----------------------------------------------------------
    const logRecord = Boolean(pluginCfg.logRecord);
    const enableFetch = pluginCfg.enableFetch !== false;
    const enableBeforeToolCall = pluginCfg.enableBeforeToolCall !== false;
    const enableAfterToolCall = pluginCfg.enableAfterToolCall !== false;


    let stateDir: string;
    if (pluginCfg.openClawDir) {
      stateDir = pluginCfg.openClawDir;
    } else {
      try {
        stateDir = api.runtime.state.resolveStateDir();
      } catch {
        stateDir = "";
      }
    }


    setSecurityConfig({
      failureThreshold: pluginCfg.failureThreshold,
      baseRetryIntervalMs: pluginCfg.retryInterval
        ? pluginCfg.retryInterval * 1000
        : undefined,
      maxRetryIntervalMs: pluginCfg.maxRetryInterval
        ? pluginCfg.maxRetryInterval * 1000
        : undefined,
      blockLevel: pluginCfg.blockLevel,
    });

    // ----------------------------------------------------------
    //    endpoint 和 token 缺一不可，任意为空则插件无法正常工作，直接退出注册。
    // ----------------------------------------------------------
    if (!endpoint || !token) {
      return;
    }

    const originalFetch = globalThis.fetch;

    const client = new CreateTaskClient({
      endpoint,
      openclawChannelToken: token,
      timeoutMs: pluginCfg.timeoutMs,
      fetchFn: originalFetch, // 使用原始 fetch，绕过拦截器
    });


    (async () => {

      if (enableFetch) {
        setupFetchInterceptor(
          {
            api,
            client,
            enableLogging: logRecord,
            shieldEndpoint: endpoint, // 用于过滤避免递归
          },
          LOG_TAG,
        );

      }


      if (enableBeforeToolCall) {
        api.on("before_tool_call", async (event: any, ctx: any) => {
          // agentId 和 sessionKey 是定位会话的必要信息，缺失则跳过
          if (!ctx?.agentId || !ctx?.sessionKey) return;

          const sessionKey = ctx.sessionKey;
          const sessionId = getSessionId(sessionKey);
          const qaid = getQAID(sessionKey);

          // 基础审核内容：工具名 + 序列化参数
          let content = `工具: ${event.toolName}, 参数: ${JSON.stringify(event.params)}`;

          /**
           * 尝试从会话 JSONL 文件中提取最近一条 assistant 消息里的 thinking 内容。
           */
          try {
            if (stateDir && ctx.agentId && ctx.sessionKey) {
              const sessionsJsonPath = path.join(
                stateDir,
                "agents",
                ctx.agentId,
                "sessions",
                "sessions.json",
              );

              if (fs.existsSync(sessionsJsonPath)) {
                const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8"));
                const sessionInfo = sessionsData[ctx.sessionKey];

                if (sessionInfo?.sessionFile) {
                  // sessionFile 可能是相对路径，需要相对于 sessions.json 所在目录解析
                  const fullSessionPath = path.isAbsolute(sessionInfo.sessionFile)
                    ? sessionInfo.sessionFile
                    : path.join(path.dirname(sessionsJsonPath), sessionInfo.sessionFile);

                  if (fs.existsSync(fullSessionPath)) {
                    const sessionContent = fs.readFileSync(fullSessionPath, "utf-8");
                    // JSONL 格式：每行一条 JSON 记录，过滤空行
                    const lines = sessionContent.split("\n").filter((l) => l.trim());

                    // 从末尾向前找，取最近一条匹配的 assistant 消息
                    for (let i = lines.length - 1; i >= 0; i--) {
                      try {
                        const item = JSON.parse(lines[i]);
                        if (
                          item.type === "message" &&
                          item.message?.role === "assistant" &&
                          Array.isArray(item.message.content)
                        ) {
                          // 确认该消息包含当前工具调用（名称 + 参数完全匹配）
                          const matchedToolCall = item.message.content.find(
                            (c: any) =>
                              c.type === "toolCall" &&
                              c.name === event.toolName &&
                              JSON.stringify(c.arguments) === JSON.stringify(event.params),
                          );
                          const thinking = item.message.content.find(
                            (c: any) => c.type === "thinking",
                          );
                          if (matchedToolCall && thinking) {
                            // 将 thinking 内容前置，让审核服务能感知模型的推理意图
                            content = `${thinking.thinking || ""}\n${content}`;
                            break;
                          }
                        }
                      } catch {
                        // 单行解析失败（如截断行），跳过继续
                      }
                    }
                  }
                }
              }
            }
          } catch (e) {

          }

          const contentToCheck = sliceText(content, 4000)[0];

          const result = await checkContentSecurity(
            api,
            client,
            "prompt",
            [{ Data: contentToCheck, MediaType: "Text" }],
            sessionId,
            SessionType.QUESTION,
            "before_tool_call",
            logRecord,
            LOG_TAG,
            qaid,
          );

          // 审核不通过：阻断工具调用，返回 block 信号
          if (result.blocked) {
            return { block: true, blockReason: "请换个问题提问。" };
          }
        });


      }

      if (enableAfterToolCall) {
        api.on("after_tool_call", async (event: any, ctx: any) => {
          // 有 durationMs 说明是第二次回调，跳过
          if (event.durationMs) return;

          const sessionKey = ctx?.sessionKey || "default";
          const sessionId = getSessionId(sessionKey);
          const qaid = getQAID(sessionKey);

          const content = `工具: ${event.toolName}\n参数: ${JSON.stringify(event.params)}\n结果: ${JSON.stringify(event.result)}`;

          const slices = sliceText(content, OUTPUT_MAX_LENGTH);
          let blocked = false;

          for (let i = 0; i < slices.length; i++) {
            const isLastSlice = i === slices.length - 1;
            const sessionType = isLastSlice ? SessionType.ANSWER_END : SessionType.ANSWER;

            const result = await checkContentSecurity(
              api,
              client,
              "output",
              [{ Data: slices[i], MediaType: "Text" }],
              sessionId,
              sessionType,
              "after_tool_call",
              logRecord,
              LOG_TAG,
              qaid,
            );

            if (result.blocked) {
              blocked = true;
              break;
            }
          }

          if (blocked) {
            const interceptedData = {
              error: "Intercepted",
              message: "请换个问题提问。",
            };
            event.result.content = [{ type: "text", text: JSON.stringify(interceptedData, null, 2) }];
            event.result.details = interceptedData;
          }
        });
      }
    })();
  },
};

export default plugin;