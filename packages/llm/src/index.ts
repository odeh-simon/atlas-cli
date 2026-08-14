export const llmPackage = "@atlas/llm";

export type AiProviderKind = "ollama" | "openai-compatible";
export type AiProviderPreset = "hetzner-inference";
export type AiDataKind = "code-context" | "image";

export interface AiProviderConfig {
  readonly alias: string;
  readonly provider: AiProviderKind;
  readonly baseUrl: string;
  readonly model: string;
  readonly tokenAlias?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxInputTokens?: number | undefined;
  readonly preset?: AiProviderPreset | undefined;
}

export interface AiProviderHealth {
  readonly alias: string;
  readonly provider: AiProviderKind;
  readonly configured: boolean;
  readonly status: "configured" | "unreachable" | "invalid";
  readonly model: string;
  readonly baseUrl: string;
  readonly detail: string;
}

export interface AiModel {
  readonly name: string;
  readonly modifiedAt?: string | undefined;
}

export interface AiCompletionMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface AiCompletionRequest {
  readonly provider: AiProviderConfig;
  readonly messages: readonly AiCompletionMessage[];
  readonly temperature?: number | undefined;
  readonly responseFormat?: "json" | "text" | undefined;
  readonly apiKey?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface AiCompletionResponse {
  readonly providerAlias: string;
  readonly model: string;
  readonly content: string;
}

export interface AiProviderRuntimeOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly apiKey?: string | undefined;
}

export async function getAiProviderHealth(
  provider: AiProviderConfig,
  options: AiProviderRuntimeOptions = {}
): Promise<AiProviderHealth> {
  const validation = validateProviderConfig(provider);
  if (validation !== undefined) {
    return {
      alias: provider.alias,
      provider: provider.provider,
      configured: false,
      status: "invalid",
      model: provider.model,
      baseUrl: provider.baseUrl,
      detail: validation
    };
  }

  if (provider.provider === "openai-compatible" && provider.tokenAlias !== undefined && options.apiKey === undefined) {
    return {
      alias: provider.alias,
      provider: provider.provider,
      configured: false,
      status: "invalid",
      model: provider.model,
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      detail: `credential missing: ${provider.tokenAlias}`
    };
  }

  try {
    const models = await listAiModels(provider, options);
    const hasModel = models.some((model) => model.name === provider.model);
    return {
      alias: provider.alias,
      provider: provider.provider,
      configured: hasModel,
      status: hasModel ? "configured" : "unreachable",
      model: provider.model,
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      detail: hasModel ? `${provider.provider} model available` : `${provider.provider} model not found: ${provider.model}`
    };
  } catch (error) {
    return {
      alias: provider.alias,
      provider: provider.provider,
      configured: false,
      status: "unreachable",
      model: provider.model,
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      detail: error instanceof Error ? redactSecretText(error.message) : `${provider.provider} health check failed`
    };
  }
}

export async function listAiModels(
  provider: AiProviderConfig,
  options: AiProviderRuntimeOptions = {}
): Promise<readonly AiModel[]> {
  assertSupportedProvider(provider);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (provider.provider === "openai-compatible") {
    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(provider.baseUrl)}/models`,
      { method: "GET", headers: authHeaders(options.apiKey) },
      provider.timeoutMs,
      fetchImpl
    );
    if (!response.ok) {
      throw new Error(`OpenAI-compatible model request failed: ${response.status}`);
    }
    const payload = asRecord(await response.json(), "OpenAI-compatible model response must be an object");
    const models = Array.isArray(payload.data) ? payload.data : [];
    return models.map(normalizeOpenAiModel).sort((a, b) => a.name.localeCompare(b.name));
  }

  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(provider.baseUrl)}/api/tags`,
    { method: "GET" },
    provider.timeoutMs,
    fetchImpl
  );
  if (!response.ok) {
    throw new Error(`Ollama model request failed: ${response.status}`);
  }
  const payload = asRecord(await response.json(), "Ollama model response must be an object");
  const models = Array.isArray(payload.models) ? payload.models : [];
  return models.map(normalizeOllamaModel).sort((a, b) => a.name.localeCompare(b.name));
}

