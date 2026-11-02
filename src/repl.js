// CHẾ ĐỘ TƯƠNG TÁC: vòng lặp NGOÀI (người dùng gõ liên tục). Tương ứng run_repl() trong nano_claude_code/cli.py.
//
// Có hai vòng lặp lồng nhau:
//   - vòng NGOÀI (file này): chờ người dùng gõ → giao cho agent → chờ gõ tiếp
//   - vòng TRONG (agent.js): model ↔ tool, chạy đến khi model không gọi tool nữa
// "Trí nhớ" giữa các prompt chỉ đơn giản là mảng `messages` bên dưới được GIỮ NGUYÊN giữa các lần gõ:
// prompt mới được nối vào cuối mảng đó, rồi cả mảng được gửi lại cho model.
// Khi mảng quá dài, trước prompt kế tiếp ta tóm tắt phần cũ (xem compact.js).
import readline from 'node:readline';
import path from 'node:path';
import { runAgent } from './agent.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  COMPACTION_THRESHOLD,
  compactMessages,
  estimateTokens,
  needsCompaction,
  planCompaction,
} from './compact.js';

// ── Terminal: đọc từng dòng người dùng gõ, và xử lý Ctrl+C ──
// Dùng chung MỘT readline cho cả prompt chính lẫn câu hỏi xác nhận y/N (tạo hai cái trên cùng stdin sẽ lỗi).
export function createTerminal({ interactive }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = []; // dòng đã gõ nhưng chưa ai hỏi tới (xảy ra khi stdin là pipe)
  let waiter = null; // hàm resolve của câu hỏi đang chờ
  let closed = false;
  let controller = null; // AbortController của lượt agent đang chạy (null = đang chờ người dùng gõ)
  let lastIdleInterrupt = 0;

  const deliver = (value) => {
    const w = waiter;
    waiter = null;
    w?.(value);
  };

  rl.on('line', (line) => (waiter ? deliver(line) : queue.push(line)));
  rl.on('close', () => {
    closed = true;
    deliver(null); // Ctrl+D hoặc hết dữ liệu pipe
  });

  rl.on('SIGINT', () => {
    if (controller) {
      controller.abort(); // đang chạy agent → huỷ lượt này
      deliver(null); // nếu đang chờ câu hỏi y/N thì coi như "không" để vòng lặp đi tiếp tới chỗ kiểm tra huỷ
      return;
    }
    if (!interactive) process.exit(130);
    const now = Date.now();
    if (now - lastIdleInterrupt < 1000) {
      console.log('\nTạm biệt!');
      process.exit(0);
    }
    lastIdleInterrupt = now;
    console.log('\n  (nhấn Ctrl+C lần nữa để thoát, hoặc gõ /exit)');
    rl.prompt();
  });

  return {
    // Trả về dòng người dùng gõ, hoặc null nếu hết dữ liệu.
    ask(promptText) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      rl.setPrompt(promptText);
      rl.prompt();
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    setRunning(c) {
      controller = c;
    },
  };
}

const HELP = `Lệnh:
  /help             Hiện trợ giúp này
  /clear (/new)     Xoá lịch sử hội thoại, bắt đầu lại từ đầu
  /compact          Tóm tắt phần cũ của lịch sử ngay bây giờ (bình thường chương trình tự làm khi sắp đầy)
  /history          Xem danh sách tin nhắn đang giữ trong lịch sử
  /context          Kích thước ngữ cảnh hiện tại và ngưỡng tự tóm tắt
  /cost             Tổng token đã dùng trong phiên
  /exit (/quit)     Thoát
Ctrl+C khi agent đang chạy: huỷ lượt đó (lịch sử trở lại như trước khi gõ).`;

// Mô tả ngắn từng tin nhắn để thấy lịch sử dài ra thế nào sau mỗi lượt.
function printHistory(messages, log) {
  if (messages.length === 0) return log('(lịch sử trống)');
  messages.forEach((m, i) => {
    let what;
    if (typeof m.content === 'string') what = JSON.stringify(m.content.slice(0, 80));
    else what = '[' + m.content.map((b) => (b.type === 'tool_use' ? `tool_use:${b.name}` : b.type)).join(', ') + ']';
    log(`  [${i}] ${m.role.padEnd(9)} ${what}`);
  });
}

