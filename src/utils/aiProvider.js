function aiProviderConfig() {
  const provider = String(process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
  return {
    provider,
    geminiApiKey: String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim(),
    geminiModel: String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
    geminiBaseUrl: String(process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').trim(),
    ollamaBaseUrl: String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim(),
    ollamaModel: String(process.env.OLLAMA_MODEL || 'llama3.2:3b').trim(),
  };
}

async function aiStatus() {
  const config = aiProviderConfig();
  if (config.provider === 'gemini') {
    return {
      ready: Boolean(config.geminiApiKey),
      provider: config.provider,
      model: config.geminiModel,
      error: config.geminiApiKey ? '' : 'Set GEMINI_API_KEY to enable AI features.',
    };
  }

  if (config.provider !== 'ollama') {
    return {
      ready: false,
      provider: config.provider,
      model: '',
      error: 'Unsupported AI provider configuration.',
    };
  }

  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/tags`);
    if (!response.ok) {
      return {
        ready: false,
        provider: config.provider,
        model: config.ollamaModel,
        error: `Ollama returned ${response.status}`,
      };
    }
    const payload = await response.json();
    const models = Array.isArray(payload?.models) ? payload.models : [];
    const installed = models.some((entry) => {
      const name = String(entry?.name || '').trim();
      const model = String(entry?.model || '').trim();
      return name === config.ollamaModel || model === config.ollamaModel;
    });
    return {
      ready: installed,
      provider: config.provider,
      model: config.ollamaModel,
      error: installed ? '' : `Model "${config.ollamaModel}" is not installed in Ollama yet.`,
    };
  } catch (error) {
    return {
      ready: false,
      provider: config.provider,
      model: config.ollamaModel,
      error: `Could not reach Ollama at ${config.ollamaBaseUrl}. ${error.message}`,
    };
  }
}

function extractJson(text) {
  const source = String(text || '').trim();
  if (!source) throw new Error('AI response was empty.');
  try {
    return JSON.parse(source);
  } catch (_) {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(source.slice(start, end + 1));
    }
    throw new Error('AI response did not contain valid JSON.');
  }
}

async function ollamaChat(messages, { temperature = 0.2, format = null } = {}) {
  const config = aiProviderConfig();
  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ollamaModel,
      stream: false,
      format,
      messages,
      options: {
        temperature,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  return String(payload?.message?.content || '').trim();
}

async function geminiChat(system, messages, { temperature = 0.2, format = null } = {}) {
  const config = aiProviderConfig();
  if (!config.geminiApiKey) {
    throw new Error('Set GEMINI_API_KEY to enable Gemini AI.');
  }

  const contents = messages.map((entry) => ({
    role: entry.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(entry.content || '') }],
  }));

  const response = await fetch(
    `${config.geminiBaseUrl}/models/${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: system }],
        },
        contents,
        generationConfig: {
          temperature,
          responseMimeType: format === 'json' ? 'application/json' : 'text/plain',
        },
      }),
    }
  );

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gemini request failed (${response.status}).`);
  }

  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => String(part?.text || '')).join('').trim();
}

async function aiChatText({ system, history = [], user, temperature = 0.4 }) {
  const status = await aiStatus();
  if (!status.ready) {
    throw new Error(status.error || 'AI is not ready.');
  }

  const messages = [
    { role: 'system', content: system },
    ...history.map((entry) => ({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content: String(entry.content || ''),
    })),
    { role: 'user', content: user },
  ];

  if (status.provider === 'gemini') {
    return geminiChat(system, messages, { temperature });
  }
  return ollamaChat(messages, { temperature });
}

async function aiChatJson({ system, user, temperature = 0.2 }) {
  const status = await aiStatus();
  if (!status.ready) {
    throw new Error(status.error || 'AI is not ready.');
  }
  const messages = [{ role: 'user', content: user }];
  const text =
    status.provider === 'gemini'
      ? await geminiChat(system, messages, { temperature, format: 'json' })
      : await ollamaChat(
          [{ role: 'system', content: system }, ...messages],
          { temperature, format: 'json' }
        );
  return extractJson(text);
}

module.exports = {
  aiProviderConfig,
  aiStatus,
  aiChatText,
  aiChatJson,
};
