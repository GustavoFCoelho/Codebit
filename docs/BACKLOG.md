# Pendências de melhoria — Codebit

Pedidos registrados para versões futuras. Cada item guarda o pedido original, a data e as notas iniciais. Pontos marcados como "a verificar" dependem de confirmação antes de implementar.

## Melhorias da interface

- **Pedido (28/09/2026):** analisar a interface geral e propor melhorias, mantendo a paleta de cores. Somente a análise foi feita; nada da interface mudou.
- **Status:** implementado em 28/09/2026, P1 a P3. A análise, o que foi feito em cada item e as capturas de antes e depois estão em [UI-ANALISE.md](UI-ANALISE.md).

## Conexões com redes sociais por projeto

- **Pedido (26/09/2026):** um módulo que facilite conectar redes sociais a projetos específicos, para que a IA consiga, por exemplo, publicar no Instagram e no Patreon.
- **Status:** implementado em 28/09/2026 (veja "Redes sociais" no README). Falta a validação real com as contas do usuário:
  - publicar um post de teste no Instagram;
  - rodar **Testar sem publicar** no Patreon e ajustar os passos pelo diagnóstico, se algum falhar.
- **Decisões (28/09/2026):**
  - a conta do Instagram já é profissional;
  - imagens hospedadas por túnel temporário (`cloudflared`);
  - Patreon por automação do navegador, com o risco aceito;
  - só Instagram e Patreon por agora.

### Ideia inicial

- **Conexões por projeto:** cada projeto guarda as próprias contas (Instagram, Patreon e outras), com as credenciais cifradas pelo armazenamento seguro do Windows, como a chave da OpenAI.
- **Ferramenta para os agentes:** um MCP interno, algo como `codebit_social`, no mesmo modelo de `codebit_images`, oferecido apenas nas tarefas do projeto conectado. Por exemplo: `publish_post({ rede, texto, mídia })` e `list_accounts()`.
- **Aprovação:** publicar é público e difícil de desfazer. Toda publicação mostraria uma prévia (texto, imagens e conta) e pediria aprovação, mesmo em Bypass.
- **Integração com o resto do Codebit:** usar imagens geradas pelo Codebit ou mencionadas no chat como mídia. Um rascunho poderia ficar num prompt salvo do projeto.

### Análise (26/09/2026)

Pesquisa nas documentações oficiais. As fontes estão ao fim de cada bloco.

#### Instagram: publicação oficial possível

- **API:** a "Instagram API with Instagram Login" (desde 07/2024) publica em contas **profissionais (Business ou Creator)** sem precisar de Página do Facebook. Conta pessoal não é suportada; a conversão é gratuita, no próprio app do Instagram.
- **Sem App Review para a própria conta:** o acesso padrão ("Standard Access") basta para contas com papel no app da Meta, ou seja, as suas. É preciso criar um app em developers.facebook.com, adicionar a conta e gerar o token no painel ("Generate access tokens"). Escopos: `instagram_business_basic` e `instagram_business_content_publish`.
- **Token:** o de longa duração vale 60 dias e é renovado sem o app secret (`GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`). Se passar de 60 dias sem renovar, é preciso gerar outro. O Codebit renovaria sozinho antes do prazo e avisaria se falhar.
- **Publicação:** cria o container (`POST /{ig-user-id}/media`), consulta `status_code` e publica (`POST /media_publish`). Dá para desfazer: `DELETE /{ig_media_id}`, desde 04/2026, com `instagram_manage_contents`.
- **Tipos:**
  - imagem **só JPEG**, até 8 MB, proporção de 4:5 a 1.91:1, 320 a 1440 px (os PNG gerados precisam ser convertidos, o que o Electron faz com `nativeImage.toJPEG`, sem dependência nova);
  - carrossel até 10 itens;
  - Reels em MP4/MOV;
  - Stories.
- **Texto:** legenda até 2200 caracteres, 30 hashtags e 20 menções. Há `alt_text` e, desde 06/2026, `is_ai_generated` (rótulo de conteúdo feito com IA), que o Codebit deveria marcar nas imagens geradas por ele.
- **Ponto crítico, a hospedagem:** a imagem precisa estar num **endereço público** (`image_url`). Não existe envio direto de imagem; o envio direto (resumable) é só para vídeo. Arquivos gerados no PC precisam de hospedagem pública temporária durante a publicação.
- **Limites:** de 50 a 100 publicações por API em 24h (a documentação diverge; consultar `GET /{ig-user-id}/content_publishing_limit` antes) e 400 containers em 24h.
- Fontes:
  - https://developers.facebook.com/docs/instagram-platform/overview/
  - https://developers.facebook.com/docs/instagram-platform/content-publishing/
  - https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
  - https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
  - https://developers.facebook.com/docs/instagram-platform/changelog

