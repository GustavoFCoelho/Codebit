import type { DesktopAPI } from "../shared/types";
declare global {
  interface Window {
    codebit: DesktopAPI;
  }
}
export const api = <T = any>(method: string, args?: any): Promise<T> =>
  window.codebit.call<T>(method, args);
export const artifactUrl = (id: string) =>
  `codebit://artifact/${encodeURIComponent(id)}`;
// An image mentioned in a task's chat; relative paths use the task folder.
export const fileUrl = (taskId: string, path: string) =>
  `codebit://file/${encodeURIComponent(taskId)}?path=${encodeURIComponent(path)}`;
export const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
export const readBase64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
