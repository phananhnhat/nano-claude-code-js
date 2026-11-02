// Nói chuyện với API của LLM. Mỗi provider có 2 hàm:
//   buildBody(...) → dựng body JSON gửi lên API (đây là "payload")
//   send(body)     → POST body đó, rồi đổi response về MỘT dạng chung:
//                    { stopReason: 'tool_use' | 'end_turn' | 'max_tokens', content: [block...], usage }
//
// Lịch sử `messages` luôn được giữ theo định dạng Anthropic (block text / tool_use / tool_result).
// Provider OpenAI chỉ DỊCH sang định dạng OpenAI ngay trước khi gửi, rồi dịch ngược khi nhận.
// Tương ứng agent.py (Anthropic) và openai_compat.py (OpenAI-compatible).

// Ngủ nhưng huỷ được ngay khi người dùng bấm Ctrl+C (signal bị abort).
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
const backoff = (attempt) => Math.min(1000 * 2 ** attempt + Math.random() * 1000, 60_000);
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

// POST JSON, thử lại tối đa 5 lần khi bị giới hạn tốc độ / lỗi server / lỗi mạng.
async function postJson(url, headers, body, { signal, maxRetries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e; // người dùng huỷ: không thử lại
      if (attempt < maxRetries) {
        await sleep(backoff(attempt), signal);
        continue;
      }
      throw new Error(`Network error: ${e.message}`);
    }
    if (res.ok) return res.json();

    if (RETRYABLE.has(res.status) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : backoff(attempt), signal);
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}

// ───────────────────────────────────────── Anthropic ─────────────────────────────────────────

// Đánh dấu cache_control lên block cuối của tin nhắn user cuối (giúp API tính rẻ phần lịch sử lặp lại).
// Không sửa mảng gốc, chỉ trả về bản sao.
function addCacheBreakpoint(messages) {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user') continue;
    const { content } = out[i];
    if (typeof content === 'string') {
      out[i] = { ...out[i], content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] };
    } else if (Array.isArray(content) && content.length > 0) {
      const blocks = [...content];
      const last = blocks[blocks.length - 1];
      if (!last.cache_control) blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
      out[i] = { ...out[i], content: blocks };
    }
    break;
  }
  return out;
}

export function anthropicProvider({ apiKey, baseUrl = 'https://api.anthropic.com', model, cache = true }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };

  return {
    name: 'anthropic',
    model,

    // Ba phần tách biệt: system, tools, messages (cộng model và max_tokens).
    buildBody({ system, tools, messages, maxTokens }) {
      return {
        model,
        max_tokens: maxTokens,
        system: cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system,
        tools,
        messages: cache ? addCacheBreakpoint(messages) : messages,
      };
    },

    async send(body, { signal } = {}) {
      const json = await postJson(url, headers, body, { signal });
      const u = json.usage ?? {};
      return {
        stopReason: json.stop_reason, // 'tool_use' khi model muốn gọi tool, 'end_turn' khi nói xong
        content: json.content, // mảng block: { type: 'text' } và/hoặc { type: 'tool_use' }
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          // Kích thước ngữ cảnh thật của request này. `input_tokens` của Anthropic chỉ đếm phần SAU điểm cache cuối cùng,
          // còn phần lấy từ cache và phần vừa ghi vào cache nằm ở hai trường khác; phải cộng cả ba mới ra tổng.
          context: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        },
      };
    },

    // Nhờ model tóm tắt một đoạn văn bản (dùng cho tự tóm tắt). Không có tools, không có lịch sử.
    async summarize({ system, prompt, maxTokens }, { signal } = {}) {
      const json = await postJson(
        url,
        headers,
        { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] },
        { signal },
      );
      return json.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    },
  };
}

// ───────────────────────────────── OpenAI-compatible (Chat Completions) ─────────────────────────────────

// Anthropic: { name, description, input_schema }  →  OpenAI: { type: 'function', function: { name, description, parameters } }
function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: (t.description ?? '').slice(0, 4096), parameters: t.input_schema },
  }));
}

// System prompt thành tin nhắn đầu tiên; tool_use thành tool_calls; tool_result thành tin nhắn role "tool".
function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
        continue;
      }
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: body }); // mỗi kết quả một tin nhắn riêng
        } else if (b.type === 'text') {
          out.push({ role: 'user', content: b.text });
        }
      }
    } else if (m.role === 'assistant') {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }, // OpenAI: arguments là CHUỖI JSON
        }));
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
}

// Dịch ngược: response OpenAI → các block giống Anthropic.
function fromOpenAIMessage(message) {
  const blocks = [];
  if (message.content) blocks.push({ type: 'text', text: message.content });
  for (const tc of message.tool_calls ?? []) {
    let input;
    try {
      input = JSON.parse(tc.function.arguments || '{}');
    } catch {
      input = { _raw_arguments: tc.function.arguments };
    }
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return blocks;
}

export function openaiProvider({ apiKey, baseUrl, model }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = { authorization: `Bearer ${apiKey}` };

  return {
    name: 'openai-compatible',
    model,

    // OpenAI chỉ có 2 trường: messages (system nằm trong đó) và tools.
    buildBody({ system, tools, messages, maxTokens }) {
      return {
        model,
        max_tokens: maxTokens,
        messages: toOpenAIMessages(system, messages),
        tools: toOpenAITools(tools),
        tool_choice: 'auto',
      };
    },

    async send(body, { signal } = {}) {
      const json = await postJson(url, headers, body, { signal });
      const choice = json.choices[0];
      const stopReason =
        choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
      const prompt = json.usage?.prompt_tokens ?? 0;
      return {
        stopReason,
        content: fromOpenAIMessage(choice.message),
        // OpenAI: prompt_tokens đã là tổng số token đầu vào (kể cả phần cache), nên cũng chính là kích thước ngữ cảnh.
        usage: { input: prompt, output: json.usage?.completion_tokens ?? 0, context: prompt },
      };
    },

    // Nhờ model tóm tắt một đoạn văn bản (dùng cho tự tóm tắt).
    async summarize({ system, prompt, maxTokens }, { signal } = {}) {
      const json = await postJson(
        url,
        headers,
        {
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        },
        { signal },
      );
      return (json.choices[0].message.content ?? '').trim();
    },
  };
}
