# Pendências de melhoria — Codebit

Pedidos registrados para versões futuras. Cada item guarda o pedido original, a data e as notas iniciais. Pontos marcados como "a verificar" dependem de confirmação antes de implementar.

## Conexões com redes sociais por projeto

- **Pedido (26/09/2026):** um módulo que facilite conectar redes sociais a projetos específicos, para que a IA consiga, por exemplo, publicar no Instagram e no Patreon.
- **Status:** pendente, ainda sem desenho aprovado.

### Ideia inicial

- **Conexões por projeto:** cada projeto guarda as próprias contas (Instagram, Patreon e outras), com as credenciais cifradas pelo armazenamento seguro do Windows, como a chave da OpenAI.
- **Ferramenta para os agentes:** um MCP interno, algo como `codebit_social`, no mesmo modelo de `codebit_images`, oferecido apenas nas tarefas do projeto conectado. Por exemplo: `publish_post({ rede, texto, mídia })` e `list_accounts()`.
- **Aprovação:** publicar é público e difícil de desfazer. Toda publicação mostraria uma prévia (texto, imagens e conta) e pediria aprovação, mesmo em Bypass.
- **Integração com o resto do Codebit:** usar imagens geradas pelo Codebit ou mencionadas no chat como mídia. Um rascunho poderia ficar num prompt salvo do projeto.

### A verificar antes de implementar

- **Instagram:** a publicação pela API oficial (Graph API da Meta) exige conta profissional (Business ou Creator) ligada a uma Página do Facebook, um app da Meta e um token. Confirmar requisitos, limites diários e formatos aceitos (imagem, carrossel, vídeo, Reels).
- **Patreon:** confirmar se a API oficial permite criar posts. Se não permitir, avaliar alternativas (automação do navegador, com cuidado com os termos de uso) ou deixar apenas o rascunho pronto para colar.
- **Tokens:** onde e como renovar os que expiram; o que mostrar quando uma conexão cai.
- **Mais redes:** quais além dessas duas (por exemplo X, YouTube, TikTok, Discord), e se entram no mesmo módulo.
