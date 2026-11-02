#!/usr/bin/env node
// Điểm vào: đọc tham số dòng lệnh, chọn provider, rồi chạy MỘT trong hai chế độ:
//   - một lần (có prompt trong dòng lệnh)  → tương ứng chế độ -p của cli.py
//   - tương tác (không có prompt, hoặc -i) → tương ứng run_repl() của cli.py
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAgent } from './agent.js';
import { createTerminal, runRepl } from './repl.js';
import { anthropicProvider, openaiProvider } from './providers.js';
import { mockProvider, MOCK_PROMPT } from './mock.js';
import { DEFAULT_CONTEXT_WINDOW } from './compact.js';

const HELP = `Cách dùng:
  node src/cli.js "<prompt>"     Chạy một lần rồi thoát
  node src/cli.js                Chế độ tương tác: gõ liên tục nhiều prompt, lịch sử được giữ lại
  node src/cli.js -i "<prompt>"  Chế độ tương tác, bắt đầu bằng prompt này

Tuỳ chọn:
  -i, --interactive   Vào chế độ tương tác
  --mock              Dùng LLM giả theo kịch bản (không cần API key)
  --provider <p>      anthropic | openai   (mặc định: tự chọn theo biến môi trường)
  --model <tên>       Tên model (mặc định lấy từ biến môi trường hoặc giá trị có sẵn)
  --max-turns <n>     Số lượt tối đa cho mỗi prompt (mặc định 50)
  --context-window <n>  Cửa sổ ngữ cảnh của model, tính bằng token (mặc định 200000). Chế độ tương tác tự tóm tắt
                        phần cũ của hội thoại khi vượt 75% con số này. Model nhỏ hơn thì hạ số này xuống.
  --cwd <thư mục>     Thư mục làm việc của agent (mặc định: thư mục hiện tại)
  --show-payload      In body JSON gửi lên API ở mỗi lượt (system/tools được rút gọn)
  --full              Với --show-payload: in đầy đủ cả system prompt và tools
  --yes               Tự đồng ý mọi thao tác Write/Edit/Bash (không hỏi)
  -h, --help          Hiện trợ giúp

Biến môi trường:
  ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL (tuỳ chọn), ANTHROPIC_MODEL (tuỳ chọn)
  OPENAI_COMPAT_API_KEY, OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_MODEL
  (có thể đặt trong file .env ở thư mục bạn chạy lệnh)`;

// Đọc file .env nếu có (Node >= 20.6).
try {
  process.loadEnvFile?.('.env');
} catch {
  /* không có .env thì thôi */
}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    interactive: { type: 'boolean', short: 'i', default: false },
    mock: { type: 'boolean', default: false },
    provider: { type: 'string' },
    model: { type: 'string' },
    'max-turns': { type: 'string', default: '50' },
    'context-window': { type: 'string', default: String(DEFAULT_CONTEXT_WINDOW) },
    cwd: { type: 'string', default: '.' },
    'show-payload': { type: 'boolean', default: false },
    full: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

function fail(msg) {
  console.error(`Lỗi: ${msg}`);
  process.exit(1);
}

// ── Chọn provider ──
function makeProvider() {
  if (args.mock) return mockProvider();

  const env = process.env;
  const wanted = args.provider ?? (env.OPENAI_COMPAT_API_KEY && env.OPENAI_COMPAT_BASE_URL ? 'openai' : env.ANTHROPIC_API_KEY ? 'anthropic' : null);

  if (wanted === 'openai') {
    if (!env.OPENAI_COMPAT_API_KEY || !env.OPENAI_COMPAT_BASE_URL) fail('thiếu OPENAI_COMPAT_API_KEY hoặc OPENAI_COMPAT_BASE_URL');
    return openaiProvider({
      apiKey: env.OPENAI_COMPAT_API_KEY,
      baseUrl: env.OPENAI_COMPAT_BASE_URL,
      model: args.model ?? env.OPENAI_COMPAT_MODEL ?? fail('thiếu --model hoặc OPENAI_COMPAT_MODEL'),
    });
  }
  if (wanted === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) fail('thiếu ANTHROPIC_API_KEY');
    return anthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      baseUrl: env.ANTHROPIC_BASE_URL,
      model: args.model ?? env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
      cache: env.DISABLE_PROMPT_CACHING !== '1',
    });
  }
  return fail('không tìm thấy API key. Đặt ANTHROPIC_API_KEY hoặc OPENAI_COMPAT_*, hoặc chạy thử với --mock.');
}

