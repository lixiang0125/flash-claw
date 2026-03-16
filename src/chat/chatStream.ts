/**
 * chatStream 独立模块 —— 为 ChatEngine 提供流式 LLM 调用能力。
 *
 * 设计理念：不修改 ChatEngine 主类代码，通过组合方式扩展。
 * FeishuBot 在需要流式输出时直接调用此函数。
 *
 * @see ChatEngine.chat() 的流式版本
 */

import OpenAI from "openai";
import type { StreamCallbacks } from "./types";

/**
 * 使用 OpenAI SDK 的 stream 模式进行流式对话。
 *
 * 与 ChatEngine.chat() 的区别：
 * - 不执行工具调用循环（流式场景优先返回文本）
 * - 通过 StreamCallbacks 实时推送文本 delta
 * - 不修改会话历史（由调用方决定是否持久化）
 *
 * @param client     OpenAI 客户端实例
 * @param messages   完整的消息历史（含 system prompt）
 * @param callbacks  流式回调
 * @param model      模型名称
 */
export async function streamChat(
  client: OpenAI,
  messages: Array<{ role: string; content: string; [key: string]: any }>,
  callbacks: StreamCallbacks,
  model?: string,
): Promise<string> {
  const modelName = model || process.env.MODEL || "qwen-plus";
  let fullText = "";

  try {
    const stream = await client.chat.completions.create({
      model: modelName,
      messages: messages as any,
      stream: true,
      temperature: 0.7,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        try {
          await callbacks.onDelta(delta, fullText);
        } catch (err) {
          // onDelta 回调失败不应中断流
          console.error("[streamChat] onDelta callback error:", err);
        }
      }
    }

    await callbacks.onDone(fullText);
    return fullText;
  } catch (error: any) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (callbacks.onError) {
      await callbacks.onError(err);
    }
    throw err;
  }
}
