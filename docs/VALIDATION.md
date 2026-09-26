# Validação — Codebit

Ambiente: Windows 10 x64, Node 22.18, Electron 44.4.5. Data: 25/09/2026.

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
