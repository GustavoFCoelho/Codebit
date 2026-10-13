import { describe, expect, it } from "vitest";
import { claudeContext } from "../src/main/agents/context";
// Numbers from a real Claude Code 2.1.284 session (get_context_usage, full).
const real = {
  categories: [
    { name: "System prompt", tokens: 2595, kind: "used" },
    { name: "System tools", tokens: 9507, kind: "used" },
    {
      name: "System tools (deferred)",
      tokens: 13217,
      kind: "deferred",
      isDeferred: true,
    },
    { name: "Memory files", tokens: 1389, kind: "used" },
    { name: "Skills", tokens: 5237, kind: "used" },
    { name: "Messages", tokens: 8878, kind: "used" },
    { name: "Autocompact buffer", tokens: 33000, kind: "buffer" },
    { name: "Free space", tokens: 940462, kind: "free" },
  ],
  totalTokens: 27606,
  maxTokens: 1000000,
  // One memory file listed, though the category counts more.
  memoryFiles: [
    { path: "C:\\Users\\u\\MEMORY.md", type: "AutoMem", tokens: 321 },
  ],
  mcpTools: [],
  skills: { skillFrontmatter: [{ name: "dataviz", tokens: 482 }] },
  messageBreakdown: {
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 25040,
    assistantMessageTokens: 7,
    userMessageTokens: 11,
    unattributedTokens: 0,
    attachmentsByType: [
      { name: "prompt_snapshot", tokens: 21109 },
      { name: "skill_listing", tokens: 2156 },
    ],
  },
};
describe("contexto do Claude Code", () => {
  it("agrupa as categorias e os itens sempre fecham com a parte", () => {
    const usage = claudeContext(real)!;
    expect(usage).toMatchObject({
      used: 27606,
      size: 1000000,
      deferred: 13217,
    });
    for (const part of usage.parts!)
      if (part.items?.length)
        expect(part.items.reduce((s, i) => s + i.tokens, 0)).toBe(part.tokens);
    const [instructions, , skills, conversation] = usage.parts!;
    expect(instructions.items).toEqual([
      { label: "Prompt de sistema e instruções do Codebit", tokens: 2595 },
      { label: "MEMORY.md (memória automática)", tokens: 321 },
      // What the lists leave out comes last.
      { label: "Outros", tokens: 1068 },
    ]);
    expect(skills.items!.at(-1)).toEqual({
      label: "Outras skills",
      tokens: 4755,
    });
    // The prompt snapshot is not counted as an attachment.
    expect(conversation.items).toEqual([
      { label: "Anexos e avisos do Claude Code", tokens: 3931 },
      { label: "Suas mensagens", tokens: 11 },
      { label: "Respostas do agente", tokens: 7 },
      { label: "Outros", tokens: 4929 },
    ]);
  });
  it("versões sem o detalhamento ficam só com o total", () => {
    expect(claudeContext({})).toBeUndefined();
    expect(claudeContext(undefined)).toBeUndefined();
  });
});
