// VÒNG LẶP AGENT, phần quan trọng nhất. Tương ứng run_agent_loop() / run_streaming() trong nano_claude_code/agent.py
// và tool_agent() (sub-agent) trong tools_impl.py.
//
// Ý tưởng: LLM không nhớ gì giữa các request. Chương trình giữ mảng `messages` trong RAM và
// gửi lại TOÀN BỘ mảng đó mỗi lượt. Lượt nào model yêu cầu tool thì ta chạy tool, nối kết quả
// vào cuối mảng rồi gửi lại. Lặp đến khi model không yêu cầu tool nữa.
//
// `messages` do NGƯỜI GỌI sở hữu và được sửa trực tiếp trong hàm này:
//   - Chế độ tương tác (repl.js): dùng MỘT mảng cho cả phiên, mỗi prompt mới được nối vào cuối.
//   - Sub-agent: truyền vào một mảng RỖNG mới, nên nó không thấy lịch sử của agent chính.
import { TOOL_DEFS, AGENT_TOOL_DEF, NEEDS_PERMISSION, dispatchTool, describeCall } from './tools.js';
import { buildSystemPrompt, buildSubagentSystemPrompt } from './prompt.js';
import { resolveProfile, filterTools, DEFAULT_SUB_MAX_TURNS } from './profiles.js';

const MAX_TOKENS = 16_384;
const SUB_MAX_TOKENS = 8_192;
const MAX_CONTINUATIONS = 3; // số lần tự bảo "viết tiếp" khi model bị cắt vì hết max_tokens
const MAX_AGENT_RESULT_CHARS = 50_000;

