import type { LoopGuardSettings } from "../shared/types";
// Looking around is not an attempt: reading files or polling the output of
// a background command can repeat as much as needed. Claude tool names, then
// Devin's ACP tool kinds.
const lookingAround =
  /^(?:Sub-agente · )?(?:Read|Grep|Glob|LS|NotebookRead|TodoWrite|BashOutput|TaskOutput|Monitor|ListMcpResourcesTool|ReadMcpResourceTool|read|search|think)[ ·:]/;
// Stops an agent that keeps trying something that is not working: the same
// action again and again with no file edited in between (a download that
// never arrives, a command that fails the same way), or failures in a row.
// Editing a file counts as progress, so "edit, run the tests" loops are fine.
export class LoopGuard {
  private repeats = new Map<string, number>();
  private failures = 0;
  constructor(private limits: LoopGuardSettings) {}
  // Returns the reason to stop, if the agent should.
  action(key: string, label: string, edited: boolean) {
    if (edited) {
      this.repeats.clear();
      return undefined;
    }
    if (lookingAround.test(key)) return undefined;
    const id = key.replace(/\s+/g, " ").trim().toLowerCase();
    const count = (this.repeats.get(id) ?? 0) + 1;
    this.repeats.set(id, count);
    return count >= this.limits.repeats
      ? `a mesma ação foi tentada ${count} vezes, sem nenhum arquivo alterado entre as tentativas: “${label.slice(0, 300)}”`
      : undefined;
  }
  outcome(ok: boolean) {
    this.failures = ok ? 0 : this.failures + 1;
    return this.failures >= this.limits.failures
      ? `${this.failures} ações seguidas falharam, sem nenhum sucesso entre elas`
      : undefined;
  }
}
