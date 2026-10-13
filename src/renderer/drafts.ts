// Messages being written, per conversation: kept while switching chats,
// after the window reloads and across restarts, until they are sent.
export interface Draft {
  text: string;
  attachments: string[];
  at: number;
}
const storageKey = "codebit.drafts";
// Old drafts go away by themselves.
const maxAge = 30 * 24 * 3600 * 1000;
const drafts = new Map<string, Draft>(load());
function load(): [string, Draft][] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return (Array.isArray(saved) ? saved : [])
      .filter(
        ([id, d]: [unknown, any]) =>
          typeof id === "string" &&
          typeof d?.text === "string" &&
          Array.isArray(d.attachments) &&
          Date.now() - Number(d.at) < maxAge,
      )
      .slice(-100);
  } catch {
    return [];
  }
}
let timer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(timer);
  timer = undefined;
  try {
    localStorage.setItem(storageKey, JSON.stringify([...drafts]));
  } catch {}
}
// Typing saves at most a few times per second.
function schedule() {
  timer ??= setTimeout(persist, 400);
}
window.addEventListener("beforeunload", persist);
export const getDraft = (id: string) => drafts.get(id);
export function saveDraft(id: string, text: string, attachments: string[]) {
  if (!id) return;
  if (!text.trim() && !attachments.length) {
    if (drafts.delete(id)) schedule();
    return;
  }
  drafts.set(id, { text: text.slice(0, 100_000), attachments, at: Date.now() });
  schedule();
}
export const draftIds = () => new Set(drafts.keys());
// Forgets drafts of conversations that no longer exist.
export function pruneDrafts(keep: Set<string>) {
  let changed = false;
  for (const id of [...drafts.keys()])
    if (!keep.has(id)) changed = drafts.delete(id) || changed;
  if (changed) schedule();
  return changed;
}