const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
const preview = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}… (${s.length} ký tự)` : s);

export async function runAgent({
  cwd,
  provider,
  messages, // lịch sử hội thoại (được sửa trực tiếp)
  userMessage, // tin nhắn mới của người dùng, sẽ được nối vào `messages` (bỏ trống nếu đã có sẵn trong messages)
  maxTurns = 50,
  confirm,
  onPayload,
  log = console.log,
  signal, // AbortSignal: bị abort khi người dùng bấm Ctrl+C
  depth = 0, // 0 = agent chính, 1 = sub-agent
  system, // mặc định: dựng system prompt của agent chính
  tools, // mặc định: agent chính có thêm tool Agent, sub-agent thì không
  maxTokens = MAX_TOKENS,
  usage = { input: 0, output: 0 }, // bộ đếm token dùng chung (sub-agent cộng dồn vào của agent chính)
}) {
  system ??= buildSystemPrompt(cwd);
  tools ??= depth === 0 ? [...TOOL_DEFS, AGENT_TOOL_DEF] : TOOL_DEFS;

  // Log của sub-agent thụt vào và có nhãn để phân biệt với agent chính.
  const pad = '   │ '.repeat(depth);
  const say = (s) => log(pad ? s.split('\n').map((l) => pad + l).join('\n') : s);
  const tag = depth > 0 ? '[sub-agent] ' : '';

  if (userMessage !== undefined) messages.push({ role: 'user', content: userMessage });
  let continuations = 0;
  let lastContext = 0; // kích thước ngữ cảnh API báo ở lượt gần nhất (để quyết định có cần tóm tắt không)

  for (let turn = 1; turn <= maxTurns; turn++) {
    signal?.throwIfAborted();

    // ── BƯỚC 1: dựng payload từ (system, tools, TOÀN BỘ messages) và gửi lên API ──
    say(`\n===== ${tag}Lượt ${turn}: gửi request, lịch sử đang có ${messages.length} tin nhắn =====`);
    const body = provider.buildBody({ system, tools, messages, maxTokens });
    onPayload?.(body, depth);

    const resp = await provider.send(body, { signal });
    usage.input += resp.usage.input;
    usage.output += resp.usage.output;
    lastContext = resp.usage.context ?? 0;

    // ── BƯỚC 2: lưu nguyên văn phản hồi của model vào lịch sử (kể cả khối tool_use) ──
    messages.push({ role: 'assistant', content: resp.content });

    say(`<- Response: stop_reason = ${resp.stopReason}`);
    for (const b of resp.content) {
      if (b.type === 'text') say(`   [text]     ${b.text}`);
      if (b.type === 'tool_use') say(`   [tool_use] ${b.name} ${JSON.stringify(b.input)}   (id=${b.id})`);
    }

    // ── BƯỚC 3: máy biết model cần tool bằng cách lọc các block có type === 'tool_use' ──
    const toolUses = resp.content.filter((b) => b.type === 'tool_use');

    if (toolUses.length === 0) {
      // Model bị cắt giữa chừng vì hết token (và không đang đòi tool) → bảo nó viết tiếp.
      if (resp.stopReason === 'max_tokens' && continuations < MAX_CONTINUATIONS) {
        continuations++;
        messages.push({
          role: 'user',
          content: 'Please continue from where you left off. Do not repeat what you already said.',
        });
        continue;
      }
      // Không có tool_use → model đã xong. DỪNG vòng lặp.
      // (Chữ "DONE" trong system prompt chỉ là lời nhờ model; code không kiểm tra nó.)
      return { ok: true, text: textOf(resp.content), turns: turn, usage, lastContextTokens: lastContext };
    }
    continuations = 0;

    // ── BƯỚC 4: chạy từng tool thật, gom kết quả ──
    const ctx = { cwd, provider, confirm, onPayload, log, signal, depth, usage };
    const toolResults = [];
    for (const tu of toolUses) {
      signal?.throwIfAborted();
      const input = tu.input && typeof tu.input === 'object' ? tu.input : {};
      const { output, isError } = await executeTool(tu.name, input, ctx);

      say(`   => chạy ${tu.name}, kết quả: ${preview(output).replace(/\n/g, '\n      ')}`);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id, // khớp với id của tool_use để model biết kết quả này trả lời yêu cầu nào
        content: output, // <-- NỘI DUNG FILE / KẾT QUẢ GREP / BÁO CÁO CỦA SUB-AGENT nằm ở đây
        is_error: isError,
      });
    }

    // ── BƯỚC 5: kết quả tool gửi lại bằng tin nhắn role "user". Vòng lặp quay lại BƯỚC 1 ──
    messages.push({ role: 'user', content: toolResults });
  }

  return { ok: false, error: `Reached max turns (${maxTurns})`, turns: maxTurns, usage, lastContextTokens: lastContext };
}

// Chạy MỘT tool: hỏi quyền nếu cần, rồi chạy tool thường hoặc mở sub-agent.
async function executeTool(name, input, ctx) {
  if (NEEDS_PERMISSION.has(name) && !(await ctx.confirm(describeCall(name, input)))) {
    return { output: 'Denied: user rejected this operation', isError: true };
  }
  // Chỉ agent chính (depth 0) mới có tool Agent; sub-agent gọi nhầm sẽ rơi xuống "unknown tool".
  const output = name === 'Agent' && ctx.depth === 0 ? await runSubAgent(input, ctx) : dispatchTool(ctx.cwd, name, input);
  return { output, isError: output.startsWith('Error:') || output.startsWith('Sub-agent error:') };
}

// ───────────────────────────────────── SUB-AGENT ─────────────────────────────────────
// Với agent chính, "Agent" chỉ là một tool như mọi tool khác: nhận tham số, trả về một chuỗi.
// Bên trong, nó chạy MỘT VÒNG LẶP AGENT MỚI với `messages` rỗng và system prompt riêng, rồi chỉ
// trả về chữ mà sub-agent nói. Mọi bước trung gian (file đã đọc, lệnh đã chạy) bị bỏ đi,
// nên không làm phình lịch sử của agent chính.
async function runSubAgent(input, ctx) {
  if (!input.prompt) return 'Error: prompt is required';

  const profile = resolveProfile(input.subagent_type);
  const subMessages = []; // lịch sử RIÊNG của sub-agent
  ctx.log(`\n   ┌── mở sub-agent "${profile.type}": ${preview(input.prompt, 120)}`);

  let result;
  try {
    result = await runAgent({
      ...ctx,
      messages: subMessages,
      userMessage: input.prompt, // tin nhắn đầu tiên và duy nhất lúc bắt đầu
      maxTurns: DEFAULT_SUB_MAX_TURNS,
      system: buildSubagentSystemPrompt(ctx.cwd, profile),
      tools: filterTools(TOOL_DEFS, profile),
      maxTokens: SUB_MAX_TOKENS,
      depth: ctx.depth + 1,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e; // Ctrl+C phải dừng cả hai vòng lặp
    return `Sub-agent error: ${e.message}`;
  }
  ctx.log('   └── sub-agent xong; chỉ báo cáo cuối được trả về cho agent chính');

  // Gom TOÀN BỘ chữ do sub-agent nói qua mọi lượt (giống bản Python), không chỉ câu cuối.
  const text = subMessages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const stopped = result.ok ? '' : `\n[sub-agent stopped early: ${result.error}]`;
  const report = `[Sub-agent: ${profile.type} — ${input.description ?? 'Sub-agent task'}]\n${text || '(sub-agent produced no text)'}${stopped}`;
  return report.length > MAX_AGENT_RESULT_CHARS ? `${report.slice(0, MAX_AGENT_RESULT_CHARS)}\n...[truncated]` : report;
}
