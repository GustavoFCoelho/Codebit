import { request } from "node:http";
// A call from a helper process to the Codebit bridge. fetch gives up when
// the answer takes more than 5 minutes (undici's headersTimeout), and
// sub-agents, image jobs and the user's approvals take longer; node:http
// waits up to the given limit.
export function postBridge(
  url: string,
  token: string | undefined,
  body: string,
  limit: number,
) {
  return new Promise<{ ok: boolean; data: any }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              ok: res.statusCode === 200,
              data: text ? JSON.parse(text) : {},
            });
          } catch {
            reject(new Error("Resposta inválida do Codebit."));
          }
        });
      },
    );
    req.setTimeout(limit, () =>
      req.destroy(new Error("O Codebit não respondeu a tempo.")),
    );
    req.on("error", reject);
    req.end(body);
  });
}
