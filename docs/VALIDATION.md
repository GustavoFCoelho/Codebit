# Validação — Codebit

Ambiente: Windows 10 x64, Node 22.18, Electron 44.4.5. Data: 25/09/2026.

## 24/10/2026 — input lag em conversas com 10 mil entradas

- **Reprodução:** a consulta somente leitura ao banco local encontrou conversas de até 10.388 entradas. O teste anterior cobria 900; ampliado para 10.000, mediu 25,8 ms por tecla antes da correção, acima do limite de 10 ms.
- **Diagnóstico:** o custo dominante era o layout do histórico. Isolar a lista React e aplicar `content-visibility` por entrada não bastou: o navegador ainda verificava milhares de caixas.
- **Correção:** mensagens agrupadas em blocos de 100, com `content-visibility: auto` por bloco e retenção da altura medida. Todo o histórico continua no DOM. A lista React é memoizada, a busca de artefatos usa um mapa e os dados recebidos são aplicados como transições de menor prioridade que a digitação.
- **Resultado no E2E:** 2,2 ms por tecla em repouso e 2,5 ms com atualizações disparadas por `task.update`; layout de 0,5 e 0,6 ms, respectivamente. O teste mantém o limite de 10 ms. Essa medição cobre recarga do histórico por eventos, não uma sessão real de streaming do modelo.
- **Verificações:** chegada ao fim ao abrir a conversa, navegação até entradas antigas e limites entre blocos, preservação da posição durante atualização, nenhum caractere perdido e ocultar/mostrar contexto. Os E2Es de conversa longa, rascunhos e pensamentos passaram (3 testes), assim como o build.

## 24/10/2026 — atualização dos CLIs locais

- Codex CLI (npm): **0.159.3 → 0.164.0**, via `npm install -g @openai/codex@latest`.
- Claude Code nativo: **2.1.300 → 2.1.310**, via `claude update`.
- Claude Code WinGet: **2.1.292 → 2.1.302**, via `winget upgrade --id Anthropic.ClaudeCode --exact`.
- Antigravity CLI: **1.4.7**, já instalado; `agy update` confirmou que é a versão mais recente, e `agy models` respondeu.
- Devin CLI: **3000.11.216**, autenticado; cópia gerenciada pelo Devin Desktop, preservada. Atualize pelo próprio Desktop.
- A cópia do Codex **0.163.0-alpha.11.2** em `%LOCALAPPDATA%/OpenAI/Codex/bin` pertence ao aplicativo Codex e foi preservada; sua atualização é feita pelo aplicativo.
- `npm run build` passou. Smoke direto pelos adaptadores do Codebit passou com Codex 0.164.0 e Claude 2.1.310: descoberta, autenticação, resposta `CODEBIT_OK` e catálogo de modelos. Foi usada uma cópia temporária do smoke restrita a esses dois agentes.
- O E2E `native.spec.ts` parou antes de testar os CLIs: não encontrou o título inicial `O que vamos construir?` na interface atual. Conversa e retomada pela interface não foram revalidadas nesta atualização.
- O npm informou que não conseguiu limpar um executável antigo em uso (`EPERM`); a instalação nova foi concluída e validada, sem interromper sessões abertas.

## Antigravity CLI (em desenvolvimento)

- **Validação com o Antigravity CLI 1.4.3 real, em 20/10/2026:**
  - **Executar:** comandos aprovados e recusados, e ferramenta de um MCP externo aprovada.
  - **Bypass:** comando que apagaria um arquivo de antes da conversa parou para confirmação.
  - **Planejar:** comando aprovado e `.md` do plano capturado no painel **Plano**, com o projeto intacto.
  - MCPs do plugin expostos com nomes `codebit_<nome>`.
  - Hook aguardando 95 segundos por uma resposta do usuário.
  - Plugin funcionando numa pasta com espaço no caminho.
