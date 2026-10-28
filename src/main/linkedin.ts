import { readFile } from "node:fs/promises";

// LinkedIn's versioned REST APIs release monthly. Keep this aligned with the
// current supported version documented by LinkedIn.
const version = "202610";

export interface LinkedInProfile {
  memberUrn: string;
  name: string;
}

export class LinkedIn {
  constructor(private base = process.env.CODEBIT_LINKEDIN_API || "https://api.linkedin.com") {}

  private async request(url: string, token: string, init: RequestInit = {}) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Linkedin-Version": version,
        "X-Restli-Protocol-Version": "2.0.0",
        ...(init.body instanceof Uint8Array ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      signal: AbortSignal.timeout(60_000),
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = body.message || body.error_description || body.error || `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403)
        throw new Error(`LinkedIn recusou o acesso (${response.status}). Confira se o token ainda é válido e se o aplicativo tem as permissões OpenID Profile e Share on LinkedIn (w_member_social).`);
      throw new Error(`LinkedIn: ${detail}`);
    }
    return { body, response };
  }

  async profile(token: string): Promise<LinkedInProfile> {
    const { body } = await this.request(`${this.base}/v2/userinfo`, token);
    if (typeof body.sub !== "string" || !body.sub)
      throw new Error("O token não retornou a identidade do perfil. Gere um token com OpenID Connect (openid e profile). ");
    const memberUrn = body.sub.startsWith("urn:li:person:") ? body.sub : `urn:li:person:${body.sub}`;
    return { memberUrn, name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Perfil pessoal do LinkedIn" };
  }

  async publish(memberUrn: string, token: string, text: string, image?: { path: string; altText?: string }) {
    let mediaUrn: string | undefined;
    if (image) {
      const init = await this.request(`${this.base}/rest/images?action=initializeUpload`, token, {
        method: "POST",
        body: JSON.stringify({ initializeUploadRequest: { owner: memberUrn } }),
      });
      const uploadUrl = init.body?.value?.uploadUrl;
      mediaUrn = init.body?.value?.image;
      if (typeof uploadUrl !== "string" || typeof mediaUrn !== "string")
        throw new Error("O LinkedIn não retornou os dados necessários para enviar a imagem.");
      const bytes = await readFile(image.path);
      const ext = image.path.split(".").pop()?.toLowerCase();
      const contentType = ext === "png" ? "image/png" : "image/jpeg";
      const uploaded = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: bytes,
        signal: AbortSignal.timeout(60_000),
      });
      if (!uploaded.ok) throw new Error(`LinkedIn: falha ao enviar a imagem (HTTP ${uploaded.status}).`);
    }

    const post: Record<string, unknown> = {
      author: memberUrn,
      commentary: text,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (mediaUrn) post.content = { media: { id: mediaUrn, ...(image?.altText ? { altText: image.altText } : {}) } };
    const { response } = await this.request(`${this.base}/rest/posts`, token, { method: "POST", body: JSON.stringify(post) });
    const id = response.headers.get("x-restli-id");
    if (!id) throw new Error("O LinkedIn publicou o conteúdo, mas não retornou o identificador do post.");
    return { id, url: `https://www.linkedin.com/feed/update/${id}` };
  }
}
