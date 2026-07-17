import { describe, expect, it } from "vitest";

import {
  createAiCompletion,
  defaultOllamaProvider,
  getAiProviderHealth,
  listAiModels,
  redactSecretText
} from "./index.js";

describe("LLM provider foundation", () => {
  it("reports configured Ollama health when the configured model is available", async () => {
    const health = await getAiProviderHealth(defaultOllamaProvider(), {
      fetchImpl: jsonFetch({ models: [{ name: "qwen2.5-coder:7b", modified_at: "2026-01-01T00:00:00Z" }] })
    });

    expect(health).toMatchObject({
      alias: "ollama.local",
      provider: "ollama",
      configured: true,
      status: "configured",
      detail: "ollama model available"
    });
  });

  it("reports missing Ollama models as unreachable", async () => {
    const health = await getAiProviderHealth(defaultOllamaProvider(), {
      fetchImpl: jsonFetch({ models: [{ name: "llama3.2:3b" }] })
    });

    expect(health).toMatchObject({
      configured: false,
      status: "unreachable",
      detail: "ollama model not found: qwen2.5-coder:7b"
    });
  });

  it("lists Ollama models in stable order", async () => {
    const models = await listAiModels(defaultOllamaProvider(), {
      fetchImpl: jsonFetch({ models: [{ name: "zeta" }, { name: "alpha", modified_at: "now" }] })
    });

    expect(models).toEqual([{ name: "alpha", modifiedAt: "now" }, { name: "zeta" }]);
  });

  it("creates non-streaming Ollama chat completions", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const response = await createAiCompletion({
      provider: defaultOllamaProvider(),
      messages: [{ role: "user", content: "Rank files" }],
      responseFormat: "json",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ message: { content: "{\"ok\":true}" } }), { status: 200 });
      }) as typeof fetch
    });

    expect(response.content).toBe("{\"ok\":true}");
    expect(calls[0]?.url).toBe("http://localhost:11434/api/chat");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "qwen2.5-coder:7b",
      stream: false,
      format: "json"
    });
  });

  it("redacts long secret-like text", () => {
    expect(redactSecretText("Bearer abcdefghijklmnopqrstuvwxyz1234567890")).toBe("[REDACTED]");
  });

  it("rejects invalid provider config", async () => {
    const health = await getAiProviderHealth({
      alias: "bad alias",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "qwen"
    });

    expect(health).toMatchObject({ configured: false, status: "invalid", detail: "Invalid provider alias" });
  });
});

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch;
}