- **Integração:** um processo stream-json por turno, retomada por `--conversation`, plugin temporário com MCPs e diretrizes e hook `PreToolUse` consultando o bridge local. Se o hook não alcança o Codebit, a ferramenta é negada; escrever na pasta do plugin é negado em todos os modos.
- **Testes automatizados:** a cobertura da integração fica em `tests/antigravity.test.ts`.

## 14/10/2026 — Claude Code 2.1.300 (modo código, sem versão nova)

- **Claude Code atualizado:**
  - A instalação nativa (`~/.local/bin`, a que o Codebit usa) foi de 2.1.284 para 2.1.300 com `claude update`.
  - A do WinGet foi de 2.1.268 para 2.1.292, a mais nova disponível na origem do WinGet.
- **Validação com o Claude Code 2.1.300 real:**
  - O teste com os CLIs reais (`CODEBIT_NATIVE_TEST=1`, junto com o Codex CLI 0.159.3) passou: descoberta, catálogo, conversa e retomada da sessão.
  - Uma sessão com o Haiku em Bypass:
    - apagou sem perguntar uma pasta criada durante a conversa;
    - pediu uma única confirmação para a pasta que já existia antes, e o Claude não perguntou de novo;
    - mostrou o alcance com "1 arquivo já existia".
  - `get_context_usage` respondeu com as cinco partes do medidor de contexto.

## Depois da 0.2.7 — sub-agentes padrão e interface nova (modo código, sem versão nova)

- **Sub-agentes padrão:** em Configurações → Comportamento, com a opção de aplicar a todas as conversas. **Voltar ao padrão** faz uma conversa ajustada seguir o padrão de novo (a IPC `task.update` aceita `subagents: null`).
- **Interface:** propostas P1 a P3 de `docs/UI-ANALISE.md`, mantendo a paleta. O resumo por item está no próprio documento, com capturas de antes e depois.
- **Arquivar e excluir tarefas:** botões na linha da barra lateral, menu do clique direito e botões na barra de título. A exclusão (IPC `task.delete`) pede confirmação, recusa tarefas trabalhando e nunca altera a pasta do projeto.
- **Links para arquivos no chat:**
  - Caminhos no texto e em código inline viram links. Nomes soltos e pastas só depois de o Codebit confirmar que existem.
  - O processo principal acha o arquivo citado de uma subpasta, encurtado com `…`, com caminho absoluto antigo ou no estilo do Git Bash e do WSL.
  - Texto e código da pasta abrem no visualizador do painel.
  - Validado com o caso relatado: `dist/…_saia.zip` citado a partir de uma subpasta.
  - Rodaram 10 testes novos e o fluxo Electron de menções, ampliado.
- **Quadro de tarefas por projeto:**
  - fila "A fazer" com despacho automático quando o modo tarefas está ligado, respeitando o limite de simultâneas;
  - sessões internas fora das conversas;
  - canal `codebit_tasks` (`list_tasks` e `add_tasks`) em todas as sessões do projeto: o que o usuário pede numa conversa vai para "A fazer"; sugestões do agente e continuações das sessões internas ficam pendentes até a aprovação;
  - pausa automática após falha ao iniciar ou duas falhas seguidas.
- **Correção de um erro que já existia:** interromper uma conversa e excluí-la em seguida gerava um erro não tratado no processo principal, porque o fim da execução ainda consultava a tarefa apagada.
- **Claude Code atualizado:**
  - A instalação nativa (`~/.local/bin`, a que o Codebit usa) foi de 2.1.283 para 2.1.284 com `claude update`.
  - A do WinGet continua em 2.1.268, a mais nova disponível na origem do WinGet.
  - Uma chamada real com o Haiku respondeu normalmente.
- **Redes sociais (`codebit_social`):**
  - **Validação local:**
    - Cartão de aprovação com a prévia exata; nada é publicado antes de **Publicar**, recusar ou interromper.
    - Instagram contra um servidor que imita a API e baixa as imagens pelos endereços recebidos: token cifrado e renovado, post, carrossel, rótulo de IA, histórico e exclusão.
    - Patreon com o editor simulado.
    - Conversão real para JPEG no Electron:
      - 1080×1920 → 1080×1350 no feed;
      - 3000×1000 → 1440×754;
      - story sem recorte;
      - menos de 320 px é recusado.
    - Túnel `cloudflared` 2026.9.3 instalado pelo winget; um túnel rápido real respondeu pelo endereço público em 13 s.
  - **Ainda não validado com as contas reais:**
    - Instagram: falta o token da sua conta.
    - Patreon: os passos no editor do site dependem do layout atual da página.
