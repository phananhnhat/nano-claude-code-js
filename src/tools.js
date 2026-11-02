// Định nghĩa tool (gửi cho LLM) + hàm chạy tool thật (chạy trên máy bạn).
// Tương ứng nano_claude_code/tools_impl.py (rút gọn: 6 tool Read/Write/Edit/Bash/Glob/Grep).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_OUTPUT_CHARS = 50_000;

// ───────────────────────── 1. Định nghĩa tool: phần này được gửi lên API trong trường "tools" ─────────────────────────
// LLM chỉ "biết" mình có công cụ gì nhờ danh sách này (tên + mô tả + schema tham số).
export const TOOL_DEFS = [
  {
    name: 'Read',
    description:
      'Read a file from the filesystem. Returns numbered lines. ' +
      'If path is a directory, returns a listing. Use offset/limit for large files.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path to the file' },
        offset: { type: 'integer', description: '1-based line number to start reading from' },
        limit: { type: 'integer', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Create or overwrite a file with the given content. Creates parent directories automatically.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description:
      'Replace old_string with new_string in a file. old_string must match exactly ' +
      '(including whitespace) and be unique unless replace_all is true.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to find and replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Bash',
    description: 'Run a shell command in the working directory. Each call starts in the project root.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'integer', description: 'Seconds before timeout (default 120)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Glob',
    description: "Find files matching a glob pattern. Auto-prepends **/ for simple patterns.",
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Glob pattern, e.g. '*.js' or '**/*.ts'" },
        path: { type: 'string', description: 'Base directory (default: project root)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents with a regex.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search' },
        glob: { type: 'string', description: "File filter glob, e.g. '*.js'" },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        case_insensitive: { type: 'boolean' },
        head_limit: { type: 'integer', description: 'Max matching lines (default 250)' },
      },
      required: ['pattern'],
    },
  },
];

// Tool "Agent" (sub-agent). Chỉ có phần ĐỊNH NGHĨA ở đây; phần chạy nằm trong agent.js vì nó cần
// gọi lại chính vòng lặp agent (đặt ở đây sẽ bị import vòng tròn). Chỉ agent chính được dùng tool này.
export const AGENT_TOOL_DEF = {
  name: 'Agent',
  description:
    'Launch a sub-agent to handle a complex, multi-step task autonomously. ' +
    'The sub-agent gets its own conversation and cannot use the Agent tool. ' +
    'Optional **subagent_type**: general-purpose (default), Explore, or Plan.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The task for the sub-agent' },
      description: { type: 'string', description: 'Short description (3-5 words)' },
      subagent_type: { type: 'string', description: 'Agent profile: general-purpose, Explore, or Plan' },
    },
    required: ['prompt'],
  },
};

// Những tool có thể sửa máy bạn → hỏi xác nhận trước khi chạy (xem agent.js).
export const NEEDS_PERMISSION = new Set(['Write', 'Edit', 'Bash']);

export function describeCall(name, input) {
  if (name === 'Bash') return `Bash: ${input.command}`;
  if (name === 'Write') return `Write: ${input.file_path} (${String(input.content ?? '').length} ký tự)`;
  if (name === 'Edit') return `Edit: ${input.file_path}`;
  return `${name}: ${JSON.stringify(input)}`;
}

// ───────────────────────── 2. Chạy tool: nhận (tên, tham số) → trả về chuỗi kết quả ─────────────────────────
// Đây chính là chỗ "máy chạy thay LLM". Lỗi nào cũng được trả về dưới dạng chuỗi bắt đầu bằng "Error:"
// để LLM đọc được và tự đổi cách làm; không bao giờ làm sập vòng lặp.
export function dispatchTool(cwd, name, input) {
  const handler = HANDLERS[name];
  if (!handler) return `Error: unknown tool '${name}'`;
  try {
    return clip(handler(cwd, input ?? {}));
  } catch (e) {
    return `Error: ${name} failed: ${e.message}`;
  }
}

const clip = (s) => (s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '\n...[truncated]' : s);
const resolvePath = (cwd, p) => path.resolve(cwd, p);
const rel = (cwd, p) => path.relative(cwd, p).split(path.sep).join('/') || '.';

function read(cwd, { file_path, offset = 1, limit }) {
  if (!file_path) return 'Error: file_path is required';
  const p = resolvePath(cwd, file_path);
  if (!fs.existsSync(p)) return `Error: file not found: ${file_path}`;

  if (fs.statSync(p).isDirectory()) {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .map((d) => d.name + (d.isDirectory() ? '/' : ''))
      .join('\n');
  }

  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // bỏ dòng rỗng do ký tự xuống dòng cuối file
  const start = Math.max(1, offset) - 1;
  const end = limit ? start + limit : lines.length;
  // Đánh số dòng: "     1<TAB>nội dung"
  return lines
    .slice(start, end)
    .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
    .join('\n');
}

