// TỰ TÓM TẮT khi hội thoại quá dài. Tương ứng _needs_compaction() và compact_messages() trong nano_claude_code/agent.py.
//
// Vấn đề: lịch sử chỉ dài ra, mà model có giới hạn độ dài ngữ cảnh. Khi gần đầy, ta nhờ chính model tóm tắt phần CŨ
// thành vài đoạn, rồi thay phần cũ bằng bản tóm tắt đó. Phần MỚI (vài tin cuối) được giữ nguyên để model không mất mạch.
//
//   trước:  [m1][m2][m3] ... [m20][m21][m22][m23][m24][m25][m26]
//   sau:    [bản tóm tắt của m1..m20][m21][m22][m23][m24][m25][m26]

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const COMPACTION_THRESHOLD = 0.75; // vượt 75% cửa sổ ngữ cảnh thì tóm tắt
export const KEEP_RECENT = 6; // số tin cuối giữ nguyên (có thể nhiều hơn một chút, xem findKeepStart)
export const SUMMARY_PREFIX = '[Context from earlier in our conversation]';

const SUMMARY_SYSTEM = 'You are a helpful assistant that summarizes conversations concisely.';
const ACK = 'Understood. I have the context from our earlier conversation. Let me continue from where we left off.';

const isToolResultMessage = (m) =>
  m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
const isSummaryMessage = (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX);

// Ước lượng thô: khoảng 4 ký tự một token. Chỉ dùng khi API chưa báo số đo thật.
export function estimateTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

// Có nên tóm tắt chưa? Ưu tiên số đo thật từ lần gọi API gần nhất (kích thước ngữ cảnh đã gửi), không có thì ước lượng.
export function needsCompaction(messages, lastContextTokens, contextWindow) {
  const used = lastContextTokens > 0 ? lastContextTokens : estimateTokens(messages);
  return used > contextWindow * COMPACTION_THRESHOLD;
}

// Chọn chỗ cắt: giữ KEEP_RECENT tin cuối. Nhưng một tin "kết quả công cụ" không được đứng đầu phần giữ lại, vì đề nghị gọi
// công cụ tương ứng nằm ở tin NGAY TRƯỚC nó; nếu cắt giữa hai tin đó, API sẽ từ chối. Gặp trường hợp này thì lùi chỗ cắt
// thêm một tin để giữ cả cặp.
function findKeepStart(messages) {
  let start = messages.length - KEEP_RECENT;
  while (start > 0 && isToolResultMessage(messages[start])) start--;
  return start;
}

// Trả về { old, recent } nếu có gì đó để tóm tắt, ngược lại null (hội thoại còn ngắn).
export function planCompaction(messages) {
  if (messages.length <= KEEP_RECENT + 2) return null;
  const start = findKeepStart(messages);
  if (start <= 0) return null;
  return { old: messages.slice(0, start), recent: messages.slice(start) };
}

// Mô tả ngắn một tin nhắn để đưa vào yêu cầu tóm tắt (không gửi nguyên văn kẻo quá dài).
function render(m, cap = 500) {
  if (typeof m.content === 'string') return `[${m.role}] ${m.content.slice(0, cap)}`;
  const parts = [];
  for (const b of m.content) {
    if (b.type === 'text') parts.push(b.text.slice(0, 300));
    else if (b.type === 'tool_use') parts.push(`[tool: ${b.name} ${JSON.stringify(b.input).slice(0, 100)}]`);
    else if (b.type === 'tool_result') {
      const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      parts.push(`[result: ${body.slice(0, 200)}]`);
    }
  }
  return `[${m.role}] ${parts.join(' ').slice(0, cap)}`;
}

// Trả về { compacted: true, messages: <danh sách mới> } khi thành công; còn lại { compacted: false, messages: <như cũ> }
// (kèm `error` nếu việc gọi model tóm tắt bị lỗi). KHÔNG sửa danh sách đầu vào; người gọi tự thay nếu muốn.
export async function compactMessages({ messages, provider, signal }) {
  const plan = planCompaction(messages);
  if (!plan) return { compacted: false, messages };
  const { old, recent } = plan;

  // Chỉ lấy 20 tin cuối của phần cũ cho gọn. Riêng bản tóm tắt của lần trước (nếu có, luôn nằm đầu danh sách) thì luôn đưa vào,
  // nếu không nó sẽ bị đẩy ra ngoài 20 tin cuối và thông tin từ đầu phiên mất dần sau mỗi lần tóm tắt.
  const prior = isSummaryMessage(old[0]) ? [render(old[0], 3000)] : [];
  const lines = [...prior, ...old.slice(prior.length).slice(-20).map((m) => render(m))];

  let summary;
  try {
    summary = await provider.summarize(
      {
        system: SUMMARY_SYSTEM,
        prompt:
          'Summarize this conversation history in 2-3 paragraphs. Focus on: ' +
          `files modified, key decisions, current task state.\n\n${lines.join('\n')}`,
        maxTokens: 1024,
      },
      { signal },
    );
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Lỗi mạng/API khi tóm tắt: KHÔNG vứt phần cũ đi (bản Python thay bằng một dòng "[Compacted N earlier messages]").
    // Giữ nguyên lịch sử và để người dùng thử lại.
    return { compacted: false, messages, error: e.message };
  }

  const head = [{ role: 'user', content: `${SUMMARY_PREFIX}\n${summary || 'Previous conversation context.'}` }];
  // Hội thoại phải xen kẽ người dùng/model: nếu phần giữ lại bắt đầu bằng tin của người dùng thì chèn một tin model ở giữa.
  if (recent[0].role === 'user') head.push({ role: 'assistant', content: [{ type: 'text', text: ACK }] });

  return { compacted: true, messages: [...head, ...recent] };
}