export async function createAiCompletion(input: AiCompletionRequest): Promise<AiCompletionResponse> {
  assertSupportedProvider(input.provider);
  const fetchImpl = input.fetchImpl ?? fetch;
  if (input.provider.provider === "openai-compatible") {
    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(input.provider.baseUrl)}/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(input.apiKey) },
        body: JSON.stringify({
          model: input.provider.model,
          messages: input.messages,
          temperature: input.temperature,
          response_format: input.responseFormat === "json" ? { type: "json_object" } : undefined
        })
      },
      input.provider.timeoutMs,
      fetchImpl
    );
    if (!response.ok) {
      throw new Error(`OpenAI-compatible completion request failed: ${response.status}`);
    }
    const payload = asRecord(await response.json(), "OpenAI-compatible completion response must be an object");
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = asRecord(choices[0], "OpenAI-compatible completion choice must be an object");
    const message = asRecord(choice.message, "OpenAI-compatible completion message must be an object");
    return {
      providerAlias: input.provider.alias,
      model: input.provider.model,
      content: typeof message.content === "string" ? message.content : ""
    };
  }

  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(input.provider.baseUrl)}/api/chat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: input.provider.model,
        stream: false,
        messages: input.messages,
        options: input.temperature === undefined ? undefined : { temperature: input.temperature },
        format: input.responseFormat === "json" ? "json" : undefined
      })
    },
    input.provider.timeoutMs,
    fetchImpl
  );
  if (!response.ok) {
    throw new Error(`Ollama completion request failed: ${response.status}`);
  }
  const payload = asRecord(await response.json(), "Ollama completion response must be an object");
  const message = asRecord(payload.message, "Ollama completion response message must be an object");
  const content = typeof message.content === "string" ? message.content : "";
  return {
    providerAlias: input.provider.alias,
    model: input.provider.model,
    content
  };
}

export function redactSecretText(value: string): string {
  return value.replace(/(?:Bearer\s+)?[A-Za-z0-9_=-]{32,}/g, "[REDACTED]");
}

export function defaultOllamaProvider(): AiProviderConfig {
  return {
    alias: "ollama.local",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    model: "qwen2.5-coder:7b",
    timeoutMs: 10_000
  };
}

export function defaultHetznerProvider(input: {
  readonly alias?: string | undefined;
  readonly tokenAlias?: string | undefined;
} = {}): AiProviderConfig {
  return {
    alias: input.alias ?? "hetzner.default",
    provider: "openai-compatible",
    preset: "hetzner-inference",
    baseUrl: "https://inference.hetzner.com/api/v1",
    model: "Qwen/Qwen3.6-35B-A3B-FP8",
    tokenAlias: input.tokenAlias ?? "hetzner.default",
    timeoutMs: 120_000,
    maxInputTokens: 120_000
  };
}

export function isCloudAiProvider(provider: AiProviderConfig): boolean {
  const hostname = new URL(provider.baseUrl).hostname.toLowerCase();
  return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
}

export function assertAiDataConsent(
  provider: AiProviderConfig,
  dataKind: AiDataKind,
  consent: boolean | undefined
): void {
  if (!isCloudAiProvider(provider) || consent === true) return;
  const setting = dataKind === "image" ? "ai.allowCloudImages" : "ai.allowCloudCodeContext";
  throw new Error(`Cloud AI provider ${provider.alias} requires explicit ${setting}=true consent`);
}

function validateProviderConfig(provider: AiProviderConfig): string | undefined {
  if (!/^[A-Za-z0-9_.:-]+$/.test(provider.alias)) return "Invalid provider alias";
  if (provider.provider !== "ollama" && provider.provider !== "openai-compatible") return "Invalid provider kind";
  if (provider.model.trim().length === 0) return "Model is required";
  try {
    const url = new URL(provider.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Provider baseUrl must be HTTP(S)";
  } catch {
    return "Provider baseUrl must be a valid URL";
  }
  if (provider.timeoutMs !== undefined && provider.timeoutMs < 1) return "timeoutMs must be positive";
  if (provider.maxInputTokens !== undefined && provider.maxInputTokens < 1) return "maxInputTokens must be positive";
  if (provider.preset !== undefined && provider.preset !== "hetzner-inference") return "Invalid provider preset";
  return undefined;
}

function assertSupportedProvider(provider: AiProviderConfig): void {
  const validation = validateProviderConfig(provider);
  if (validation !== undefined) throw new TypeError(validation);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  fetchImpl: typeof fetch
): Promise<Response> {
  if (timeoutMs === undefined) return await fetchImpl(url, init);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOllamaModel(value: unknown): AiModel {
  const record = asRecord(value, "Ollama model must be an object");
  const name = typeof record.name === "string" ? record.name : "";
  if (name.length === 0) throw new TypeError("Ollama model name is required");
  return {
    name,
    ...(typeof record.modified_at === "string" ? { modifiedAt: record.modified_at } : {})
  };
}

function normalizeOpenAiModel(value: unknown): AiModel {
  const record = asRecord(value, "OpenAI-compatible model must be an object");
  const name = typeof record.id === "string" ? record.id : "";
  if (name.length === 0) throw new TypeError("OpenAI-compatible model id is required");
  return { name };
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new TypeError(message);
  return value as Record<string, unknown>;
}