function write(cwd, { file_path, content }) {
  if (!file_path || content === undefined) return 'Error: file_path and content are required';
  const p = resolvePath(cwd, file_path);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return `Wrote ${file_path} (${content.length} chars)`;
}

function edit(cwd, { file_path, old_string, new_string, replace_all = false }) {
  const p = resolvePath(cwd, file_path);
  if (!fs.existsSync(p)) return `Error: file not found: ${file_path}`;
  const text = fs.readFileSync(p, 'utf8');
  const count = old_string ? text.split(old_string).length - 1 : 0;
  if (count === 0) return 'Error: old_string not found in file';
  if (count > 1 && !replace_all) {
    return `Error: old_string appears ${count} times; add more context or set replace_all`;
  }
  const updated = text.split(old_string).join(new_string); // dùng split/join để không bị ký tự đặc biệt của replace()
  fs.writeFileSync(p, replace_all ? updated : text.replace(old_string, () => new_string));
  return `Edited ${file_path} (${replace_all ? count : 1} replacement)`;
}

function bash(cwd, { command, timeout = 120 }) {
  if (!command) return 'Error: command is required';
  const r = spawnSync(command, { shell: true, cwd, timeout: timeout * 1000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (r.error) {
    return r.error.code === 'ETIMEDOUT' ? `Error: command timed out after ${timeout}s` : `Error: ${r.error.message}`;
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
  return r.status === 0 ? out || '(no output)' : `${out}\n[exit code ${r.status}]`;
}

// Duyệt đệ quy mọi file trong một thư mục (bỏ .git và node_modules).
function* walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(d.name)) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(full);
    else if (d.isFile()) yield full;
  }
}

// Đổi glob (**, *, ?) thành RegExp. Khớp trên đường dẫn tương đối dùng dấu "/".
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function glob(cwd, { pattern, path: base = '.' }) {
  if (!pattern) return 'Error: pattern is required';
  const baseDir = resolvePath(cwd, base);
  if (!fs.existsSync(baseDir)) return `Error: directory not found: ${base}`;
  const re = globToRegex(pattern.includes('/') ? pattern : `**/${pattern}`);
  const hits = [];
  for (const file of walk(baseDir)) {
    if (re.test(rel(baseDir, file))) hits.push({ file, mtime: fs.statSync(file).mtimeMs });
  }
  if (hits.length === 0) return '(no matches)';
  return hits
    .sort((a, b) => b.mtime - a.mtime) // mới sửa gần nhất đứng đầu
    .slice(0, 500)
    .map((h) => rel(cwd, h.file))
    .join('\n');
}

function grep(cwd, { pattern, path: target = '.', glob: fileGlob, output_mode = 'content', case_insensitive = false, head_limit = 250 }) {
  if (!pattern) return 'Error: pattern is required';
  let regex;
  try {
    regex = new RegExp(pattern, case_insensitive ? 'i' : '');
  } catch (e) {
    return `Error: invalid regex: ${e.message}`;
  }
  const targetPath = resolvePath(cwd, target);
  if (!fs.existsSync(targetPath)) return `Error: path not found: ${target}`;

  const isFile = fs.statSync(targetPath).isFile();
  const files = isFile ? [targetPath] : [...walk(targetPath)];
  const fileRe = fileGlob ? globToRegex(fileGlob.includes('/') ? fileGlob : `**/${fileGlob}`) : null;

  const lines = [];
  for (const file of files) {
    if (fileRe && !fileRe.test(rel(targetPath, file))) continue;
    let text;
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // file nhị phân

    const matched = [];
    text.split(/\r?\n/).forEach((line, i) => {
      if (regex.test(line)) matched.push(`${rel(cwd, file)}:${i + 1}: ${line}`);
    });
    if (matched.length === 0) continue;

    if (output_mode === 'files_with_matches') lines.push(rel(cwd, file));
    else if (output_mode === 'count') lines.push(`${rel(cwd, file)}: ${matched.length}`);
    else lines.push(...matched);
  }
  return lines.length ? lines.slice(0, head_limit).join('\n') : '(no matches)';
}

const HANDLERS = { Read: read, Write: write, Edit: edit, Bash: bash, Glob: glob, Grep: grep };
