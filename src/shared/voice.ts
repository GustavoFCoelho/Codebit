export interface VoiceOptions {
  wakePhrase: string;
  recognizerId: string;
  announcements: boolean;
}
export const defaultVoice: VoiceOptions = {
  wakePhrase: "Ei, Codebit",
  recognizerId: "",
  announcements: true,
};
export interface VoiceCapabilities {
  recognizers: { id: string; name: string; culture: string }[];
  voices: { name: string; culture: string }[];
  reason?: string;
}
export type VoicePhase =
  | "off"
  | "checking"
  | "unavailable"
  | "starting"
  | "wake"
  | "listening"
  | "review"
  | "sending"
  | "speaking"
  | "paused"
  | "error";
export interface VoiceState {
  phase: VoicePhase;
  enabled: boolean;
  options: VoiceOptions;
  capabilities?: VoiceCapabilities;
  taskId?: string;
  draft?: { id: string; taskId: string; text: string };
  message?: string;
  notice?: { taskId: string; text: string };
}
export interface TaskSignal {
  id: string;
  taskId: string;
  kind: "completed" | "failed" | "waiting";
  title: string;
}