- **Resultado das ações:** Codex (`item.id`), Claude (`tool_use_id`) e Devin (`toolCallId`) passam a identificar cada chamada. O runtime marca a linha da atividade com `ok`, e a conversa mostra sucesso ou falha.
- **A suíte unitária e de integração passou inteira (143 testes em 11 arquivos, incluindo trabalho paralelo em `codex-image-reply`).** Os testes novos desta etapa cobrem:
  - o padrão valendo para conversas sem ajuste e, quando sincronizado, para todas;
  - a marcação de sucesso nas ações do Codex e de falha nas do Claude;
  - a exclusão: o que é apagado, a pasta própria só quando pedido, a do projeto nunca, e a recusa com a tarefa trabalhando;
  - as redes sociais (9 testes);
  - o quadro de tarefas (10 testes, com o agente simulado):
    - nada começa com o modo desligado;
    - o limite de simultâneas e a fila;
    - desligar deixa terminar;
    - recomendações pendentes até aprovar;
    - pausa após duas falhas;
    - retomar na mesma sessão;
    - `codebit_tasks` em toda sessão de projeto, com o papel certo (sessão interna ou conversa), e em nenhuma conversa sem projeto;
    - o canal das conversas: pedido vai para a fila, sugestão fica pendente, `list_tasks`, início automático com o modo ligado;
    - a validação da ponte e as instruções por papel.
- **16 fluxos Electron passaram** (o de CLIs reais fica pulado, como sempre). Os fluxos novos:
  - tarefas criadas por uma conversa mostram a origem e abrem essa conversa;
  - criar, reordenar, editar e excluir no quadro de tarefas; aprovar e descartar recomendações; configurar o modo; abrir a sessão interna e voltar;
  - arquivar, restaurar e excluir pela barra lateral, pelo clique direito e pela barra de título;
  - conectar o Instagram e ver a prévia de um post para aprovar. Os demais foram ajustados aos novos caminhos:
  - chips do composer;
  - seções das Configurações;
  - **Voltar ao padrão**;
  - bloqueio dos sub-agentes quando sincronizados.
- **Digitação:** o custo por tecla na conversa longa (900 mensagens) caiu de 7,7 ms para cerca de 2 ms.

## Versão 0.2.7 — logo, modo código e imagens com esforço baixo

- **Logo:** a marca `</>` da interface virou o ícone do app. `npm run icon` gera o SVG, o PNG e o ICO (de 16 a 256 px), e os tamanhos pequenos usam traço mais grosso. O ícone foi conferido nos dois executáveis, extraído pelo Windows: no portátil e no `Codebit.exe`, gravado via `resedit` com `signExecutable: false`. A janela usa o mesmo ícone, e as notificações também, registrado em `IconUri`.
- **Modo código:**
  - `npm run shortcut` cria o atalho **Codebit** na área de trabalho, que abre o Electron do projeto nesta pasta.
  - Validação real, com build de verdade disparado pelo app: uma regra de CSS nova foi percebida e preparada, e o aviso "Interface atualizada · Recarregar" apareceu em 8,5 s. O núcleo não mudou, e a interface recarregou sem reiniciar. Ao restaurar o CSS, o app reconstruiu sozinho em 8 s.
  - Um comentário de CSS, que a minificação remove, corretamente não gerou aviso.
