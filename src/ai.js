import { config } from "./config.js";

const failedOpenAiModels = new Set();

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, ms || 25000));
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

function outputTextFromOpenAi(data) {
  if (data?.output_text) return String(data.output_text).trim();
  const texts = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.text) texts.push(part.text);
    }
  }
  return texts.join("").trim();
}

async function generateOpenAiText(prompt, options = {}) {
  if (!config.openai.apiKey) return "";
  const models = [...new Set([options.model, ...(config.openai.models || []), config.openai.model].filter(Boolean))];
  let lastError = null;

  for (const model of models) {
    if (failedOpenAiModels.has(model)) continue;
    try {
      return await generateOpenAiTextWithModel(prompt, { ...options, model });
    } catch (error) {
      lastError = error;
      failedOpenAiModels.add(model);
      console.warn(`OpenAI model ${model} gagal, coba fallback berikutnya: ${error.message}`);
    }
  }

  if (lastError) throw lastError;
  return "";
}

async function generateOpenAiTextWithModel(prompt, options = {}) {
  const body = {
    model: options.model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }]
      }
    ],
    max_output_tokens: Math.max(16, Number(options.maxOutputTokens || 900))
  };
  if (!String(body.model).startsWith("gpt-5")) {
    body.temperature = options.temperature ?? config.openai.temperature;
  }

  const timeout = timeoutSignal(options.timeoutMs || config.openai.requestTimeoutMs);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: timeout.signal,
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }).finally(timeout.clear);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI request failed: ${response.status}`);
  }
  return outputTextFromOpenAi(data);
}

export async function generateAiText(prompt, options = {}) {
  try {
    const text = await generateOpenAiText(prompt, options);
    if (text) return text;
  } catch (error) {
    if (options.throwOnError) throw error;
    console.warn(`OpenAI AI provider gagal: ${error.message}`);
  }
  return "";
}