#### Patreon: a API oficial não publica posts

- **Sem escrita de posts:** a API v2 só lê posts (`GET /campaigns/{id}/posts`, `GET /posts/{id}`, escopo `campaigns.posts`, somente leitura). A equipe do Patreon confirma no fórum, de 2021 a 2023, que não há operações de escrita; pedidos seguem sem resposta até 2025. A única escrita nova (03/2026) é a de Lives, em acesso antecipado e sob pedido.
- **Nenhum atalho oficial:** Zapier, Make e IFTTT não têm ação de criar post. Não existe publicar por e-mail. O editor do site tem agendamento nativo ("Set publish date").
- **Automação do navegador:** os termos (05/2026) não citam bots explicitamente, mas proíbem abusar do Patreon "de forma técnica". Desde 07/2026, o Patreon bloqueia robôs via Cloudflare, o que pode atingir automação.
- **O que a API permite:** ler campanha, níveis (tiers), membros e posts publicados, e gerenciar webhooks (por exemplo, avisar de novo apoiador). O token do criador sai de "Clients & API Keys", dura cerca de 1 mês (duração oficial não confirmada) e é renovado com `refresh_token`. As chamadas precisam sair do processo principal, porque o Patreon não aceita chamadas feitas de dentro de páginas (CORS). Limite: 100 requisições por minuto por token.
- Fontes:
  - https://docs.patreon.com/
  - https://www.patreondevelopers.com/t/can-we-use-api-to-create-simple-posts/4542
  - https://zapier.com/apps/patreon/integrations
  - https://www.patreon.com/policy/legal
  - https://techcrunch.com/2026/07/17/patreon-stops-asking-ai-bots-not-to-scrape-and-starts-blocking-them/

#### Desenho proposto

- **Conexões por projeto** em Configurações (ou num painel do projeto): Instagram (token, conta e validade) e Patreon (token de leitura). Tudo cifrado com o armazenamento seguro do Windows, com aviso quando um token estiver perto de vencer.
- **MCP interno `codebit_social`** nas tarefas do projeto conectado:
  - `accounts()`;
  - `instagram_publish({ imagens, legenda, tipo, alt_text })`;
  - `patreon_campaign()`, que lê níveis e posts recentes para o agente escolher a visibilidade;
  - `patreon_draft({ título, texto, imagens, nível })`.
- **Aprovação sempre**, mesmo em Bypass: um cartão com a prévia exata (imagens já convertidas, legenda, conta) e os botões Publicar/Recusar. Depois de publicar, o link do post aparece no chat e fica num histórico do projeto; no Instagram, dá para apagar pelo mesmo histórico.
- **Instagram, fluxo:**
  1. converter para JPEG e ajustar a proporção;
  2. hospedar temporariamente;
  3. criar o container, esperar e publicar;
  4. apagar a cópia hospedada.
- **Patreon, modo assistido:** o Codebit monta o rascunho completo (título, texto formatado, imagens e nível sugerido) e abre o editor do Patreon. Você revisa e clica em publicar. Não automatiza cliques no site, então não esbarra nos termos nem no bloqueio de robôs.

### Decisões pendentes

1. **Conta do Instagram:** ela já é profissional (Business ou Creator)?
2. **Hospedagem temporária das imagens do Instagram:**
   - um bucket seu (Cloudflare R2 ou S3), com links que expiram, configurado uma vez;
   - um túnel temporário do próprio Codebit (por exemplo `cloudflared`), sem conta, aberto só durante a publicação;
   - outra hospedagem que você já use.
3. **Patreon:**
   - modo assistido (rascunho pronto e editor aberto; você publica), recomendado;
   - automação do navegador (preenche e publica sozinho), com risco de bloqueio e de violar os termos;
   - esperar uma API oficial.
4. **Mais redes:** quais além dessas duas (por exemplo X, YouTube, TikTok, Discord), e se entram no mesmo módulo.