- **Imagens pelo Codex:** o turno de geração usa esforço `low` em vez do padrão do `config.toml` (era xhigh na análise de consumo).
- **99 testes unitários/de integração passaram.** Os novos cobrem o modo código:
  - várias mudanças seguidas viram um só build;
  - interface e núcleo são distinguidos;
  - um build com erro mantém a versão atual;
  - o build feito por um agente é percebido;
  - o reinício espera as tarefas terminarem e pode ser cancelado.

  Também passaram o esforço baixo nas imagens e esperas mais longas para catálogos com a máquina ocupada.

- **11 fluxos Electron passaram**, no código e no pacote `release/win-unpacked`, incluindo o novo fluxo do modo código: aviso, recarregar e reiniciar interceptado. O teste nativo com `CODEBIT_CATALOG_ONLY=1` também passou.

## Versão 0.2.6 — links para arquivos locais

- **Problema:** links que o Codex escreve para arquivos locais, como `[Cena Blender v004](D:/…/cena_v004.blend)`, davam "Link não permitido": todo link que não fosse imagem ia para o navegador, que só aceita `http`/`https`. Os links também não deixavam ver nem copiar o caminho.
- **Correção:** links locais (absolutos, `/D:/…`, `file://`, `~/…` ou relativos à pasta da tarefa, sem âncoras de linha) abrem no app padrão; imagens seguem abrindo no painel lateral. O botão direito abre um menu nativo com **Abrir no app padrão**, **Mostrar na pasta** e **Copiar caminho**, ou **Abrir no navegador** e **Copiar endereço** para a web. Programas, scripts, atalhos, instaladores e documentos com macro não abrem por link do chat. O painel dos prompts salvos segue as mesmas regras.
- **94 testes unitários/de integração passaram.** Os **10 fluxos Electron** e o teste nativo com `CODEBIT_CATALOG_ONLY=1` passaram no pacote `release/win-unpacked`. O fluxo de imagens mencionadas agora cobre:
  - uma cena `.blend` com caminho absoluto;
  - um `.md` relativo;
  - um `.bat`, que é bloqueado;
  - um arquivo inexistente;
  - o menu do botão direito, com a cópia do caminho.

  O teste troca `shell.openPath` e o menu nativo por versões que só registram, então nenhum programa é aberto.

## Versão 0.2.5 — primeira atualização pelo app

- Mesma funcionalidade da 0.2.4. Serve para a primeira atualização pelo botão **Atualizar**: na 0.2.4, ela aparece como versão nova assim que o `.sha256` é gravado.
- **93 testes unitários/de integração passaram.** Os **10 fluxos Electron** e o teste nativo com `CODEBIT_CATALOG_ONLY=1` passaram no pacote `release/win-unpacked`.

## Versão 0.2.4 — prompts salvos, conflitos, notificações, imagens mencionadas e atualização pelo app

- **93 testes unitários/de integração passaram.** Os novos casos cobrem:
  - prompts salvos: execução à parte, com o agente da tarefa aberta, o modo de cada prompt, aprovação no painel e "Levar para uma conversa" retomando a mesma sessão;
  - no Claude em só leitura, a recusa automática do `ExitPlanMode`;
  - o aviso de conflito entre conversas paralelas e as notificações de término, falha e espera;
  - o Bypass como modo padrão;
  - a detecção de caminhos de imagem no texto e no Markdown;
  - o atualizador: versão mais nova e completa, espera enquanto há trabalho, cancelamento e arquivo trocado depois de encontrado.
- **10 fluxos Electron passaram no pacote `release/win-unpacked`**, incluindo prompts salvos, imagens mencionadas e atualização. O teste de imagens confere que um `.txt` com bytes de PNG é recusado. O teste nativo com `CODEBIT_CATALOG_ONLY=1` também passou.
- **Validações reais:**
  - **Claude Code 2.1.283 (Haiku):** painel de prompts com resposta direta em só leitura e notificação do Windows ao terminar uma tarefa, com o registro `HKCU\Software\Classes\AppUserModelId\local.codebit.desktop` criado pelo app.
  - **Troca de versão entre duas builds reais:** a descompactada, ao clicar em Atualizar, abriu o portátil mais novo e se fechou. O novo esperou a antiga terminar, pegou a trava de instância única e abriu o mesmo banco cerca de 7 s depois, tempo da extração do portátil.
