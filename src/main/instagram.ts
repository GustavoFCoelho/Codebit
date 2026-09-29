// Instagram API with Instagram Login: publishes to professional accounts
// (Business or Creator) with a token from the Meta developer dashboard.
// Tests point CODEBIT_INSTAGRAM_API at a fake server.
const version = "v23.0";
export interface InstagramProfile {
  userId: string;
  username: string;
  accountType: string;
}
export interface InstagramPost {
  urls: string[];
  caption: string;
  kind: "feed" | "story";
  altText?: string;
  aiGenerated?: boolean;
}
function describe(error: any, status: number) {
  const code = Number(error?.code);
  const text = error?.error_user_msg || error?.message || `HTTP ${status}`;
  if (code === 190)
    return "O token do Instagram é inválido ou expirou. Gere outro no painel da Meta e conecte de novo em Configurações → Redes sociais.";
  if ([4, 17, 32, 613].includes(code) || code === 9)
    return `O Instagram limitou as chamadas desta conta por enquanto: ${text}`;
  if (/media|image_url|download|fetch/i.test(text) && code !== 100)
    return `O Instagram não conseguiu buscar a imagem pelo túnel: ${text}`;
  return `Instagram: ${text}`;
}
export class Instagram {
  constructor(
    private base = process.env.CODEBIT_INSTAGRAM_API ||
      "https://graph.instagram.com",
    private wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  private async call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    token: string,
    params: Record<string, string> = {},
  ) {
    const url = new URL(`${this.base}/${path}`);
    let body: URLSearchParams | undefined;
    if (method === "POST")
      body = new URLSearchParams({ ...params, access_token: token });
    else
      for (const [key, value] of Object.entries({
        ...params,
        access_token: token,
      }))
        url.searchParams.set(key, value);
    const res = await fetch(url, {
      method,
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.error)
      throw new Error(describe(data.error, res.status));
    return data;
  }
  async profile(token: string): Promise<InstagramProfile> {
    const me = await this.call("GET", `${version}/me`, token, {
      fields: "user_id,username,account_type",
    });
    return {
      userId: String(me.user_id ?? me.id),
      username: me.username,
      accountType: me.account_type ?? "",
    };
  }
  // A new long-lived token, valid for another 60 days. Instagram renews
  // only tokens at least 24 hours old.
  async refresh(token: string) {
    const data = await this.call("GET", "refresh_access_token", token, {
      grant_type: "ig_refresh_token",
    });
    return {
      token: String(data.access_token),
      expiresIn: Number(data.expires_in) || 60 * 24 * 3600,
    };
  }
  // Posts left in the 24-hour window, when Instagram tells.
  async remaining(userId: string, token: string) {
    const data = await this.call(
      "GET",
      `${version}/${userId}/content_publishing_limit`,
      token,
      { fields: "quota_usage,config" },
    );
    const row = data.data?.[0];
    const total = Number(row?.config?.quota_total);
    return total ? total - Number(row.quota_usage || 0) : undefined;
  }
  private async container(
    userId: string,
    token: string,
    params: Record<string, string>,
    aiGenerated?: boolean,
  ): Promise<string> {
    // The AI label is recent; without it the post still goes out.
    if (aiGenerated)
      try {
        return (
          await this.call("POST", `${version}/${userId}/media`, token, {
            ...params,
            is_ai_generated: "true",
          })
        ).id;
      } catch (e) {
        if (!/is_ai_generated/i.test((e as Error).message)) throw e;
      }
    return (
      await this.call("POST", `${version}/${userId}/media`, token, params)
    ).id;
  }
  // Images are usually ready at once; Instagram may still be fetching them.
  private async ready(id: string, token: string) {
    for (let i = 0; i < 30; i++) {
      const { status_code } = await this.call(
        "GET",
        `${version}/${id}`,
        token,
        {
          fields: "status_code",
        },
      );
      if (!status_code || status_code === "FINISHED") return;
      if (status_code === "ERROR" || status_code === "EXPIRED")
        throw new Error(
          `O Instagram recusou a mídia (${status_code}). Confira o formato e a proporção da imagem.`,
        );
      await this.wait(2000);
    }
    throw new Error("O Instagram não terminou de processar a mídia a tempo.");
  }
  async publish(userId: string, token: string, post: InstagramPost) {
    const alt: Record<string, string> = post.altText
      ? { alt_text: post.altText }
      : {};
    let creation: string;
    if (post.kind === "story")
      creation = await this.container(
        userId,
        token,
        { image_url: post.urls[0], media_type: "STORIES" },
        post.aiGenerated,
      );
    else if (post.urls.length === 1)
      creation = await this.container(
        userId,
        token,
        { image_url: post.urls[0], caption: post.caption, ...alt },
        post.aiGenerated,
      );
    else {
      const children: string[] = [];
      for (const url of post.urls)
        children.push(
          await this.container(
            userId,
            token,
            { image_url: url, is_carousel_item: "true", ...alt },
            post.aiGenerated,
          ),
        );
      for (const child of children) await this.ready(child, token);
      creation = await this.container(userId, token, {
        media_type: "CAROUSEL",
        children: children.join(","),
        caption: post.caption,
      });
    }
    await this.ready(creation, token);
    const published = await this.call(
      "POST",
      `${version}/${userId}/media_publish`,
      token,
      { creation_id: creation },
    );
    const info = await this.call("GET", `${version}/${published.id}`, token, {
      fields: "permalink",
    }).catch(() => ({}) as any);
    return { mediaId: String(published.id), url: info.permalink as string };
  }
  async remove(mediaId: string, token: string) {
    await this.call("DELETE", `${version}/${mediaId}`, token);
  }
}
