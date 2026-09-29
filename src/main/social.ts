import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store";
import type { SocialAccount, SocialNetwork, SocialPost } from "../shared/types";
import { Instagram } from "./instagram";
import type { Hosted } from "./tunnel";
const day = 24 * 3600 * 1000;
// Patreon has no API to create posts: the post is written in its editor, in
// a Codebit window logged in to the project's account.
export interface PatreonDriver {
  status(projectId: string): Promise<{ loggedIn: boolean; name?: string }>;
  login(projectId: string): Promise<void>;
  logout(projectId: string): Promise<void>;
  // dryRun fills everything and stops before publishing, window open.
  publish(
    projectId: string,
    post: { title: string; text: string; images: string[]; audience: string },
    options?: { dryRun?: boolean },
  ): Promise<{ url: string }>;
}
export interface SocialDeps {
  store: Store;
  // Windows safe storage in the app; plain text in tests.
  encrypt(value: string): string;
  decrypt(value: string): string;
  // Writes a JPEG Instagram accepts, cropping the feed to 4:5–1.91:1.
  prepareImage(
    src: string,
    kind: "feed" | "story",
    out: string,
  ): Promise<unknown>;
  // A public address for each file while the post goes out.
  host(files: string[]): Promise<Hosted>;
  patreon: PatreonDriver;
  instagram?: Instagram;
  now?: () => number;
}
export class SocialService {
  private instagram: Instagram;
  constructor(private deps: SocialDeps) {
    this.instagram = deps.instagram ?? new Instagram();
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  accounts(projectId?: string) {
    return this.deps.store
      .all<SocialAccount>("social")
      .filter((a) => !projectId || a.projectId === projectId);
  }
  account(projectId: string, network: SocialNetwork) {
    return this.accounts(projectId).find((a) => a.network === network);
  }
  posts(projectId: string) {
    return this.deps.store
      .all<SocialPost>("post")
      .filter((p) => p.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private token(account: SocialAccount) {
    const saved = this.deps.store.secret(`social:${account.id}`);
    if (!saved)
      throw new Error(
        `O acesso ao ${account.name} não está salvo. Conecte a conta de novo em Configurações → Redes sociais.`,
      );
    return this.deps.decrypt(saved);
  }
  private save(account: SocialAccount, token?: string) {
    this.deps.store.put("social", account);
    if (token !== undefined)
      this.deps.store.setSecret(
        `social:${account.id}`,
        this.deps.encrypt(token),
      );
    return account;
  }
  // One Instagram account per project; connecting again replaces it.
  async connectInstagram(projectId: string, token: string) {
    token = token.trim();
    if (!token) throw new Error("Cole o token de acesso do Instagram.");
    const profile = await this.instagram.profile(token);
    if (/personal/i.test(profile.accountType))
      throw new Error(
        "Esta conta do Instagram é pessoal. A API só publica em contas profissionais (Business ou Creator); a conversão é gratuita, no app do Instagram.",
      );
    const old = this.account(projectId, "instagram");
    const now = this.now();
    let expiresAt = now + 60 * day;
    let refreshedAt: string | undefined;
    // A token just generated in the dashboard can only be renewed after
    // 24 hours; renewDue takes care of it later.
    try {
      const fresh = await this.instagram.refresh(token);
      token = fresh.token;
      expiresAt = now + fresh.expiresIn * 1000;
      refreshedAt = new Date(now).toISOString();
    } catch {}
    return this.save(
      {
        id: old?.id ?? randomUUID(),
        projectId,
        network: "instagram",
        name: "@" + profile.username,
        userId: profile.userId,
        accountType: profile.accountType,
        expiresAt: new Date(expiresAt).toISOString(),
        refreshedAt,
        createdAt: new Date(now).toISOString(),
      },
      token,
    );
  }
  async renew(accountId: string) {
    const account = this.deps.store.get<SocialAccount>("social", accountId);
    try {
      const fresh = await this.instagram.refresh(this.token(account));
      const now = this.now();
      return this.save(
        {
          ...account,
          expiresAt: new Date(now + fresh.expiresIn * 1000).toISOString(),
          refreshedAt: new Date(now).toISOString(),
          error: undefined,
        },
        fresh.token,
      );
    } catch (e) {
      this.save({ ...account, error: (e as Error).message });
      throw e;
    }
  }
  // Renews Instagram tokens once a week, well before the 60 days.
  async renewDue() {
    let changed = false;
    for (const a of this.accounts()) {
      if (a.network !== "instagram") continue;
      const now = this.now();
      const last = Date.parse(a.refreshedAt ?? a.createdAt);
      const old = now - Date.parse(a.createdAt) > day;
      if (!old || now - last < 7 * day) continue;
      changed = true;
      await this.renew(a.id).catch(() => {});
    }
    return changed;
  }
  async connectPatreon(projectId: string) {
    await this.deps.patreon.login(projectId);
    const status = await this.deps.patreon.status(projectId);
    if (!status.loggedIn)
      throw new Error(
        "O login no Patreon não foi concluído. Entre pela janela que abre e ela fecha sozinha em seguida.",
      );
    const old = this.account(projectId, "patreon");
    return this.save({
      id: old?.id ?? randomUUID(),
      projectId,
      network: "patreon",
      name: status.name || "Conta do Patreon",
      createdAt: new Date(this.now()).toISOString(),
    });
  }
  async remove(accountId: string) {
    const account = this.deps.store.get<SocialAccount>("social", accountId);
    if (account.network === "patreon")
      await this.deps.patreon.logout(account.projectId);
    this.deps.store.delete("social", accountId);
    this.deps.store.setSecret(`social:${accountId}`, "");
  }
  // The files exactly as Instagram will get them, shown in the approval.
  async prepareInstagram(
    postId: string,
    images: string[],
    kind: "feed" | "story",
  ) {
    const folder = join(this.deps.store.root, "social", postId);
    await mkdir(folder, { recursive: true });
    const out: string[] = [];
    for (const [i, src] of images.entries()) {
      const file = join(folder, `${i + 1}.jpg`);
      await this.deps.prepareImage(src, kind, file);
      out.push(file);
    }
    return out;
  }
  async publishInstagram(
    account: SocialAccount,
    post: {
      images: string[];
      caption: string;
      kind: "feed" | "story";
      altText?: string;
      aiGenerated?: boolean;
    },
  ) {
    const token = this.token(account);
    const left = await this.instagram
      .remaining(account.userId!, token)
      .catch(() => undefined);
    if (left !== undefined && left <= 0)
      throw new Error(
        "A conta atingiu o limite de publicações pela API nas últimas 24 horas. Tente mais tarde.",
      );
    const hosted = await this.deps.host(post.images);
    try {
      return await this.instagram.publish(account.userId!, token, {
        ...post,
        urls: hosted.urls,
      });
    } finally {
      await hosted.close();
    }
  }
  publishPatreon(
    account: SocialAccount,
    post: { title: string; text: string; images: string[]; audience: string },
  ) {
    return this.deps.patreon.publish(account.projectId, post);
  }
  record(post: Omit<SocialPost, "createdAt">) {
    return this.deps.store.put<SocialPost>("post", {
      ...post,
      createdAt: new Date(this.now()).toISOString(),
    });
  }
  // Instagram posts can be deleted through the API; Patreon ones on the site.
  async deletePost(postId: string) {
    const post = this.deps.store.get<SocialPost>("post", postId);
    if (post.network !== "instagram" || !post.mediaId)
      throw new Error("Apague este post pelo próprio site.");
    const account = this.deps.store.get<SocialAccount>(
      "social",
      post.accountId,
    );
    await this.instagram.remove(post.mediaId, this.token(account));
    return this.deps.store.put("post", {
      ...post,
      deletedAt: new Date(this.now()).toISOString(),
    });
  }
}
