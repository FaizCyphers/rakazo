import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observedPiStream } from "./pi-usage.js";

/**
 * A bot's thread outlives the model that started it: a chat or routine can move between
 * providers from one turn to the next. One transcript that already holds replies, thinking and
 * tool calls from three providers must reach each of them with every call paired to its result,
 * the earlier answers intact and no other model's private reasoning.
 */

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function reply(
  provider: string,
  api: Api,
  model: string,
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    provider,
    api,
    model,
    content,
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function result(toolCallId: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "lookup",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
  };
}

// Ids in each provider's native shape: the OpenAI Responses id is long and carries a `|`,
// which other APIs refuse.
const ANTHROPIC_CALL = "toolu_01FixtureAnthropicCall";
const OPENAI_CALL = `call_fixture|fc_${"a".repeat(60)}`;
const GOOGLE_CALL = "lookup_fixture_google";

const transcript: Message[] = [
  { role: "user", content: "Find the launch date.", timestamp: 1 },
  reply("anthropic", "anthropic-messages", "claude-haiku-5-5", [
    {
      type: "thinking",
      thinking: "Anthropic private reasoning.",
      thinkingSignature: "anthropic-signature",
    },
    { type: "toolCall", id: ANTHROPIC_CALL, name: "lookup", arguments: { q: "launch" } },
  ]),
  result(ANTHROPIC_CALL, "Launch is March 3."),
  { role: "user", content: "And the price?", timestamp: 3 },
  reply("openai", "openai-responses", "gpt-6-luna", [
    { type: "thinking", thinking: "OpenAI private reasoning.", thinkingSignature: "{}" },
    { type: "toolCall", id: OPENAI_CALL, name: "lookup", arguments: { q: "price" } },
  ]),
  result(OPENAI_CALL, "Price is 20 dollars."),
  { role: "user", content: "Who is the owner?", timestamp: 4 },
  reply("google", "google-generative-ai", "gemini-3.8-flash", [
    { type: "thinking", thinking: "Google private reasoning.", thinkingSignature: "Z29vZ2xl" },
    {
      type: "toolCall",
      id: GOOGLE_CALL,
      name: "lookup",
      arguments: { q: "owner" },
      thoughtSignature: "Z29vZ2xl",
    },
  ]),
  result(GOOGLE_CALL, "Owner is the platform team."),
  { role: "user", content: "Summarize everything.", timestamp: 5 },
];

const context: Context = {
  systemPrompt: "You are a fixture bot.",
  messages: transcript,
  tools: [
    {
      name: "lookup",
      description: "Look something up.",
      parameters: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      } as never,
    },
  ],
};

const targets: Array<{ provider: string; id: string }> = [
  { provider: "anthropic", id: "claude-haiku-5-5" },
  { provider: "openai", id: "gpt-6-luna" },
  { provider: "google", id: "gemini-3.8-flash" },
];

function catalogModel(provider: string, id: string): Model<Api> {
  const model = builtinModels().getModel(provider, id);
  if (!model) throw new Error(`fixture model ${provider}/${id} is not in the catalog`);
  return { ...model, baseUrl: "https://model.example.test" } as Model<Api>;
}

/** The body the provider would have received; the request itself is refused offline. */
async function payloadFor(model: Model<Api>): Promise<string> {
  let payload: unknown;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ error: { message: "offline fixture" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  const events = observedPiStream(
    builtinModels(),
    model,
    context,
    {
      apiKey: "fixture-key",
      maxRetries: 0,
      onPayload: (params: unknown) => {
        payload = params;
        return undefined;
      },
    },
    () => undefined,
  );
  await events.result();
  if (payload === undefined) throw new Error(`no request was built for ${model.provider}`);
  return JSON.stringify(payload);
}

/** Every tool call id in a request body and every id its results answer, per wire format. */
function callPairs(provider: string, body: string) {
  const json = JSON.parse(body);
  if (provider === "anthropic") {
    const blocks = json.messages.flatMap((m: { content: unknown }) =>
      Array.isArray(m.content) ? m.content : [],
    );
    return {
      calls: blocks
        .filter((b: { type: string }) => b.type === "tool_use")
        .map((b: { id: string }) => b.id),
      results: blocks
        .filter((b: { type: string }) => b.type === "tool_result")
        .map((b: { tool_use_id: string }) => b.tool_use_id),
    };
  }
  if (provider === "openai") {
    const input = json.input as Array<{ type?: string; call_id?: string }>;
    return {
      calls: input.filter((i) => i.type === "function_call").map((i) => i.call_id),
      results: input.filter((i) => i.type === "function_call_output").map((i) => i.call_id),
    };
  }
  const parts = json.contents.flatMap((c: { parts: unknown[] }) => c.parts) as Array<{
    functionCall?: { id?: string; name: string };
    functionResponse?: { id?: string; name: string };
  }>;
  return {
    calls: parts
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall?.id ?? p.functionCall?.name),
    results: parts
      .filter((p) => p.functionResponse)
      .map((p) => p.functionResponse?.id ?? p.functionResponse?.name),
  };
}

describe("a thread that moves between providers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(targets)("reaches $provider with its whole history", async ({ provider, id }) => {
    const before = JSON.stringify(context);
    const body = await payloadFor(catalogModel(provider, id));

    // Every earlier answer and request is still there.
    for (const text of [
      "Find the launch date.",
      "Launch is March 3.",
      "Price is 20 dollars.",
      "Owner is the platform team.",
      "Summarize everything.",
    ]) {
      expect(body).toContain(text);
    }

    // All three earlier calls are sent, each answered by its own result.
    const { calls, results } = callPairs(provider, body);
    expect(calls).toHaveLength(3);
    expect(results).toEqual(calls);
    expect(body).toMatch(/q\\*":\\*"launch/);
    expect(body).toMatch(/q\\*":\\*"price/);
    expect(body).toMatch(/q\\*":\\*"owner/);

    // Another model's reasoning is never shown to this one.
    for (const source of ["Anthropic", "OpenAI", "Google"]) {
      if (source.toLowerCase() === provider) continue;
      expect(body).not.toContain(`${source} private reasoning.`);
    }

    // Anthropic only accepts short plain ids.
    if (provider === "anthropic") {
      for (const call of calls) expect(call).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }

    // The stored transcript is not rewritten for the provider.
    expect(JSON.stringify(context)).toBe(before);
  });
});