// ── In payload cho dễ đọc: rút gọn system prompt và danh sách tools (trừ khi có --full) ──
const cut = (s, n = 90) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}… [${s.length} ký tự]` : s);

function printPayload(body, depth = 0) {
  let view = body;
  if (!args.full) {
    view = { ...body };
    if (typeof body.system === 'string') view.system = cut(body.system);
    if (Array.isArray(body.system)) view.system = body.system.map((b) => ({ ...b, text: cut(b.text) }));
    if (Array.isArray(body.tools)) view.tools = `[${body.tools.map((t) => t.name ?? t.function?.name).join(', ')}]  (rút gọn, dùng --full để xem đủ)`;
    view.messages = body.messages.map((m) => (m.role === 'system' ? { ...m, content: cut(m.content) } : m));
  }
  console.log(`-> Payload gửi lên API${depth > 0 ? ' (của SUB-AGENT: lịch sử riêng, tools riêng)' : ''}:`);
  console.log(JSON.stringify(view, null, 2));
}

// ── Terminal dùng chung (cả prompt chính lẫn câu hỏi xác nhận y/N). Chế độ một lần chỉ tạo khi cần hỏi. ──
let term = null;
const getTerm = (interactive) => (term ??= createTerminal({ interactive }));

async function confirm(description) {
  if (args.yes) return true;
  if (!process.stdin.isTTY) return false; // không có người để hỏi → từ chối cho an toàn
  const answer = await getTerm(false).ask(`   ? Cho phép ${description} [y/N] `);
  return ['y', 'yes'].includes((answer ?? '').trim().toLowerCase());
}

// ── Kiểm tra tham số ──
const maxTurns = Number.parseInt(args['max-turns'], 10);
if (!Number.isInteger(maxTurns) || maxTurns < 1) fail('--max-turns phải là số nguyên dương');

const contextWindow = Number.parseInt(args['context-window'], 10);
if (!Number.isInteger(contextWindow) || contextWindow < 1) fail('--context-window phải là số nguyên dương');

const cwd = path.resolve(args.cwd);
if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(`không có thư mục: ${cwd}`);

const promptArg = positionals.join(' ').trim();
// Không có prompt → tương tác (trừ --mock: chạy luôn kịch bản mẫu, để `npm run demo` vẫn hoạt động).
const interactive = args.interactive || (!promptArg && !args.mock);

const provider = makeProvider();
console.log(`Provider: ${provider.name}${provider.model ? `, model: ${provider.model}` : ''}`);
console.log(`Thư mục làm việc: ${cwd}`);
const onPayload = args['show-payload'] ? printPayload : undefined;

// ── Chạy ──
if (interactive) {
  const code = await runRepl({
    term: getTerm(true),
    provider,
    cwd,
    maxTurns,
    confirm,
    onPayload,
    firstInput: promptArg || undefined,
    contextWindow,
  });
  process.exit(code);
}

const prompt = promptArg || MOCK_PROMPT;
console.log(`Prompt: ${prompt}`);

try {
  const result = await runAgent({ cwd, provider, messages: [], userMessage: prompt, maxTurns, confirm, onPayload });

  console.log('\n================ KẾT THÚC ================');
  if (result.ok) console.log(result.text || '(không có text)');
  else console.error(`Lỗi: ${result.error}`);
  console.log(`\nSố lượt: ${result.turns} | token vào: ${result.usage.input} | token ra: ${result.usage.output}`);
  process.exit(result.ok ? 0 : 1);
} catch (e) {
  console.error(`\nLỗi khi gọi API: ${e.message}`);
  process.exit(1);
}