- **Dados:**
  - configurações novas: `notifications`, `defaultMode` e `updateFolder`;
  - prompts salvos como registros `prompt`;
  - avisos de conflito como entradas `warning`.

  Tarefas novas começam em Bypass; as existentes mantêm o modo. A atualização pelo app vale a partir desta versão; para chegar a ela, a troca ainda é manual.

## Versão 0.2.3 — sessão aberta com trabalho em segundo plano

- **Problema:** ao fim de cada turno, o Codebit encerrava o CLI. Com isso, matava os comandos e sub-agentes que o agente tinha deixado rodando em segundo plano.
- **Correção:** a sessão continua aberta enquanto houver trabalho em segundo plano. A próxima mensagem vai para ela, e as configurações da tarefa ficam bloqueadas até o fim. O Claude Code informa esse trabalho por `background_tasks_changed` e, quando ele termina, começa sozinho um turno para relatar o resultado. No Codex, contam os comandos que o turno deixou em andamento e as threads de sub-agentes. Os eventos dessas threads deixaram de encerrar ou preencher a conversa principal.
- **Validação com o Claude Code 2.1.283 real (Haiku):** pelo runtime, um comando `sleep 15` em segundo plano manteve a sessão aberta. O Claude relatou "Concluído" sozinho ao fim do comando, e só então a sessão fechou. Na interface, o aviso com **Interromper**, o status "Em segundo plano" e o bloqueio do seletor de agente apareceram e sumiram no momento certo.
- **Codex:** validado com o protocolo gerado pelo próprio CLI 0.157.0 e com testes simulados. Não houve teste real porque a cota semanal estava em 99%.
- **80 testes unitários/de integração passaram.** Os novos casos cobrem:
  - Claude: relato automático, mensagens de sub-agente fora da resposta, próxima mensagem na mesma sessão e interrupção;
  - Codex: comando deixado rodando e thread de sub-agente;
  - reinício do app com trabalho em segundo plano.
- **Correção extra:** uma execução que falhava depois de o runtime fechar gerava uma rejeição não tratada.
- **7 fluxos Electron** e o teste nativo com `CODEBIT_CATALOG_ONLY=1` passaram no pacote `release/win-unpacked`.

## Versão 0.2.2 — digitação rápida em conversas longas

- **Causa:** a cada tecla, o navegador refazia o layout da conversa inteira. Na maior conversa real desta máquina (1.289 entradas, cerca de 9 mil elementos), isso custava cerca de 34 ms por tecla, contra menos de 2 ms do React. A lista de mensagens e o histórico dos cards do quadro agora usam `contain: strict`, e o layout por tecla caiu para cerca de 1,6 ms.
- **Medição:** feita numa cópia do banco, sem alterar os dados originais. Custo total por tecla (React, estilo e layout): de cerca de 36 ms para cerca de 3,5 ms.
- **Teste:** o fluxo "chat longo" passou a medir também o layout forçado após cada tecla, com limite de 10 ms. Sem a correção ele falha (19,1 ms); com ela, passa (2,3 ms).
- **75 testes unitários/de integração passaram.** Os **7 fluxos Electron** e o teste nativo com `CODEBIT_CATALOG_ONLY=1` passaram no pacote `release/win-unpacked`.

## Versão 0.2.1 — multitarefa, fila, cota, diretrizes e conversas paralelas

- **75 testes unitários/de integração passaram**. Os novos casos cobrem:
  - a fila de mensagens: enviar em seguida, enviar na resposta em andamento pelo Codex (`turn/steer`) e envio automático ao terminar;
  - o quadro multitarefa com tarefas rodando em paralelo;
  - várias conversas do mesmo projeto rodando ao mesmo tempo, na mesma pasta;
  - a cota dos três agentes e a publicação no chat das imagens criadas pelo Codex;
  - o uso de contexto, as skills e os comandos oferecidos com `/`;
  - as diretrizes chegando a Codex, Claude e Devin, e as configurações antigas recebendo a diretriz padrão;
  - a nova descoberta automática quando a versão de um CLI muda;
  - a versão do app igual à do `package.json`.
