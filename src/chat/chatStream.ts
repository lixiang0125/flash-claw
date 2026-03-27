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
import { resolveOpenAICompatibleConfig } from "../infra/llm/openai-compatible";

interface StreamMessage {
  role: string;
  content: string | null;
}

interface StreamToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: unknown;
  };
}

interface StreamToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface StreamToolCallAccumulator {
  id: string;
  name: string;
  argumentsText: string;
}

interface StreamToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsText?: string;
}

interface StreamChunkDelta {
  content: string;
  toolCalls: StreamToolCallDelta[];
}

export interface StreamChatResult {
  content: string;
  toolCalls: StreamToolCall[];
}

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readStreamChunkDelta(chunk: unknown): StreamChunkDelta {
  const chunkRecord = getObjectRecord(chunk);
  const choices = Array.isArray(chunkRecord?.["choices"])
    ? chunkRecord["choices"]
    : [];
  const firstChoice = getObjectRecord(choices[0]);
  const deltaRecord = getObjectRecord(firstChoice?.["delta"]);
  const content = typeof deltaRecord?.["content"] === "string"
    ? deltaRecord["content"]
    : "";
  const rawToolCalls = Array.isArray(deltaRecord?.["tool_calls"])
    ? deltaRecord["tool_calls"]
    : [];
  const toolCalls: StreamToolCallDelta[] = [];

  for (const rawToolCall of rawToolCalls) {
    const toolCallRecord = getObjectRecord(rawToolCall);
    const functionRecord = getObjectRecord(toolCallRecord?.["function"]);
    const index = toolCallRecord?.["index"];

    if (typeof index !== "number") {
      continue;
    }

    toolCalls.push({
      index,
      id: typeof toolCallRecord?.["id"] === "string" ? toolCallRecord["id"] : undefined,
      name: typeof functionRecord?.["name"] === "string" ? functionRecord["name"] : undefined,
      argumentsText:
        typeof functionRecord?.["arguments"] === "string"
          ? functionRecord["arguments"]
          : undefined,
    });
  }

  return {
    content,
    toolCalls,
  };
}

/**
 * 将流式 chunk 中拆分返回的 tool_call 片段重新组装为完整函数调用。
 */
function buildToolCalls(accumulators: Map<number, StreamToolCallAccumulator>): StreamToolCall[] {
  return Array.from(accumulators.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([index, accumulator]) => ({
      id: accumulator.id || `stream_tool_call_${index}`,
      type: "function" as const,
      function: {
        name: accumulator.name,
        arguments: accumulator.argumentsText,
      },
    }))
    .filter((toolCall) => toolCall.function.name.length > 0);
}

/**
 * 使用 OpenAI SDK 的 stream 模式进行流式对话。
 *
 * 返回单轮 assistant 输出：既支持普通文本流，也支持带 tool_calls 的流式响应。
 * ChatEngine 会基于返回的 toolCalls 继续执行工具循环，因此流式路径也可以驱动浏览器等工具。
 *
 * @param client     OpenAI 客户端实例
 * @param messages   完整的消息历史（含 system prompt）
 * @param callbacks  流式回调
 * @param model      模型名称
 */
export async function streamChat(
  client: OpenAI,
  messages: StreamMessage[],
  callbacks: StreamCallbacks,
  model?: string,
  tools?: StreamToolDefinition[],
  initialText: string = "",
): Promise<StreamChatResult> {
  const modelName = model || resolveOpenAICompatibleConfig().model;
  let fullText = "";
  const toolCallAccumulators = new Map<number, StreamToolCallAccumulator>();

  try {
    const stream = await client.chat.completions.create({
      model: modelName,
      messages: messages as never,
      stream: true,
      temperature: 0.7,
      tools: tools as never,
    });

    for await (const chunk of stream) {
      const delta = readStreamChunkDelta(chunk);

      if (delta.content) {
        fullText += delta.content;
        try {
          await callbacks.onDelta(delta.content, `${initialText}${fullText}`);
        } catch (err) {
          // onDelta 回调失败不应中断流
          console.error("[streamChat] onDelta callback error:", err);
        }
      }

      for (const toolCallDelta of delta.toolCalls) {
        const current = toolCallAccumulators.get(toolCallDelta.index) ?? {
          id: "",
          name: "",
          argumentsText: "",
        };

        if (toolCallDelta.id) {
          current.id = toolCallDelta.id;
        }

        if (toolCallDelta.name) {
          current.name += toolCallDelta.name;
        }

        if (toolCallDelta.argumentsText) {
          current.argumentsText += toolCallDelta.argumentsText;
        }

        toolCallAccumulators.set(toolCallDelta.index, current);
      }
    }

    return {
      content: fullText,
      toolCalls: buildToolCalls(toolCallAccumulators),
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (callbacks.onError) {
      await callbacks.onError(err);
    }
    throw err;
  }
}
