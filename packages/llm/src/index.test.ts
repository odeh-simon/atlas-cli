import { describe, expect, it } from "vitest";

import {
  assertAiDataConsent,
  createAiCompletion,
  defaultHetznerProvider,
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

  it("lists OpenAI-compatible models with bearer auth", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const models = await listAiModels(
      {
        alias: "openrouter.default",
        provider: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "meta-llama/llama-3.1-8b-instruct:free",
        tokenAlias: "openrouter.default"
      },
      {
        apiKey: "sk_example_secret_token",
        fetchImpl: (async (url, init) => {
          calls.push({ url: String(url), init: init ?? {} });
          return new Response(JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha" }] }), { status: 200 });
        }) as typeof fetch
      }
    );

    expect(models).toEqual([{ name: "alpha" }, { name: "zeta" }]);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer sk_example_secret_token" });
  });

  it("creates OpenAI-compatible chat completions", async () => {
    const calls: Array<{ readonly body: unknown }> = [];
    const response = await createAiCompletion({
      provider: {
        alias: "cloud.default",
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        model: "free-model"
      },
      apiKey: "sk_example_secret_token",
      messages: [{ role: "user", content: "Rank files" }],
      responseFormat: "json",
      fetchImpl: (async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ choices: [{ message: { content: "{\"files\":[]}" } }] }), {
          status: 200
        });
      }) as typeof fetch
    });

    expect(response).toMatchObject({ providerAlias: "cloud.default", model: "free-model", content: "{\"files\":[]}" });
    expect(calls[0]?.body).toMatchObject({
      model: "free-model",
      response_format: { type: "json_object" }
    });
  });

  it("reports missing cloud credentials before making network calls", async () => {
    let called = false;
    const health = await getAiProviderHealth(
      {
        alias: "cloud.default",
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        model: "free-model",
        tokenAlias: "cloud.default"
      },
      {
        fetchImpl: (async () => {
          called = true;
          return new Response("{}");
        }) as typeof fetch
      }
    );

    expect(called).toBe(false);
    expect(health).toMatchObject({
      configured: false,
      status: "invalid",
      detail: "credential missing: cloud.default"
    });
  });

  it("redacts long secret-like text", () => {
    expect(redactSecretText("Bearer abcdefghijklmnopqrstuvwxyz1234567890")).toBe("[REDACTED]");
  });

  it("provides the official Hetzner inference preset", () => {
    expect(defaultHetznerProvider()).toEqual({
      alias: "hetzner.default",
      provider: "openai-compatible",
      preset: "hetzner-inference",
      baseUrl: "https://inference.hetzner.com/api/v1",
      model: "Qwen/Qwen3.6-35B-A3B-FP8",
      tokenAlias: "hetzner.default",
      timeoutMs: 120_000,
      maxInputTokens: 120_000
    });
  });

  it("requires explicit consent before sending code or images to cloud AI", () => {
    expect(() => assertAiDataConsent(defaultHetznerProvider(), "code-context", false)).toThrow(
      "ai.allowCloudCodeContext=true"
    );
    expect(() => assertAiDataConsent(defaultHetznerProvider(), "image", undefined)).toThrow("ai.allowCloudImages=true");
    expect(() => assertAiDataConsent(defaultOllamaProvider(), "code-context", false)).not.toThrow();
    expect(() => assertAiDataConsent(defaultHetznerProvider(), "code-context", true)).not.toThrow();
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