- **7 fluxos Electron passaram no pacote `release/win-unpacked`**: quadro multitarefa, imagens, fluxo desktop (incluindo editar, salvar e restaurar as diretrizes), fila de mensagens, diff grande, chat longo com "Ocultar contexto" e helper MCP. O teste nativo com os CLIs reais também passou no pacote com `CODEBIT_CATALOG_ONLY=1`.
- **Validação com CLIs reais**, feita durante o desenvolvimento, antes e depois da atualização para Codex 0.157.0 e Claude Code 2.1.283 (Devin CLI 3000.10.31):
  - leitura da cota nos três agentes;
  - mensagem enviada durante uma resposta do Codex;
  - tarefas em paralelo no quadro;
  - geração de imagem pelo login do Codex, já no 0.157.0;
  - catálogo e seleção de modelos no pacote, com os CLIs atualizados.
- **Causa do erro 401 nas imagens e da falta do GPT-6 Sol e do GPT-6 Luna:** o Codex CLI 0.153.4 estava desatualizado. Com a mesma conta, o 0.153.4 lista só o GPT-6 Astra da família GPT-6; o 0.157.0 lista também o Sol e o Luna. A partir desta versão, o Codebit confere a versão dos CLIs ao fim das respostas e quando a janela volta ao foco. Se ela mudou, recarrega o catálogo sem reiniciar.
- **Dados:** a versão acrescenta campos opcionais às tarefas (`seen`, `context`, `queue`, `boardAt`) e às configurações (`guidelines`). As configurações salvas antes recebem a diretriz padrão. Não existe mais o status "Na fila" por pasta; registros antigos nesse status continuam sendo marcados como interrompidos ao reiniciar.

## Versão 0.2.0 — Devin, sub-agentes, bypass e imagens pelo Codex

- **49 testes unitários/de integração passaram**. Os novos casos cobrem:
  - a sessão ACP do Devin (streaming, aprovação, retomada sem repetir o histórico, modo bypass);
  - o bypass no Codex e no Claude;
  - a aprovação de ferramentas MCP pedida pelo Codex;
  - a troca de agente no mesmo chat, com o contexto perdido;
  - as conversas sem projeto;
  - os sub-agentes, com limite simultâneo e aprovações repassadas ao chat pai;
  - as imagens coladas;
  - a ponte MCP com credenciais separadas por ferramenta;
  - o provedor de imagens do Codex (geração, edição, limite de uso e cancelamento).
- **4 fluxos Electron passaram no pacote `release/win-unpacked`**. O fluxo desktop inclui o seletor de agente, o popover de sub-agentes, o modo Bypass, uma conversa sem projeto e uma imagem colada no campo de mensagem. O teste nativo com os CLIs reais também passou no pacote com `CODEBIT_CATALOG_ONLY=1`.
- **Validação com CLIs reais**, sobre o código-fonte desta versão (Codex 0.153.4, Claude Code 2.1.280 e Devin CLI 3000.10.31):
  - geração e edição de imagem pelo login do Codex;
  - troca Codex → Devin (SWE-2 Medium) no mesmo chat, com o Devin respondendo a partir do contexto do Codex;
  - o Codex delegando para dois sub-agentes Devin em paralelo pela ferramenta `run_subagents`;
  - Codex e Claude em Bypass criando um arquivo pelo terminal sem pedidos de aprovação.
- O Devin CLI 3000.10 inicia os servidores MCP recebidos via ACP, mas não os oferece ao modelo. Por isso o Devin, como agente principal, não usa `codebit_images` nem `run_subagents`; como sub-agente, funciona normalmente.
- A versão acrescenta campos opcionais às tarefas (`nativeIds`, `subagents` e outros) e às configurações (`defaultModels.devin`). Dados anteriores continuam válidos; tarefas antigas mantêm o provedor de imagens salvo.

## Versão 0.1.2 — modelos e esforço

