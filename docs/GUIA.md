# Guia do Codebit

Referência completa dos recursos. Para instalar e dar os primeiros passos, comece pelo [README](../README.md).

- [Conversas e agentes](#conversas-e-agentes)
  - [Projetos, tarefas e conversas sem projeto](#projetos-tarefas-e-conversas-sem-projeto)
  - [Modelos e esforço](#modelos-e-esforço)
  - [Trocar de agente](#trocar-de-agente)
  - [Devin CLI](#devin-cli)
  - [Modos de permissão](#modos-de-permissão)
  - [Plano no modo Planejar](#plano-no-modo-planejar)
  - [Fila de mensagens](#fila-de-mensagens)
  - [Comandos e sub-agentes em segundo plano](#comandos-e-sub-agentes-em-segundo-plano)
  - [Conflitos entre conversas](#conflitos-entre-conversas)
  - [Ocultar contexto, uso de contexto e cota](#ocultar-contexto-uso-de-contexto-e-cota)
- [Trabalho em paralelo](#trabalho-em-paralelo)
  - [Sub-agentes](#sub-agentes)
  - [Modo Multitarefa](#modo-multitarefa)
  - [Quadro de tarefas](#quadro-de-tarefas)
  - [Prompts salvos](#prompts-salvos)
  - [Chat rápido](#chat-rápido)
- [Arquivos, imagens e links](#arquivos-imagens-e-links)
  - [Painel lateral](#painel-lateral)
  - [Links para arquivos locais](#links-para-arquivos-locais)
  - [Imagens mencionadas no chat](#imagens-mencionadas-no-chat)
  - [Geração de imagens](#geração-de-imagens)
- [Extensões e integrações](#extensões-e-integrações)
  - [Skills e comandos no chat](#skills-e-comandos-no-chat)
  - [Servidores MCP](#servidores-mcp)
  - [Diretrizes para os agentes](#diretrizes-para-os-agentes)
  - [Secrets](#secrets)
  - [Redes sociais](#redes-sociais)
  - [Voz local com Vosk](#voz-local-com-vosk)
- [Interface](#interface)
  - [Notificações](#notificações)
  - [Proteção contra repetição](#proteção-contra-repetição)
  - [Confirmação antes de apagar](#confirmação-antes-de-apagar)
- [O aplicativo](#o-aplicativo)
  - [Modo código](#modo-código)
  - [Executável portátil e atualizações](#executável-portátil-e-atualizações)
  - [Dados, segurança e privacidade](#dados-segurança-e-privacidade)
- [Desenvolvimento](#desenvolvimento)

## Conversas e agentes

### Projetos, tarefas e conversas sem projeto

- **Projeto:** uma pasta do disco, adicionada pelo **+** de **PROJETOS**. Antes do primeiro uso, confirme **Confiar no projeto**: os CLIs poderão carregar instruções, hooks e servidores MCP da pasta. Sem essa confirmação, agentes e terminal ficam desabilitados.
- **Tarefa:** uma conversa com um agente dentro de um projeto (**Nova tarefa**, `Ctrl+N`). Por padrão, trabalha na pasta original do projeto. Em projetos Git, **Criar worktree isolada** dá à tarefa uma worktree própria, a partir do commit atual; alterações ainda não commitadas ficam na pasta original.
- **Conversa sem projeto:** o **+** de **CONVERSAS**. Usa uma pasta própria do Codebit e não pede confirmação de confiança.

Conversas do mesmo projeto rodam ao mesmo tempo na mesma pasta, sem esperar a vez. Divida o trabalho para que não editem os mesmos arquivos, ou use uma worktree. Terminais e programas externos também podem alterar a pasta.

As conversas têm streaming, interrupção, anexos de até 20 MB (vídeos, até 100 MB; imagens também podem ser coladas no campo), busca e arquivamento. O histórico fica num banco SQLite local. Cada tarefa guarda o identificador da sessão nativa do CLI, então a próxima mensagem retoma a mesma sessão, inclusive depois de reiniciar o Codebit.

Arquivar preserva a conversa, os arquivos e as worktrees. Ao fechar o Codebit, as sessões e o trabalho em segundo plano terminam; essas tarefas reabrem como interrompidas. Se o CLI tiver removido a sessão, crie uma tarefa ou transfira o contexto com **Continuar com outro agente**.

### Modelos e esforço

O primeiro chip abaixo da mensagem escolhe **Agente**, **Modelo** e **Esforço**. As listas vêm da instalação selecionada e do acesso configurado nela, sem tabela fixa de modelos. O catálogo é consultado ao abrir o app, independente por agente, e não envia mensagem ao modelo. O botão ↻ dentro do chip atualiza a lista. Falhas de autenticação ou catálogo aparecem em **Configurações → Agentes**.

Escolha um modelo explícito para habilitar os esforços que ele anuncia:

- No Codex, **Padrão · Médio**, por exemplo, aplica o padrão anunciado pelo modelo.
- No Claude, **Padrão do CLI** usa a configuração nativa.
- **Padrão do CLI**, no seletor de modelo, mantém a escolha nativa de modelo e esforço.

Modelos manuais, ou sem capacidades anunciadas, continuam disponíveis, com esforço controlado pelo CLI. Um esforço incompatível é limpo ao trocar de modelo. Mudanças de modelo e esforço valem a partir da próxima mensagem e preservam a sessão da tarefa. O modelo padrão de cada agente fica em **Configurações → Agentes**.

Integrações: [`model/list` e `turn/start` do Codex App Server](https://learn.chatgpt.com/docs/app-server) e [configuração de modelo e esforço do Claude Code](https://code.claude.com/docs/en/model-config).

### Trocar de agente

O seletor **Agente** troca o agente da tarefa sem sair da conversa. Cada agente retoma a própria sessão nativa. Na primeira mensagem depois da troca, o Codebit inclui o trecho da conversa que o novo agente ainda não viu, até cerca de 24 mil caracteres.

**Continuar com outro agente**, no topo da tarefa, cria uma tarefa nova ligada à original, com um resumo editável do contexto.

### Devin CLI

O Codebit usa o Devin CLI pelo protocolo ACP (`devin acp`). Ele encontra também a cópia instalada com o Devin Desktop, em `%LOCALAPPDATA%\Programs\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe`. O Devin Desktop não precisa estar aberto; o login é o do próprio CLI (`devin auth status`).

O catálogo vem de `devin models list` e inclui, por exemplo, SWE-2 High/Medium/Max. No Devin, cada variante já define o nível de raciocínio, então o seletor de esforço fica desativado.

Limitação do Devin CLI 3000.10: ele inicia os servidores MCP enviados pelo Codebit, mas as ferramentas MCP dele só enxergam os servidores configurados no próprio Devin. Por isso, como agente principal, o Devin ainda não usa as ferramentas internas do Codebit (imagens, sub-agentes, quadro de tarefas, redes sociais). O **Gerar imagem** do chip de imagens continua funcionando, e como sub-agente o Devin funciona normalmente.

### Modos de permissão

| Modo         | Codex                                                 | Claude              | Devin                                                       |
| ------------ | ----------------------------------------------------- | ------------------- | ----------------------------------------------------------- |
| **Planejar** | sandbox somente leitura                               | modo `plan`         | modo `plan`                                                 |
| **Executar** | `workspace-write`, com aprovações encaminhadas a você | modo `manual`       | `accept-edits`: edições aprovadas, comandos pedem aprovação |
| **Bypass**   | `approvalPolicy: never` com `danger-full-access`      | `bypassPermissions` | modo `bypass`                                               |

As aprovações, inclusive de ferramentas MCP, e as perguntas dos agentes aparecem na conversa. Os modos têm comportamentos diferentes em cada CLI: o Codebit não implementa um sandbox universal para ferramentas, MCPs ou terminal.

**Bypass** é o modo padrão das novas tarefas. O agente e os sub-agentes executam comandos e alteram arquivos sem perguntar, e o botão fica laranja quando ativo. Para começar em Planejar ou Executar, mude em **Configurações → Comportamento → Modo das novas tarefas**. Use Bypass só em pastas em que você confia.

### Plano no modo Planejar

No modo **Planejar**, o plano proposto pelo agente abre na aba **Plano** do painel lateral como um documento Markdown formatado (títulos, listas, tabelas e código), com **Abrir .md**, **Mostrar na pasta** e **Copiar**.

- **Claude:** o plano chega pela ferramenta `ExitPlanMode`, e o arquivo é o `.md` que o próprio Claude grava. No chat fica um cartão curto com **Ver plano**, **Continuar planejando** e **Aprovar e executar**; os mesmos botões aparecem no painel enquanto o agente espera. Ao aprovar, a tarefa passa para o modo padrão das novas tarefas (Bypass, ou Executar se o padrão for Planejar), inclusive na sessão em andamento.
- **Codex e Devin:** a resposta final no modo Planejar é o plano, salvo em `plans/<tarefa>.md` na pasta de dados do Codebit. O item de plano nativo do Codex, quando existe, também vai para a aba.

### Fila de mensagens

Enquanto o agente responde, o campo de mensagem continua livre. Enter, ou o botão de fila, adiciona a mensagem e os anexos à **Fila** da tarefa, acima do campo.

- Quando a resposta termina normalmente, o próximo item é enviado sozinho. Depois de uma falha ou interrupção, a fila espera você. Em projetos ainda não confiáveis, nada é enviado automaticamente.
- Cada item pode ser editado (Enter salva, Esc cancela), movido pelos botões ou arrastando, removido ou enviado na hora.
- **Enviar agora** manda direto quando o agente está parado. Durante uma resposta do Codex, a mensagem entra na resposta em andamento (`turn/steer`). No Claude e no Devin, que respondem uma mensagem por vez, ela passa a ser a próxima.

A fila fica salva na tarefa.

### Comandos e sub-agentes em segundo plano

Quando o turno termina com comandos ou sub-agentes ainda rodando, o Codebit não encerra o CLI, o que os interromperia. A conversa mostra quantos seguem em segundo plano, e a barra de status indica **Em segundo plano**. A próxima mensagem vai para a mesma sessão. O agente, a pasta, o modelo, o esforço e o modo ficam bloqueados até o trabalho terminar. **Interromper** encerra a sessão e tudo o que ela iniciou.

- **Claude Code:** comandos com `run_in_background` e sub-agentes em segundo plano. Quando terminam, o próprio Claude começa um turno para relatar o resultado. As ferramentas usadas pelos sub-agentes aparecem como `Sub-agente · …`.
- **Codex:** comandos que o turno deixou rodando, como um servidor de desenvolvimento, e sub-agentes em threads próprias. Como o Codex não retoma sozinho, a sessão fecha alguns segundos depois que tudo termina.
- **Devin:** o protocolo ACP não informa trabalho em segundo plano, então a sessão fecha ao fim do turno.

### Conflitos entre conversas

Quando duas conversas na mesma pasta alteram o mesmo arquivo em execuções que se sobrepõem, as duas recebem um aviso com o nome do arquivo e da outra conversa. Conversas uma depois da outra não geram aviso, e worktrees nunca entram em conflito.

A detecção usa as ferramentas de edição de cada CLI: `fileChange` no Codex, `Edit`/`Write` no Claude e as edições do Devin, inclusive as de sub-agentes. Alterações feitas por comandos de terminal (`sed`, scripts) não são detectadas.

### Ocultar contexto, uso de contexto e cota

- **Ocultar contexto**, no topo da tarefa, tira do chat as execuções de ferramentas e as aprovações já respondidas, deixando só a conversa. Pedidos pendentes, erros e imagens continuam visíveis. A escolha fica salva.
- **Uso de contexto**, na barra de status, mostra quanto da janela de contexto do modelo ainda está livre, com base no uso informado na última resposta. Codex e Claude informam o tamanho da janela junto com o uso; no Devin, ele vem do catálogo. Trocar de agente ou de modelo limpa a leitura até a próxima resposta.
- **Do que o contexto é feito:** clique no medidor. No Claude Code, o Codebit lê a composição ao fim de cada resposta, sem chamar o modelo (`get_context_usage`), e a mostra numa barra em quatro partes:
  - **Instruções:** prompt de sistema, diretrizes, instruções do Codebit e arquivos de memória (`CLAUDE.md`).
  - **Ferramentas:** as do Claude Code e as dos servidores MCP, por servidor.
  - **Skills.**
  - **Conversa:** dividida entre o que as ferramentas devolveram (arquivos lidos, saídas de comandos), chamadas, respostas e mensagens.

  Cada parte abre nos itens mais pesados. O painel também mostra a reserva de compactação, o espaço livre e as ferramentas adiadas (fora do contexto até o agente buscá-las), e dá uma dica quando faz sentido: integrações demais, uma conversa que cresceu por leituras ou o limite chegando. Os números são do próprio Claude Code. O Codex e o Devin informam só o total.

- **Cota**, na barra de status, mostra o maior uso entre as janelas do plano do agente. Clique para ver cada janela, o horário de renovação e o plano. A leitura vem do CLI, não gasta cota e é refeita a cada 2 minutos no máximo, ou pelo ↻.
  - **Codex:** `account/rateLimits/read` (janelas de 5 horas e semanal, créditos e plano).
  - **Claude:** o comando local `/usage` (sessão de 5 horas, semana e semana por modelo) e o `rate_limit_event` das respostas.
  - **Devin:** o plano de `devin auth status`. O Devin CLI não informa o saldo; use `/usage` no chat.

## Trabalho em paralelo

### Sub-agentes

No chip **Sub-agentes**, abaixo da mensagem, ative a delegação e escolha CLI, modelo, esforço e quantidade simultânea (1 a 8). O agente principal recebe a ferramenta `run_subagents` do MCP interno `codebit_agents`.

- Cada sub-agente roda uma tarefa independente, na mesma pasta e no mesmo modo da tarefa, sem acesso à conversa e sem MCPs internos.
- Chamadas acima do limite esperam na fila.
- O progresso e as aprovações dos sub-agentes aparecem na conversa principal.
- Como compartilham a pasta, peça tarefas que não editem os mesmos arquivos.

**Quando o agente delega.** Você não precisa pedir. Com os sub-agentes ligados, o agente principal fica sabendo:

- qual CLI e modelo estão do outro lado, e quantos rodam ao mesmo tempo;
- que deve delegar as partes independentes do pedido (pesquisas, revisões, análises, mudanças em arquivos ou módulos diferentes, testes) e fazer sozinho o trabalho curto, ou aquele em que cada passo depende do anterior;
- que, para delegar, deve preferir `run_subagents` aos sub-agentes nativos dele, como o Agent do Claude Code.

No Claude Code, as ferramentas do Codebit ficam sempre carregadas (`alwaysLoad`). Sem isso, o Claude Code adia ferramentas MCP atrás da busca de ferramentas e o modelo vê só o nome delas, por isso quase nunca as usava. Para ajustar quando delegar, escreva nas **Diretrizes para os agentes**.

**Padrão para todas as conversas:** em **Configurações → Comportamento → Sub-agentes padrão**, defina a configuração usada pelas conversas que não têm uma própria. Uma conversa passa a ter configuração própria quando você a ajusta no chip; **Voltar ao padrão** desfaz isso. Com **Aplicar a todas as conversas automaticamente**, todas seguem o padrão, inclusive as ajustadas, e o ajuste por conversa fica bloqueado. A configuração própria de cada conversa volta a valer quando você desmarca a opção.

### Modo Multitarefa

**Multitarefa**, na barra lateral, abre um quadro com várias tarefas lado a lado. Cada cartão mostra o agente, o modelo e o status; as últimas mensagens e execuções, com imagens; aprovações e perguntas pendentes, que dá para responder ali; o uso de contexto e a fila; e um campo de resposta.

- Para colocar uma tarefa no quadro, arraste-a da barra lateral até **Solte aqui para iniciar**, ou escolha-a no seletor da mesma área.
- **Descreva uma nova tarefa…**, embaixo, cria uma tarefa já no quadro e a inicia com essa mensagem. Você escolhe o projeto (ou sem projeto) e o agente, e a primeira linha vira o título.
- Os botões do cartão abrem a conversa completa, interrompem a execução ou tiram a tarefa do quadro sem apagá-la.

Todas as tarefas rodam ao mesmo tempo. Peça partes que não editem os mesmos arquivos, ou use worktrees.

### Quadro de tarefas

Cada projeto tem um quadro, aberto pela linha **Tarefas** do projeto na barra lateral.

**Colunas:**

- **A fazer:** a fila, com as tarefas que você cria (título e descrição opcional) e as recomendações aprovadas. Dá para reordenar, editar e excluir.
- **Em andamento:** tarefas trabalhando ou aguardando você.
- **Concluídas.**
- **Com problema:** tarefas que falharam ou foram interrompidas. **Tentar de novo** retoma a mesma sessão.

**Modo tarefas** (desligado por padrão):

- Ligado, o Codebit inicia um agente para a próxima tarefa de "A fazer" sempre que há lugar, até o limite de **Simultâneas** (1 a 4).
- No topo do quadro você escolhe agente, modelo, esforço e permissão (Executar ou Bypass). A escolha vale para as próximas tarefas que começarem.
- Desligado, nenhuma tarefa começa sozinha, e as que estão em andamento terminam normalmente. **Executar agora** inicia uma tarefa mesmo assim.
- Se uma tarefa não consegue começar, ou se duas seguidas falham, o modo se desliga e o Windows avisa. Assim, um CLI ausente ou uma cota esgotada não queimam a fila inteira.

**Sessões internas:** cada tarefa trabalha numa sessão própria, que não aparece nas conversas do projeto nem no Multitarefa. **Acompanhar** (ou **Abrir a sessão**) mostra essa sessão como um chat, onde dá para responder aprovações, mandar mensagens e interromper. Excluir a tarefa apaga a sessão, e vice-versa.

**Os agentes também usam o quadro.** Toda sessão de um projeto, conversa normal ou sessão interna, recebe o MCP interno `codebit_tasks`, com `list_tasks` (ver o quadro) e `add_tasks` (criar tarefas):

- **Numa conversa, o que você pede vai para a fila.** Por exemplo: "coloque no quadro: criar a dungeon e revisar os drops". As tarefas vão para "A fazer" com o selo **Conversa**.
- **O que o agente sugere por conta própria fica pendente,** em **Pendentes de aprovação**, com o selo IA.
- **Nas sessões internas, as tarefas de continuação também ficam pendentes.** Ao terminar, o agente recomenda o que achou (um bug, uma melhoria), e nada começa até você aprovar.

No cartão, **Da conversa: …** leva até a conversa que criou a tarefa, e **De: …** mostra a tarefa que a recomendou. **Aprovar** manda a sugestão para o fim de "A fazer"; **Descartar** a apaga. Conversas sem projeto não têm quadro.

### Prompts salvos

A seção **PROMPTS** do menu lateral guarda pedidos que você repete, criados pelo **+**. Cada um tem nome, texto, escopo (todos os projetos ou só um) e permissão (Só leitura, que é o padrão, Executar ou Bypass).

Clicar num prompt o executa numa sessão à parte, com o agente e o modelo da tarefa aberta. Ele não entra na conversa nem espera a fila dela. O resultado aparece num painel temporário, com as aprovações quando o modo pede. **Levar para uma conversa** cria uma conversa com o pedido e a resposta, que retoma a mesma sessão do agente; **Descartar** apaga a execução.

No Claude, "Só leitura" usa o modo de planejamento. Como o prompt nunca sai dele, o Codebit recusa sozinho o pedido de sair do planejamento, e o Claude responde direto.

### Chat rápido

**Chat rápido**, no menu lateral ou com `Ctrl+J`, abre um painel para dúvidas e execuções simples, fora das conversas:

- **Antes da primeira mensagem**, escolha o agente e a pasta: a de um projeto confiável (por padrão, o da conversa aberta) ou uma pasta temporária do Codebit ("Sem projeto"). O modelo é o padrão do agente nas Configurações.
- **A permissão** (Só leitura, Executar ou Bypass) vale para cada mensagem e pode mudar no meio do chat.
- **Cada mensagem** retoma a sessão da anterior, então o agente lembra do que já foi dito. As aprovações aparecem no próprio painel, e o quadrado interrompe a resposta.

Nada vai para o histórico. O chat continua ao fechar o painel ou recarregar a janela, e some ao clicar em **Nova** ou ao fechar o Codebit. **Levar para uma conversa** cria uma conversa com todas as mensagens. Enter envia, Shift+Enter quebra a linha e Esc fecha o painel.

## Arquivos, imagens e links

### Painel lateral

O painel lateral da tarefa tem as abas **Alterações**, **Arquivos**, **Terminal**, **Imagens** e **Plano**.

- **Alterações:** os arquivos alterados no Git, com o tipo de mudança e as linhas adicionadas e removidas. Clicar vai até o arquivo no diff, que pode ser recolhido por arquivo. A prévia do diff vai até 512 KB e a lista de arquivos até 128 KB; acima disso, um aviso indica a prévia parcial, e o restante fica para o Git no terminal.
- **Arquivos:** navegador de arquivos da pasta da tarefa, com prévia somente leitura.
- **Terminal:** PowerShell interativo na pasta da tarefa.
- **Imagens:** galeria das imagens da tarefa, com metadados, edição e exportação PNG.
- **Plano:** o plano do modo Planejar.

### Links para arquivos locais

Os caminhos de arquivos que os agentes escrevem no chat funcionam como links:

- links em markdown, como o Codex escreve: `[Cena](D:/projeto/cena.blend)`;
- caminhos no texto e em código inline, como `dist/pacote_v003.zip`, `C:\Users\…` ou `./docs/a.md`.

Nomes soltos em código inline, como `README.md`, e pastas, como `src/main`, só viram link depois que o Codebit confirma que existem; assim `console.log` ou `Node.js` continuam como texto. Âncoras de linha como `#L12` ou `:12` são ignoradas.

**Onde o arquivo é procurado.** Quando o caminho não existe exatamente como está escrito, o Codebit procura na pasta da tarefa:

- caminho relativo a uma subpasta onde o agente estava (`dist/x.zip`, quando o arquivo está em `blender/dist/x.zip`);
- caminho encurtado com `…` ou `...` (`…/x.zip`, `blender/…/x.zip`);
- caminho absoluto antigo ou de outra máquina, reconhecido pelo final;
- estilo do Git Bash e do WSL (`/d/Git/…`, `/mnt/d/…`).

Com várias versões do mesmo arquivo, abre a mais recente. Um nome solto repetido não é adivinhado. Pastas de dependências e caches (`node_modules`, `.git` e semelhantes) ficam fora da busca.

**Ao clicar:** imagens abrem no painel lateral; arquivos de texto e código da pasta da tarefa abrem na aba **Arquivos** (scripts são só exibidos); pastas abrem no Explorer; os demais arquivos abrem no app padrão do Windows (um `.blend` abre no Blender, por exemplo).

Com o botão direito, qualquer link mostra **Abrir no app padrão**, **Mostrar na pasta** e **Copiar caminho**, ou avisa que o arquivo não foi encontrado. Links da web mostram **Abrir no navegador** e **Copiar endereço**.

Por segurança, programas, atalhos, instaladores e documentos do Office com macro (`.exe`, `.lnk`, `.msi`, `.docm` e semelhantes) nunca abrem por um link do chat. Scripts (`.bat`, `.ps1`, `.py`) também não rodam: de dentro da pasta da tarefa, abrem só para leitura. Para esses casos, use **Mostrar na pasta** ou **Copiar caminho**.

### Imagens mencionadas no chat

Caminhos de imagem citados na conversa viram links: nas respostas (texto ou `código`), nas linhas de execução, como `Edit · C:\projeto\img\tela.png`, e nos anexos. Valem caminhos absolutos, `~/…` e caminhos relativos à pasta da tarefa. Ao clicar, a imagem abre na aba **Imagens** do painel lateral, com o caminho completo e os botões **Abrir no app padrão** e **Mostrar na pasta**.

Imagens em Markdown com caminho local (`![prévia](img/tela.png)`) aparecem no próprio chat. Formatos: PNG, JPEG, GIF, WebP, BMP e SVG. O Codebit só entrega arquivos com essas extensões, então um caminho citado no chat não expõe outros arquivos.

### Geração de imagens

O chip de imagens, abaixo da mensagem, escolhe o provedor e o modelo da tarefa. Escreva o pedido e use **Gerar imagem**, ou deixe o agente gerar pelo MCP interno `codebit_images`. Toda imagem gerada aparece no chat, inclusive as criadas pelo Codex com a ferramenta de imagem própria dele.

Para editar, anexe PNG/JPEG/WebP e clique no lápis do anexo, ou use **Editar** numa imagem gerada. Remova a referência para voltar à geração a partir de texto. Na aba **Imagens** do painel lateral ficam também as **Dimensões** e o **Fundo** (Automático, Transparente ou Opaco) da tarefa.

**Pelos agentes.** Com o MCP interno `codebit_images`, o agente usa o provedor e o modelo que você escolheu, e decide o resto a cada imagem:

- `generate_image` cria a partir do prompt; `edit_image` edita uma imagem ou cria uma nova a partir de várias referências (até 10, em ordem).
- As referências podem ser imagens geradas na tarefa, anexos seus ou **arquivos da pasta**, como `concepts/armadura_v2.png`.
- `aspect` escolhe o formato (quadrado, paisagem ou retrato) e `background: transparent` pede fundo transparente, para ícones, sprites e objetos recortados.
- `saveAs` grava uma cópia em PNG num caminho dentro da pasta da tarefa, criando as pastas que faltarem.
- O agente recebe o ID, o arquivo, as dimensões, se a imagem tem canal alfa e uma prévia reduzida (até 768 px), que gasta menos contexto. Se pediu transparência e ela não veio, recebe um aviso.

**Codex (login local), o padrão.** O Codebit inicia um App Server efêmero do Codex CLI, em sandbox somente leitura, e usa a ferramenta nativa de imagens com o login da máquina, sem chave de API. O uso conta nos limites da sua assinatura do Codex. O modelo de imagem é escolhido pelo Codex. **Verificar acesso** consulta se o provedor configurado no Codex oferece geração de imagens. O Codex também guarda uma cópia de cada imagem em `~/.codex/generated_images`.

Nesse caminho, quem escreve o prompt da ferramenta de imagem é um modelo do Codex, que por conta própria reescreve e expande o pedido. Por isso o Codebit marca o prompt e instrui o Codex a repassá-lo na íntegra, sem resumir nem acrescentar detalhes. Formato, fundo e número de referências vão depois dele. O Codex informa o prompt que de fato usou: se for diferente do enviado, a galeria mostra **O gerador alterou o prompt**, e o agente recebe esse texto (`revisedPrompt`) para comparar e ajustar. Formato e transparência são pedidos ao Codex, não parâmetros garantidos; a resposta ao agente diz o que veio.

Se o Codex concluir uma imagem sem arquivo, o Codebit espera o fim do turno, ou até 30 segundos, pela explicação. Falhas incluem o caminho de um diagnóstico em `logs/image-generations/`, na pasta de dados, sem o prompt, a imagem ou credenciais. Uma geração por tarefa pode ficar em andamento; peça várias imagens em sequência. Veja [o diagnóstico de geração de imagens](IMAGE_GENERATION_DIAGNOSTICS.md).

**API OpenAI.** Sem intermediário: o prompt, o tamanho, a qualidade, o fundo e as referências vão como parâmetros da API. Salve uma chave em **Configurações → Imagens**, ou abra o app com `OPENAI_API_KEY` no ambiente. A chave salva é cifrada pelo Windows (Electron safeStorage) e não volta para a interface. A conta da API é separada da assinatura do Codex. O catálogo de GPT Image é cruzado com `/v1/models`; um modelo listado ainda pode depender de acesso e cota. O app não repete sozinho gerações que falham.

**ComfyUI.** Inicie o servidor e salve o endereço (padrão `http://127.0.0.1:8188`). **Verificar conexão** consulta os nós e modelos instalados.

- Os presets incluídos usam SDXL para geração e edição; os checkpoints precisam ter nomes identificáveis como SDXL. Para edição, os presets trocam sozinhos para imagem-para-imagem. O ComfyUI usa uma imagem de entrada por vez e não aplica fundo transparente.
- Para outros modelos, exporte seu workflow no **formato API JSON**, importe-o e mapeie os campos, como `6.inputs.text`. Para edição, mapeie também `image` para o nó que recebe a imagem. O workflow precisa produzir PNG num nó de saída. Dependências ausentes aparecem no catálogo. Workflows próprios de edição precisam ser escolhidos por você no chip de imagens.

Cancelar encerra a espera do Codebit. Um pedido já enviado à OpenAI pode ser concluído e cobrado. No ComfyUI, o app remove só o próprio item pendente, sem interromper trabalhos de outros clientes.

## Extensões e integrações

### Skills e comandos no chat

Digite `/` no início da mensagem para abrir a lista de skills e comandos do agente da tarefa. Use ↑/↓ para navegar, Enter ou Tab para escolher e Esc para fechar. A lista vem do próprio CLI, na pasta da tarefa, e é atualizada a cada poucos minutos ou pelo ↻:

- **Claude:** comandos e skills anunciados pelo Claude Code, executados como `/nome argumentos`.
- **Codex:** skills de `skills/list`, inseridas como `$nome` e enviadas ao Codex como skill.
- **Devin:** skills de `devin skills list` e, depois da primeira mensagem, os comandos anunciados pelo ACP (`/compact`, `/context`…).

Em projetos ainda não confiáveis, a lista só aparece depois da confirmação, porque consultar o CLI carrega as configurações do projeto.

### Servidores MCP

Os CLIs continuam responsáveis pelas próprias configurações, extensões e permissões. Em **Skills e MCP**, no rodapé da barra lateral, o Codebit lista as skills locais nas pastas usuais do usuário e do projeto e os servidores MCP encontrados nas configurações dos CLIs. Plugins gerenciados pelo CLI podem funcionar mesmo sem aparecer nessa lista.

Servidores adicionados no Codebit, em **Configurações → MCP → Adicionar conexão**, recebem o prefixo `codebit_` e valem a partir da próxima execução, sem escrever nas configurações nativas. Para um servidor stdio, use o comando e os argumentos separados. Variáveis podem referenciar o ambiente sem copiar o segredo:

```json
{
  "id": "meu-servidor",
  "name": "meu-servidor",
  "agent": "both",
  "enabled": true,
  "transport": "stdio",
  "command": "C:\\ferramentas\\servidor.exe",
  "args": [],
  "env": { "TOKEN": "${MINHA_VARIAVEL}" }
}
```

- `agent` aceita `codex`, `claude`, `devin` ou `both` (todos os agentes).
- Para HTTP, use `transport: "http"` e `url`. O Devin recebe apenas servidores stdio.
- A autenticação interativa de servidores nativos continua no CLI.
- Os nomes `images`, `agents`, `social` e `tasks` são reservados às pontes internas do Codebit, que usam credenciais locais temporárias por tarefa.

### Secrets

Em **Configurações → Secrets**, guarde chaves de API e outros valores sensíveis, cada um com **Nome**, **Valor** e **Descrição**. Eles chegam a todas as sessões dos agentes como variáveis de ambiente: conversas, sub-agentes, chat rápido, prompts salvos, quadro de tarefas e o terminal do painel.

- **O nome é o da variável:** só letras sem acento, números e `_`, como `OPENAI_API_KEY`. O que você digita vira esse formato sozinho ("chave do projeto" → `CHAVE_DO_PROJETO`). Nomes do sistema e do Codebit (`PATH`, `TEMP`, `CODEBIT_…` e semelhantes) são recusados.
- **O agente não vê o valor.** Ele recebe só o nome e a descrição de cada secret, com a orientação de usar a variável (`$env:NOME` no PowerShell, `$NOME` no bash, `os.environ` no Python) e de nunca mostrar, registrar ou gravar o valor.
- **O valor não volta para a tela.** Ele fica cifrado com a chave do seu usuário do Windows. Para trocá-lo, edite o secret e digite o novo; deixar o campo vazio mantém o valor salvo.
- **Valores impressos são mascarados.** Se um agente imprimir o valor de um secret, o Codebit grava e mostra `[secret NOME]` no lugar, no chat, nas linhas de execução, nos sub-agentes e no chat rápido. Isso não desfaz o que o modelo já leu: a proteção principal é a orientação de não imprimir.
- **Login dos próprios CLIs.** Variáveis que um CLI lê para entrar na conta não vão para ele. Com `ANTHROPIC_API_KEY` no ambiente, por exemplo, o Claude Code troca a assinatura por cobrança na API. Por isso, secrets `ANTHROPIC_…` e `CLAUDE_…` não vão para o Claude, `CODEX_…` e `OPENAI_BASE_URL` não vão para o Codex, e `DEVIN_…` não vai para o Devin; eles continuam indo para os demais agentes. Para usar uma dessas chaves num script do próprio agente, dê outro nome a ela. O Codex mantém o login da assinatura mesmo com `OPENAI_API_KEY` no ambiente, então esse nome vai para ele normalmente.
- **Conexões MCP** podem usar um secret com `${NOME}` no campo `env`.
- **Imagens:** um `OPENAI_API_KEY` dos secrets também serve para o provedor **API OpenAI**, quando não há uma chave salva em **Configurações → Imagens**.

Mudanças valem a partir da próxima mensagem de cada conversa, e o terminal, a partir do próximo que for aberto. Se o `config.toml` do Codex restringir o ambiente dos comandos (`shell_environment_policy`), os secrets seguem essa regra.

### Diretrizes para os agentes

Em **Configurações → Comportamento → Diretrizes para os agentes**, escreva instruções permanentes. O Codebit as envia no início de cada sessão: no Codex, como instruções de desenvolvedor; no Claude, com `--append-system-prompt`; no Devin, que não tem prompt de sistema no ACP, junto da primeira mensagem. Diretrizes novas valem a partir da próxima sessão de cada tarefa. **Restaurar padrão** recupera o texto original.

A diretriz padrão autoriza o agente a atualizar uma ferramenta ou CLI desatualizado (Codex, Claude Code, Devin ou suas dependências) sem pedir confirmação. Quando a instalação é gerenciada por outro aplicativo, como o Devin CLI do Devin Desktop, o agente explica como atualizar em vez de forçar.

Ao fim de cada resposta e quando a janela volta ao foco (no máximo uma vez por minuto), o Codebit confere a versão dos CLIs. Se algum foi atualizado, inclusive pelo terminal, ele refaz a descoberta sem reiniciar e recarrega versão, login, catálogo, skills, comandos e cota.

### Redes sociais

Cada projeto pode ter um Instagram e um Patreon, conectados em **Configurações → Redes sociais**. Nas tarefas desse projeto, Codex e Claude recebem o MCP interno `codebit_social`, com `social_accounts`, `instagram_publish` e `patreon_publish`.

**Aprovação sempre:** cada publicação aparece no chat como um cartão com a prévia exata (conta, imagens, título, texto e público) e só sai depois de **Publicar**, mesmo em Bypass. Em Planejar, publicar fica desabilitado. O link do post aparece na conversa e no histórico **Publicações** do projeto.

**Instagram, pela API oficial:**

- Precisa de conta profissional (Empresa ou Criador de conteúdo).
- Para conectar:
  1. Crie um app em developers.facebook.com com o produto Instagram.
  2. Em "API com login do Instagram", adicione a conta e use "Gerar token".
  3. Cole o token em Configurações.
- O token fica cifrado pelo Windows. Ele vale 60 dias, e o Codebit o renova uma vez por semana enquanto está aberto.
- **Formatos:** post de uma imagem, carrossel de até 10 ou story. As imagens (PNG ou JPEG) viram JPEG de até 1440 px; no feed, são recortadas ao centro para caber entre 4:5 e 1,91:1, e a prévia já mostra o recorte.
- **Túnel:** o Instagram só busca imagens por um endereço público. Em cada publicação, o Codebit serve os arquivos do post por um túnel temporário do Cloudflare (`cloudflared`, sem conta) e o fecha em seguida. Se o `cloudflared` faltar, há um botão para instalá-lo pelo winget.
- Posts do Instagram podem ser apagados pelo histórico.

**Patreon, por automação do navegador:**

- A API do Patreon não cria posts. O Codebit abre o editor do site numa janela própria, logada na conta do projeto, e preenche título, texto, imagens e público.
- O login é feito na própria página do Patreon. Só a sessão fica salva, separada por projeto.
- **Público:** `public`, `members`, `paid` ou o nome exato de um nível. Se o Codebit não conseguir confirmar o público escolhido, não publica.
- **Falhas:** o rascunho fica aberto para você terminar, e um diagnóstico é salvo em `social/patreon-diagnostico.json` (com uma captura `.png`) na pasta de dados.
- **Testar sem publicar** preenche um post de teste e para antes de publicar.
- O Patreon pode bloquear automação, e os termos dele proíbem abusos técnicos: publique com moderação.

O Devin, como agente principal, ainda não usa essas ferramentas.

### Voz local com Vosk

A faixa **Voz**, abaixo do título da tarefa, permite dar instruções faladas a uma tarefa escolhida. Tudo roda na máquina: não há chave, chamada de API nem envio de áudio, e o Codebit não grava áudio em arquivos. O microfone começa **desligado** em toda abertura ou recarga.

**Preparar (uma vez), com Python x64 instalado:**

```powershell
npm run voice:setup
npm run build
```

O instalador cria `.voice/venv`, instala versões fixadas do PyPI e baixa o modelo `vosk-model-small-pt-0.3` (cerca de 31 MB, com SHA-256 conferido) do site oficial do Vosk. A pasta `.voice` fica fora do Git, e o app nunca instala componentes sozinho. Não mova o ambiente Python depois de criá-lo. No executável portátil, abra o app com `CODEBIT_VOICE_HOME` apontando para uma pasta `.voice` já preparada; no modo código, ela é encontrada sozinha.

**Usar:**

1. Abra **Voz**, clique **Verificar motor sem abrir microfone** e escolha a tarefa de destino.
2. Clique **Ativar microfone local**. Diga **Ei, Codebit**, espere **Ouvindo instrução** e fale uma instrução curta. O reconhecimento termina na pausa da fala, com limite de 20 segundos.
3. Revise ou corrija a transcrição e clique **Confirmar e enviar**. Se o agente estiver ocupado, o texto entra na fila.
4. **Pausar microfone** e **Desligar voz** ficam sempre visíveis.

A frase de ativação pode ser trocada com o microfone pausado; frases com palavras fora do vocabulário do modelo são recusadas com uma explicação. Os avisos falados (término, falha e quando a tarefa precisa de você) usam a voz local do Windows. Aprovações continuam na conversa.

**Limites:** o modelo pequeno erra com frequência, então a revisão antes de enviar é obrigatória. Voz humana real, distância, ruído e latência de hardware não foram validados. Veja [licenças e origem dos componentes](VOICE.md).

## Interface

- **Composer:** abaixo da mensagem ficam o anexo, três chips (agente e modelo, imagens, sub-agentes), o modo e o envio. Cada chip abre um painel com as opções; clicar fora ou Esc fecha. O campo cresce com o texto até oito linhas. Em janelas estreitas, os chips de imagens e sub-agentes mostram só o ícone.
- **Ações na conversa:** cada ação do agente tem o ícone do tipo (comando, leitura, edição, busca, web, MCP, sub-agente). Fica verde quando o CLI confirma o sucesso e vermelha, com um X, quando falha.
- **Pedido pendente:** a aprovação ou pergunta que espera você tem uma borda âmbar, e uma faixa acima do composer leva até ela (**Ver**).
- **Barra lateral:** Prompts, Conversas e cada projeto podem ser recolhidos. Cada tarefa mostra a marca do agente e há quanto tempo mudou, ou um ponto de status: verde pulsando (trabalhando), âmbar (aguardando você), vermelho (falhou) ou cinza (interrompida). Arquivadas, Skills e MCP e Configurações ficam no rodapé.
- **Arquivar e excluir:** passe o mouse sobre uma tarefa para ver **Arquivar** (ou **Restaurar**) e **Excluir**; o clique direito abre o mesmo menu, com **Abrir** e **Renomear**. **Excluir** pede confirmação e apaga, sem volta, o histórico, os anexos copiados, as imagens geradas e o plano da tarefa. A pasta do projeto nunca é alterada; numa conversa sem projeto dá para apagar também a pasta dela, e numa tarefa com worktree, remover a worktree (o branch continua no repositório). Tarefas trabalhando não podem ser arquivadas nem excluídas.
- **Rascunhos:** a mensagem que você está escrevendo fica guardada por conversa, com os anexos, até ser enviada, inclusive ao reiniciar o Codebit. Um lápis na barra lateral marca as conversas com mensagem não enviada. Rascunhos de conversas excluídas, ou com mais de 30 dias, somem sozinhos.
- **Remover projeto:** a lixeira no título do projeto, ou o clique direito (**Remover do Codebit…**), apaga do Codebit as conversas, o quadro de tarefas, os prompts salvos e as contas de redes sociais do projeto. **A pasta do projeto no disco não é alterada.** As worktrees criadas pelo Codebit só são removidas se você marcar a opção.
- **Configurações:** Agentes, Comportamento (diretrizes, modo das novas tarefas, sub-agentes padrão e proteção contra repetição), Imagens, Skills, MCP, Secrets, Redes sociais e Aplicativo (notificações, atualizações e modo código).
- **Atalhos:** `Ctrl+K` busca, `Ctrl+N` cria uma tarefa, `Ctrl+J` abre o chat rápido e `Ctrl+.` interrompe a tarefa aberta.

### Notificações

Com o Codebit em segundo plano, o Windows avisa quando uma tarefa termina, falha, precisa de você ou entra em conflito, e quando um prompt salvo ou o chat rápido termina. Clicar no aviso abre a tarefa. Com mensagens na fila, o aviso de término espera a última. Para o Windows mostrar notificações de um app portátil, o Codebit registra o próprio nome em `HKCU\Software\Classes\AppUserModelId\local.codebit.desktop` ao iniciar. Desative em **Configurações → Aplicativo → Notificações**.

### Proteção contra repetição

Um agente pode insistir numa ação que não funciona: um download que nunca chega, ou um comando que falha sempre do mesmo jeito. O Codebit se protege em duas camadas, para todos os agentes, sub-agentes, prompts salvos e o chat rápido:

- **Orientação:** as instruções enviadas aos agentes pedem que, depois de duas tentativas sem o resultado esperado, o agente pare e explique o problema.
- **Trava:** se o agente continuar, o Codebit interrompe a execução quando a **mesma ação** é tentada 4 vezes sem nenhum arquivo alterado entre as tentativas, ou quando **6 ações seguidas falham**. A conversa mostra o cartão **Ação interrompida pelo Codebit**, o Windows avisa, e na sua próxima mensagem o agente recebe o motivo da parada.

A ação é identificada pelo conteúdo (o comando completo, o endereço, os argumentos), não pela descrição que o agente escreve. Ler arquivos, buscar e acompanhar comandos em segundo plano não contam como tentativa, e editar um arquivo entre as tentativas conta como progresso. Os limites e a opção de desligar ficam em **Configurações → Comportamento → Proteção contra repetição**.

### Confirmação antes de apagar

Pedidos como "limpe a pasta" às vezes viram um comando que apaga muito mais do que o pretendido. Antes de um comando que apaga arquivos ou descarta trabalho, o Codebit mede o alcance:

- **Apagar:** `rm`, `del`, `rd`/`rmdir`, `Remove-Item` e seus apelidos, `find … -delete`, inclusive dentro de `pwsh -Command`, `cmd /c` e `bash -c`. Ele conta arquivos e pastas, soma o tamanho e lista os itens mais pesados. Ele acompanha o próprio comando: variáveis definidas nele (`BS=pasta && rm -rf "$BS/x"`), mudanças de pasta com `cd` (as de dentro de `( … )` valem só ali), curingas no nome do arquivo, variáveis de ambiente e caminhos do Git Bash (`/d/…`). O corpo de um heredoc (`python - <<'EOF' … EOF`) é texto para outro programa e não conta como comando.
- **Git:** `git clean -f` (pela simulação do próprio Git) e `git reset --hard`, `git checkout --` e `git restore`, que descartam alterações não salvas.

**Quando pergunta:**

- **Claude Code, em qualquer modo, inclusive Bypass:** um gancho antes de cada comando para os que passam dos limites (por padrão, 50 arquivos ou 1 GB). Também para os que apagam fora da pasta da tarefa, têm alcance impossível de medir (um caminho calculado na hora) ou descartam alterações do Git. Exclusões pequenas passam direto, e o que está na pasta temporária do sistema ou em pastas `tmp`, `temp`, `cache`, `__pycache__` e `node_modules` da tarefa não conta para os limites nem como "fora da pasta". Se você permitir, o comando roda sem uma segunda aprovação; se cancelar, o agente recebe o alcance que você viu e a orientação de não tentar por outro caminho.
- **Codex e Devin:** no modo Executar, o alcance aparece nos pedidos de aprovação que eles já fazem. No Bypass, esses CLIs não deixam interceptar o comando. No Codex em Executar, comandos dentro da pasta da tarefa costumam rodar no sandbox sem pedir aprovação. Para pedidos de limpeza, prefira o Claude, ou peça antes um plano no modo Planejar.

Os limites e a opção de desligar ficam em **Configurações → Comportamento → Confirmação antes de apagar**. A cobertura depende dos comandos que o Codebit reconhece: um script que apaga arquivos por conta própria, ou uma ferramenta MCP que faz isso, não passa por essa conferência.

## O aplicativo

### Modo código

Aberto por `npm start` ou pelo atalho criado com `npm run shortcut`, o Codebit roda direto de `dist/` desta pasta, com os mesmos dados do executável. Não é preciso empacotar:

- **Preparo automático:** ao detectar mudanças em `src/` (uma edição sua, de um agente ou um `git pull`), o Codebit espera 4 segundos sem novas alterações e roda a verificação de tipos e o build, em cerca de 10 segundos. Um `npm run build` rodado à parte também é percebido; os dois nunca escrevem em `dist/` ao mesmo tempo (trava em `dist/.build-lock`).
- **Com erro:** a versão em uso continua, o rodapé mostra **Código com erro** e a próxima mudança tenta de novo. O erro completo aparece em **Configurações → Aplicativo → Modo código**, onde também há **Preparar agora**.
- **Interface nova:** **Interface atualizada · Recarregar** recarrega só a janela, e os agentes continuam rodando.
- **Núcleo novo** (processo principal ou preload): **App atualizado · Reiniciar** espera as tarefas terminarem, fecha e reabre o Codebit na mesma tarefa, nas mesmas sessões dos agentes.

O build grava por último o selo `dist/build.json`, com o hash do núcleo e da interface; é ele que diz o que mudou. Se as dependências mudarem num `git pull`, feche o Codebit, rode `npm ci` e `npm run build` e abra de novo.

### Executável portátil e atualizações

`npm run package` gera `release/Codebit-<versão>-Windows.exe`, um executável portátil: não precisa instalar nem ter Node.js para rodar (instalações npm do Codex continuam usando o Node delas). Ele não é assinado, então o Windows SmartScreen pode avisar na primeira vez. Feche o executável antes de abrir pelo modo código: os dois compartilham os dados, e só um pode ficar aberto.

O executável procura versões novas na pasta de onde foi aberto, ou na pasta escolhida em **Configurações → Aplicativo → Atualizações do Codebit**, a cada minuto e quando a janela volta ao foco. Uma versão conta como disponível quando `Codebit-X.Y.Z-Windows.exe` tem ao lado um `.sha256` que confere com ele.

Com versão nova, o rodapé da barra lateral mostra **vX.Y.Z disponível · Atualizar**. Ao clicar, o Codebit espera nenhum agente estar trabalhando ou aguardando você (enquanto isso, o aviso oferece **Cancelar**), abre a versão nova e se fecha. A versão nova reabre na mesma tarefa, nas mesmas sessões dos agentes. Terminais abertos no painel lateral são fechados.

### Dados, segurança e privacidade

- **Onde ficam os dados:** `%APPDATA%\Codebit`, a mesma pasta no executável e no modo código, com `codebit.sqlite`, anexos, imagens e worktrees. Para backup, feche o app e copie a pasta. `CODEBIT_DATA_DIR` escolhe outra pasta.
- **Segredos:** os Secrets, a chave da OpenAI e os tokens do Instagram são cifrados pelo Windows e só podem ser lidos pelo mesmo usuário. As sessões do Patreon ficam em partições do Electron, uma por projeto, apagadas ao sair da conta em Configurações.
- **Isolamento:** a interface não tem acesso direto ao Node; usa um preload isolado e operações IPC validadas. A prévia de arquivos fica restrita à pasta de trabalho. Os CLIs rodam como processos nativos, sem interpolar prompts num shell.
- **Rede:** o Codebit não tem telemetria nem servidor próprio. Além dos próprios agentes, ele só acessa a rede quando você usa um recurso que precisa disso: a API de imagens da OpenAI, o ComfyUI, o Instagram, o Patreon e o túnel do Cloudflare.

## Desenvolvimento

Requer Node.js 22.18+ e npm. O Git é necessário só para diffs e worktrees.

```powershell
npm ci
npm run dev      # interface com recarga automática; reinicie após editar o processo principal ou o preload
npm run check    # verificação de tipos
npm test         # testes unitários e de integração (Vitest)
npm run build
npm run test:e2e # Electron real (Playwright)
npm run package  # executável portátil em release/
```

Os testes usam um agente simulado (`tests/fixtures/agent.mjs`) e um servidor de imagem local, e não consomem APIs externas. Para os testes opcionais com os CLIs e logins reais, que gastam um pouco da cota dos agentes:

```powershell
npm run smoke:native
$env:CODEBIT_NATIVE_TEST = '1'
npm run test:e2e -- tests/e2e/native.spec.ts
Remove-Item Env:CODEBIT_NATIVE_TEST
```

A última validação com CLIs reais usou Codex CLI 0.157.0 e Claude Code 2.1.283. `npm run test:voice-local` testa o caminho real da voz com áudio sintético, sem abrir o microfone.

**Estrutura:**

- `src/main/agents`: adaptadores de protocolo de cada CLI (Codex App Server, Claude Code stream-json, Devin ACP).
- `src/main/runtime.ts`: sessões, fila, sub-agentes, quadro de tarefas e execuções rápidas.
- `src/main/images.ts`: provedores de imagem. `src/main/store.ts`: persistência SQLite.
- `src/main/bridge.ts` e `src/main/image-mcp.ts`: as pontes MCP internas (`codebit_images`, `codebit_agents`, `codebit_tasks`, `codebit_social`).
- `src/preload`: a ponte restrita entre a interface e o processo principal.
- `src/renderer`: a interface React. Cores, raios e alturas vêm de variáveis em `src/renderer/styles/base.css`, e o CSS fica dividido por área.

O ícone (`build/icon.*`) é desenhado por `npm run icon`. Pendências e ideias ficam em [BACKLOG.md](BACKLOG.md).
