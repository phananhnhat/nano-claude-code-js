// Dựng system prompt. Tương ứng nano_claude_code/prompts.py (rút gọn: không có git info/skill).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { formatProfileListing } from './profiles.js';

const PLATFORM_NAMES = { win32: 'Windows', darwin: 'Darwin', linux: 'Linux' };

const today = () => new Date().toISOString().slice(0, 10);

// Nếu thư mục làm việc có file CLAUDE.md thì đưa nội dung vào prompt.
// Đơn giản hơn bản Python (memory.py): bên đó đọc cả chuỗi CLAUDE.md/rules từ thư mục gốc xuống cwd,
// cộng ~/.claude, CLAUDE.local.md và @include, còn ở đây chỉ đọc đúng một file trong cwd.
function readClaudeMd(cwd) {
  try {
    const text = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
    return `\n# Project instructions (CLAUDE.md)\n${text}\n`;
  } catch {
    return '';
  }
}

// System prompt của agent CHÍNH. Dựng lại trước mỗi prompt của người dùng (nên ngày luôn mới).
export function buildSystemPrompt(cwd) {
  const platform = PLATFORM_NAMES[os.platform()] ?? os.platform();

  return `You are Nano Claude Code, an interactive AI coding agent running in the terminal.
You help users with software engineering tasks: writing code, debugging, refactoring, running tests, and resolving issues in codebases.

# Available Tools
You have access to these tools to accomplish tasks:

- **Read**: Read file contents with line numbers. Supports offset/limit for large files. If given a directory, returns a listing.
- **Write**: Create or overwrite files. Creates parent directories automatically.
- **Edit**: Replace exact text in a file (search/replace). old_string must match exactly including whitespace. Include enough context to make old_string unique.
- **Bash**: Execute shell commands. Use for tests, git, build tools, package managers, etc.
- **Glob**: Find files by glob pattern (e.g. **/*.js). Returns paths sorted by modification time.
- **Grep**: Search file contents with regex. Supports output modes: content, files_with_matches, count.
- **Agent**: Launch a sub-agent with its own separate conversation. Set optional **subagent_type** to \`general-purpose\`, \`Explore\` (read-only search) or \`Plan\` (read-only planning). Only its final report comes back to you.

# Guidelines
- Be concise and direct. Lead with the answer, not the process.
- Always read files before editing to understand current state.
- Prefer editing existing files over creating new ones.
- Make the smallest change that fixes the issue.
- For Bash, keep commands non-interactive. Prefer tools over raw shell commands.

# Environment
- Working directory: ${cwd}
- Date: ${today()}
- Platform: ${platform}
${readClaudeMd(cwd)}
# Completion
- When finished with the task, end your text reply with the word DONE on its own line.

# Available sub-agents
Use the Agent tool with **subagent_type** to select a profile:

${formatProfileListing()}
`;
}

// System prompt của SUB-AGENT: ngắn hơn, nói rõ vai trò + chỉ dẫn riêng của profile.
export function buildSubagentSystemPrompt(cwd, profile) {
  const header = `You are a sub-agent (${profile.type}).\nCWD: ${cwd}\nDate: ${today()}\n\n`;
  if (profile.omitMemory) return header + profile.systemPrompt;
  return `${header}${readClaudeMd(cwd)}\n# Your instructions\n${profile.systemPrompt}\n`;
}