- **32 testes unitários/de integração passaram**. Os novos casos verificam descoberta automática dos dois catálogos, deduplicação de consultas, falha de acesso com nova tentativa, descarte de respostas antigas, persistência da escolha e remoção de esforços incompatíveis. Os processos de teste recebem efetivamente o modelo e esforço enviados pelos adaptadores, inclusive ao retomar e restaurar o padrão.
- **5 testes Electron passaram**, incluindo os CLIs reais Codex 0.153.4 e Claude Code 2.1.280. O teste nativo começa sem verificação manual de acesso, confere as opções contra o catálogo, seleciona modelo/esforço pela interface, recarrega a janela e realiza duas mensagens curtas por agente, preservando o identificador da sessão. No Claude, também verifica a desativação do esforço ao selecionar um modelo sem suporte anunciado.
- A captura `docs/screenshots/models-effort.png` registra a interface real com o modelo e esforço selecionados.
- O mesmo teste de catálogo e seleção passou no payload empacotado `release/win-unpacked/Codebit.exe`, com `CODEBIT_CATALOG_ONLY=1` e sem novas mensagens de inferência.
- O catálogo é fornecido pelos CLIs e pode variar conforme instalação, conta e configurações. Modelos informados manualmente mantêm o esforço sob controle do CLI quando não há capacidades anunciadas.

Para conferir apenas catálogo, seleção e persistência no pacote, sem mensagens de inferência, combine `CODEBIT_NATIVE_TEST=1` e `CODEBIT_CATALOG_ONLY=1` ao executar `tests/e2e/native.spec.ts`.

## Versão 0.1.1 — abertura de tarefas com diffs grandes

O teste de regressão reproduziu `RangeError: Invalid string length` na versão anterior: após exceder o limite de captura, dados tardios ainda eram concatenados mesmo depois da rejeição da operação. A correção encerra a coleta antes de interromper o processo, fecha os pipes e verifica o limite em bytes antes de armazenar cada chunk.

- **25 testes unitários/de integração passaram**, incluindo saída tardia após limite e timeout, UTF-8 fragmentado, stderr limitado e diff Git grande.
- O painel agora limita o diff a 512 KB e a listagem a 128 KB, informa que a prévia está reduzida e evita reenviar a mesma consulta por tratar o truncamento como falha do Git.
- A regressão desktop cria uma tarefa com um arquivo gerado de 12 MB, verifica o aviso e continua navegando após o encerramento do processo Git.
- **4 fluxos desktop/MCP passaram no pacote 0.1.1**: abertura com diff grande, interface/persistência/terminal, edição/exportação de imagens com servidor simulado e helper MCP.
- O mesmo teste passou com `D:\Git\Arcane-mod`, em uma instância com dados isolados. O repositório e as tarefas existentes foram apenas consultados.
- A versão não altera o esquema do banco nem o diretório de dados.

Para repetir apenas a regressão: `npm run test:e2e -- tests/e2e/large-diff.spec.ts`. `CODEBIT_REGRESSION_PROJECT` permite consultar um projeto existente sem criar ou alterar arquivos nele; sem essa variável, o teste cria seu próprio repositório.

## Validação inicial — versão 0.1.0

| Camada                    | Validação                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tipos e build             | TypeScript estrito, esbuild e Vite concluídos                                                                                                                      |
| Protocolos e persistência | Testes com processos CLI simulados, streaming UTF-8, aprovações, perguntas, colisão de IDs JSON-RPC, fila por pasta, cancelamento, SQLite e worktrees              |
| Imagens                   | Contratos OpenAI/ComfyUI com respostas simuladas, seleção de modelo, falha de cota sem repetição, cancelamento, mapeamento de workflows e autorização da ponte MCP |
| Desktop empacotado        | Criação de projeto/tarefa, confiança, Monaco, PowerShell real, configurações, persistência após reabrir, isolamento do renderer e bloqueio de IPC desconhecido     |
| Imagens na interface      | Servidor HTTP local simulado, consulta de catálogo, anexo, edição SDXL, imagem renderizada pelo protocolo interno e exportação PNG                                 |
| Helper MCP empacotado     | Inicialização, listagem e chamada de ferramenta pelo protocolo stdio, executando o helper dentro do pacote ASAR                                                    |
| Codex real                | 0.153.4: descoberta, login existente, catálogo, resposta em streaming e retomada da mesma sessão                                                                   |
| Claude real               | 2.1.280: descoberta, login existente, catálogo, resposta em streaming e retomada da mesma sessão                                                                   |