export async function runRepl({
  term,
  provider,
  cwd,
  maxTurns,
  confirm,
  onPayload,
  firstInput,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  log = console.log,
}) {
  const messages = []; // <-- lịch sử của CẢ PHIÊN, sống suốt vòng lặp ngoài
  const totals = { input: 0, output: 0 };
  let lastContext = 0; // kích thước ngữ cảnh API báo ở lần gọi gần nhất (0 = chưa biết)
  let pending = firstInput;

  // Chạy fn(signal) sao cho Ctrl+C huỷ được; lỗi được báo ra chứ không làm sập vòng lặp.
  async function guarded(fn) {
    const controller = new AbortController();
    term.setRunning(controller);
    try {
      await fn(controller.signal);
    } catch (e) {
      log(e.name === 'AbortError' ? '\n  (đã huỷ)' : `\n  (lỗi: ${e.message})`);
    } finally {
      term.setRunning(null);
    }
  }

  // Tóm tắt phần cũ của lịch sử nếu cần (hoặc ép làm ngay khi `force`, dùng cho /compact).
  // Lịch sử chỉ bị thay SAU KHI tóm tắt thành công, nên bị huỷ hay lỗi giữa chừng thì không mất gì.
  async function compact(signal, { force }) {
    if (!force && !needsCompaction(messages, lastContext, contextWindow)) return;
    if (!planCompaction(messages)) {
      if (force) log('  (hội thoại còn ngắn, chưa có gì để tóm tắt)');
      return;
    }
    log('\n  (ngữ cảnh sắp đầy, đang tóm tắt phần cũ của hội thoại...)');
    const before = messages.length;
    const result = await compactMessages({ messages, provider, signal });
    if (result.compacted) {
      messages.splice(0, messages.length, ...result.messages); // thay nội dung nhưng giữ nguyên chính mảng đó
      lastContext = 0; // số đo cũ không còn đúng nữa; lần gọi API kế tiếp sẽ đo lại
      log(`  (đã tóm tắt: ${before} → ${messages.length} tin nhắn)`);
    } else if (result.error) {
      log(`  (không tóm tắt được: ${result.error}; giữ nguyên lịch sử)`);
    }
  }

  log('\nChế độ tương tác. Gõ yêu cầu rồi Enter. /help xem lệnh, /exit để thoát.');

  while (true) {
    const line = pending ?? (await term.ask(`\n[${path.basename(cwd)}] ❯ `));
    pending = undefined;
    if (line === null) {
      log('\nTạm biệt!');
      return 0;
    }
    const input = line.trim();
    if (!input) continue;

    if (input.startsWith('/')) {
      switch (input.slice(1).split(/\s+/)[0].toLowerCase()) {
        case 'exit':
        case 'quit':
          log('Tạm biệt!');
          return 0;
        case 'clear':
        case 'new':
        case 'reset':
          messages.length = 0;
          lastContext = 0;
          log('Đã xoá lịch sử hội thoại.');
          break;
        case 'compact':
          await guarded((signal) => compact(signal, { force: true }));
          break;
        case 'history':
          printHistory(messages, log);
          break;
        case 'context': {
          const measured = lastContext > 0;
          const used = measured ? lastContext : estimateTokens(messages);
          log(
            `Tin nhắn: ${messages.length} | ngữ cảnh hiện tại ~${used} token ` +
              `(${measured ? 'số đo từ API' : 'ước lượng, chưa tính system prompt và tools'})`,
          );
          log(
            `Tự tóm tắt khi vượt ${Math.round(contextWindow * COMPACTION_THRESHOLD)} token ` +
              `(${Math.round(COMPACTION_THRESHOLD * 100)}% của cửa sổ ${contextWindow}).`,
          );
          break;
        }
        case 'cost':
          log(`Token vào: ${totals.input} | token ra: ${totals.output}`);
          break;
        case 'help':
          log(HELP);
          break;
        default:
          log(`Không có lệnh ${input.split(/\s+/)[0]}. Gõ /help để xem danh sách.`);
      }
      continue;
    }

    // ── Vòng TRONG: giao prompt cho agent, dùng lại đúng mảng `messages` của cả phiên ──
    const controller = new AbortController();
    term.setRunning(controller);
    let before; // độ dài lịch sử để quay về nếu lượt này hỏng; chỉ có giá trị SAU bước tóm tắt (tóm tắt làm lịch sử ngắn đi)
    try {
      await compact(controller.signal, { force: false }); // kiểm tra TRƯỚC khi thêm prompt mới
      before = messages.length;
      const result = await runAgent({
        cwd,
        provider,
        messages,
        userMessage: input,
        maxTurns,
        confirm,
        onPayload,
        log,
        signal: controller.signal,
        usage: totals,
      });
      lastContext = result.lastContextTokens;
      log('\n------------------------------------------');
      log(result.ok ? result.text || '(không có text)' : `Lỗi: ${result.error}`);
      log(`[lịch sử: ${messages.length} tin nhắn | tổng token vào ${totals.input} / ra ${totals.output}]`);
    } catch (e) {
      // Lượt dở dang có thể để lại lịch sử không hợp lệ (tool_use mà chưa có tool_result → API sẽ báo lỗi
      // ở mọi lần gõ sau). Nên cắt về đúng trạng thái trước khi gõ prompt này.
      if (before !== undefined) messages.length = before;
      const why = e.name === 'AbortError' ? 'đã huỷ lượt này' : `lỗi khi gọi API: ${e.message}`;
      log(`\n  (${why}; lịch sử trở lại như trước khi gõ)`);
    } finally {
      term.setRunning(null);
    }
  }
}
