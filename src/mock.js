// "LLM giả" để chạy thử vòng lặp mà KHÔNG cần API key và không tốn tiền.
// Nó không thông minh: chỉ trả lời theo kịch bản cố định, chọn kịch bản theo prompt gần nhất của người dùng:
//   - prompt có chữ "sub-agent"          → kịch bản "delegate": giao việc cho sub-agent
//   - prompt bắt đầu bằng "Chỉ đọc file" → kịch bản "sub": việc mà sub-agent làm
//   - prompt khác                         → kịch bản "main": đọc task.txt → grep A/B/C → ghi result.md
// Mục đích duy nhất là để bạn nhìn thấy payload và cách vòng lặp chạy. Muốn LLM thật, bỏ cờ --mock.
import { anthropicProvider } from './providers.js';

export const MOCK_PROMPT =
  'Đọc file task.txt, xem yêu cầu rồi tìm kiếm nội dung trong file A.js, B.js, C.js nếu cần thiết, xong thì ghi kết quả vào result.md.';

const SUB_TASK_PROMPT = 'Chỉ đọc file task.txt rồi nhắc lại nội dung của nó trong một câu.';

const reply = (content, stopReason) => ({ stopReason, content, usage: { input: 0, output: 0 } });
let counter = 0;
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_mock_${++counter}`, name, input });

// Lấy chữ của một tin nhắn user nếu nó là prompt của người (không phải tool_result).
// (Tin nhắn user cuối có thể đã bị bọc thành mảng block để gắn cache_control.)
function humanText(m) {
  if (m.role !== 'user') return null;
  if (typeof m.content === 'string') return m.content;
  if (m.content.every((b) => b.type === 'text')) return m.content.map((b) => b.text).join('\n');
  return null;
}

const lastToolResults = (messages) => messages.at(-1).content.filter((b) => b.type === 'tool_result');
const stripLineNumbers = (s) => s.replace(/^\s*\d+\t/gm, '').trim();

export function mockProvider() {
  // Dùng lại buildBody của Anthropic để payload hiển thị giống thật.
  const base = anthropicProvider({ apiKey: 'mock', model: 'mock-model', cache: true });

  return {
    ...base,
    name: 'mock (kịch bản cố định, không gọi mạng)',

    // Tóm tắt giả: không gọi mạng, chỉ trích vài chữ đầu của đoạn hội thoại cần tóm tắt.
    async summarize({ prompt }) {
      const conversation = prompt.split('\n\n').slice(1).join(' ');
      return `(tóm tắt giả) ${conversation.slice(0, 160)}…`;
    },

    async send(body) {
      const { messages } = body;

      // Tìm prompt gần nhất của người dùng, rồi đếm xem model đã nói mấy lượt kể từ đó.
      let start = messages.length - 1;
      while (start > 0 && humanText(messages[start]) === null) start--;
      const prompt = humanText(messages[start]) ?? '';
      const assistantTurns = messages.slice(start + 1).filter((m) => m.role === 'assistant');
      const step = assistantTurns.length;

      if (prompt.startsWith('Chỉ đọc file')) {
        // Việc của sub-agent: đọc task.txt rồi nhắc lại nội dung.
        if (step === 0) {
          return reply([{ type: 'text', text: 'Tôi sẽ đọc task.txt.' }, toolUse('Read', { file_path: 'task.txt' })], 'tool_use');
        }
        const content = stripLineNumbers(lastToolResults(messages)[0].content);
        return reply([{ type: 'text', text: `task.txt yêu cầu: ${content}` }], 'end_turn');
      }

      if (/sub-?agent/i.test(prompt)) {
        // Agent chính giao việc cho sub-agent rồi dựa vào báo cáo của nó để trả lời.
        if (step === 0) {
          return reply(
            [
              { type: 'text', text: 'Việc này tôi giao cho một sub-agent.' },
              toolUse('Agent', { description: 'Đọc task.txt', prompt: SUB_TASK_PROMPT, subagent_type: 'Explore' }),
            ],
            'tool_use',
          );
        }
        const report = lastToolResults(messages)[0].content;
        return reply([{ type: 'text', text: `Sub-agent đã báo lại:\n${report}\nDONE` }], 'end_turn');
      }

      switch (step) {
        case 0: // Lượt 1: model muốn đọc file yêu cầu
          return reply(
            [
              { type: 'text', text: 'Tôi sẽ đọc task.txt trước để biết yêu cầu.' },
              toolUse('Read', { file_path: 'task.txt' }),
            ],
            'tool_use',
          );

        case 1: // Lượt 2: đã thấy nội dung task.txt → grep cả 3 file trong MỘT response
          return reply(
            [
              { type: 'text', text: 'Yêu cầu: tìm các chỗ gọi connect_db. Tôi sẽ grep cả 3 file.' },
              ...['A.js', 'B.js', 'C.js'].map((f) => toolUse('Grep', { pattern: 'connect_db', path: f })),
            ],
            'tool_use',
          );

        case 2: { // Lượt 3: đã thấy kết quả grep → ghi báo cáo
          const lastCalls = assistantTurns[1].content.filter((b) => b.type === 'tool_use');
          const results = lastToolResults(messages);
          const found = results
            .filter((r) => r.content !== '(no matches)')
            .flatMap((r) => r.content.split('\n').map((line) => `- ${line}`));
          const noMatch = results
            .map((r, i) => (r.content === '(no matches)' ? lastCalls[i].input.path : null))
            .filter(Boolean);
          const report = `# Kết quả\n\n${found.join('\n')}\n\n${noMatch.join(', ')} không gọi connect_db.\n`;
          return reply(
            [
              { type: 'text', text: 'Đã có kết quả grep. Tôi ghi vào result.md.' },
              toolUse('Write', { file_path: 'result.md', content: report }),
            ],
            'tool_use',
          );
        }

        default: // Lượt 4: xong, không gọi tool nữa → vòng lặp dừng
          return reply([{ type: 'text', text: 'Đã ghi kết quả vào result.md.\nDONE' }], 'end_turn');
      }
    },
  };
}