Suíte unitária/integração: **19 testes**. Suíte desktop/MCP: **3 fluxos**. Suíte nativa opcional: **1 fluxo com os dois agentes, dois turnos por agente**. Os testes nativos usam pastas de teste e prompts sem ferramentas ou alterações de arquivos.

Não foi realizada uma geração em serviço real: não havia `OPENAI_API_KEY` no ambiente nem ComfyUI ativo na porta padrão. A configuração dessas credenciais/serviços e a qualidade das saídas dos modelos ainda precisam ser verificadas no ambiente de uso.

O Vite informa um bundle grande devido ao Monaco e suas linguagens. O editor usa workers locais e não depende de CDN. O artefato Windows é portátil, sem assinatura comercial.

## Reproduzir no pacote

Após `npm run package`:

```powershell
$env:CODEBIT_EXECUTABLE = "$PWD\release\win-unpacked\Codebit.exe"
npm run test:e2e -- tests/e2e/desktop.spec.ts
Remove-Item Env:CODEBIT_EXECUTABLE
```

Para incluir o teste dos CLIs reais, defina também `CODEBIT_NATIVE_TEST=1`. A validação do pacote usa o aplicativo extraído em `win-unpacked`, que é o mesmo payload incluído no executável portátil.
# DeepSeek — 24/10/2026

- Novo agente autenticado por API key no cofre existente. Catálogo dinâmico pela API oficial, incluindo contexto e esforço. Nenhuma chave real foi utilizada nesta validação.
- `npm test`: 277 testes passaram em 21 arquivos, incluindo 16 testes do DeepSeek (catálogo, erros de autenticação, ACP, retomada, aprovação, Bypass, Planejar, cancelamento, MCP e política de ferramentas).
- `npm run build`: passou. O bundler mantém o aviso de chunks grandes já existente.
- `tests/e2e/deepseek.spec.ts`: passou no Electron, verificando a presença do novo agente, campo password e habilitação do botão de salvar/consultar.
- Harness oficial `0.2.1-rc.2` instalado (antes ausente). Runtime Node `22.23.4` isolado instalado com SHA-256 conferido no manifesto oficial; Node geral `22.18.0` preservado.
- Inicialização ACP em Executar e retomada da mesma sessão em Bypass e Planejar validadas com o Harness real, sem chamar o modelo, usando uma credencial fictícia. O teste do catálogo também cobre troca de chave com uma consulta anterior ainda em andamento. A inferência real e o catálogo da conta do usuário dependem de cadastrar uma chave válida; não foram apresentados como validados.

# Digitação independente da janela — 24/10/2026

A caixa de mensagem agora mantém a atualização imediata do texto em um componente próprio (`DraftInput`). O restante da janela recebe o rascunho por uma transição React. Revisões impedem que uma atualização atrasada sobrescreva caracteres novos; envio e geração de imagem leem o texto atual, e cada edição atualiza o rascunho em memória antes da persistência habitual.

Build e TypeScript passaram. O E2E de rascunhos passou com troca de conversa, anexos, recarga e reinício. No E2E com 10 mil entradas, o processamento síncrono por tecla, incluindo layout forçado, foi de 0,8 ms em média (p95 4,3 ms) parado e 0,6 ms (p95 0,8 ms) durante atualizações. Também passaram digitação por teclado, edição no início do campo, substituição do conteúdo, navegação pelo histórico e filtros. Esses valores medem processamento do evento e layout no teste, não toda a latência física entre teclado e exibição.
