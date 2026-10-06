// Isolated component harness. No Codebit main process, real agents or audio APIs.
import React from "react";
import { createRoot } from "react-dom/client";
import { VoicePanel } from "../../src/renderer/Voice";
import { defaultVoice } from "../../src/shared/voice";
import "../../src/renderer/styles/base.css";
const handlers = new Set<(event: any) => void>();
let state: any = { phase: "off", enabled: false, options: defaultVoice };
const calls: any[] = [];
const emit = (patch: any) => {
  state = { ...state, ...patch };
  handlers.forEach((fn) => fn({ type: "voice", state }));
};
(window as any).voiceTest = { emit, calls };
(window as any).codebit = {
  onEvent: (handler: any) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
  call: async (method: string, args: any) => {
    calls.push({ method, args });
    if (method === "voice.state") return state;
    if (method === "voice.probe")
      emit({
        phase: "unavailable",
        capabilities: {
          recognizers: [],
          voices: [],
          reason: "Nenhum reconhecedor local compatível foi encontrado.",
        },
      });
    if (method === "voice.confirm") emit({ phase: "wake", draft: undefined });
    if (method === "voice.pause") emit({ phase: "paused", draft: undefined });
    if (method === "voice.stop")
      emit({ phase: "off", enabled: false, draft: undefined });
  },
};
const snapshot: any = {
  projects: [{ id: "p", name: "Projeto" }],
  tasks: [
    { id: "task-123456", title: "Revisar", projectId: "p", archived: false },
    { id: "task-987654", title: "Revisar", projectId: "p", archived: false },
  ],
  settings: {},
  agents: [],
};
createRoot(document.getElementById("root")!).render(
  <VoicePanel snapshot={snapshot} onOpen={() => {}} />,
);
