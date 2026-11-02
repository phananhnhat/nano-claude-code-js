// Các "profile" cho sub-agent: mỗi profile là một system prompt riêng + danh sách tool bị cấm.
// Tương ứng nano_claude_code/agents.py (chỉ 3 profile có sẵn; bản Python còn đọc profile tự viết trong .claude/agents/*.md).

export const DEFAULT_SUB_MAX_TURNS = 10;

export const PROFILES = {
  'general-purpose': {
    type: 'general-purpose',
    whenToUse:
      'General research and multi-step tasks. Use when you need broad codebase search or exploration without a specialized profile.',
    systemPrompt: `You are a sub-agent for Nano Claude Code. Complete the delegated task fully using your tools.

Strengths: searching codebases, reading multiple files, multi-step investigation.

Guidelines:
- Prefer Glob/Grep to locate code; Read when you know the path.
- NEVER create docs (*.md, README) unless the task explicitly requires it.
- Prefer editing existing files over creating new ones.
- When done, reply with a concise report for the parent agent.`,
    disallowedTools: [],
    omitMemory: false,
  },

  explore: {
    type: 'Explore',
    whenToUse: 'Fast read-only codebase exploration: find files, grep patterns, answer structural questions.',
    systemPrompt: `You are a read-only exploration sub-agent. STRICTLY prohibited from:
Write, Edit, or any file mutation (including via shell: touch, rm, cp, mv, redirects).

Use Glob, Grep, Read, and Bash only for read-only commands (ls, git status/log/diff, cat, head, tail).
Report findings in your reply; do not create files.`,
    // Lưu ý: Explore vẫn có Bash, nên "chỉ đọc" ở đây dựa vào lời dặn trong prompt, không được code ép buộc.
    disallowedTools: ['Agent', 'Write', 'Edit'],
    omitMemory: true,
  },

  plan: {
    type: 'Plan',
    whenToUse: 'Design implementation plans: steps, dependencies, critical files, without modifying code.',
    systemPrompt: `You are a read-only planning sub-agent (software architect). Explore the codebase and
produce an implementation plan. You MUST NOT Write, Edit, or mutate files.

Process: understand requirements, explore with Glob/Grep/Read and read-only Bash, then output
step-by-step plan and trade-offs.

End with a section:
### Critical Files for Implementation
List 3-5 paths critical to the plan.`,
    disallowedTools: ['Agent', 'Write', 'Edit'],
    omitMemory: true,
  },
};

const normKey = (name) => String(name ?? '').trim().toLowerCase().replace(/ /g, '-');

// Không chỉ định hoặc gõ sai tên thì dùng general-purpose (giống bản Python).
export function resolveProfile(name) {
  return PROFILES[normKey(name)] ?? PROFILES['general-purpose'];
}

export function filterTools(allDefs, profile) {
  return allDefs.filter((t) => !profile.disallowedTools.includes(t.name));
}

function toolsSummary(profile) {
  const deny = [...profile.disallowedTools].sort();
  return deny.length ? `All except ${deny.join(', ')}` : 'All';
}

// Danh sách đưa vào system prompt của agent chính để model biết có những profile nào.
export function formatProfileListing() {
  return Object.values(PROFILES)
    .map((p) => `- ${p.type}: ${p.whenToUse} (Tools: ${toolsSummary(p)})`)
    .join('\n');
}
