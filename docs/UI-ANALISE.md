# Análise da interface — Codebit 0.2.7

Data: 28/09/2026.

## Status: implementado em 28/09/2026

Todos os itens abaixo foram implementados, na ordem sugerida, mantendo a paleta. As capturas de depois estão em `docs/ui-analise/depois/`; as de antes continuam em `docs/ui-analise/`.

| Item                       | O que foi feito                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Caixas de seleção       | `label.checkbox` em linha; ligar e desligar virou interruptor (`Switch`).                                                                       |
| 2. Resultado das ações     | Codex, Claude e Devin informam o id de cada chamada; o runtime marca a linha com `ok`. Ícone por tipo, verde no sucesso e X vermelho na falha.  |
| 3. Títulos do markdown     | Escala própria: 20, 17, 15 e 14 px.                                                                                                             |
| 4. Diff                    | Lista de arquivos com tipo de mudança e +/−, clique leva ao arquivo; diff com cores, fundo nas linhas e dobra por arquivo.                      |
| 5. Carregando x vazio      | A aba Arquivos mostra "Carregando arquivos…" antes da listagem.                                                                                 |
| 6. Status na barra lateral | Ponto vermelho (falha), cinza (interrompida), âmbar (aguardando) e verde pulsando (trabalhando).                                                |
| 7. Texto pequeno           | Nenhum texto abaixo de 11 px; controles com 12 px; cores fracas elevadas para 4,5:1 ou mais.                                                    |
| 8. Textos                  | Aviso com inicial maiúscula; título do erro pela causa (rede, cota, tempo, CLI, login); `Ctrl K` no lugar da segunda lupa.                      |
| 9. Barra do composer       | Uma linha com chips (agente e modelo, imagens, sub-agentes), modo e envio; "Gerar imagem" no chip de imagens.                                   |
| 10. Barra de título        | 56 px, com o projeto ao lado do nome da tarefa.                                                                                                 |
| 11. Barra lateral          | Seções recolhíveis e salvas, marca do agente e tempo em cada tarefa, rodapé em uma linha de ícones.                                             |
| 12. Configurações          | Navegação lateral: Agentes, Comportamento, Imagens, Skills, MCP e Aplicativo; cartões com linhas de configuração e campos numéricos curtos.     |
| 13. Popover de sub-agentes | Título, interruptor, campos em duas colunas e **Voltar ao padrão**.                                                                             |
| 14. Largura de leitura     | Coluna de até 880 px e `line-height` 1,65.                                                                                                      |
| 15. Pedido pendente        | Borda âmbar no cartão e faixa "O agente espera sua decisão · Ver" acima do composer.                                                            |
| 16. Tokens                 | Cerca de 55 variáveis em `styles/base.css`; fora delas restam só sombras e 4 casos especiais. Raios em 4, 6, 8 e 12 px.                         |
| 17. Componentes e CSS      | `Switch`, `AgentMark`, `ActivityIcon`, `SectionLabel`, `SettingRow`, chips e popover; CSS dividido em 9 arquivos por área, na ordem da cascata. |
| 18. Identidade por agente  | Marca e cores de Codex, Claude e Devin no avatar, na barra lateral, no quadro e no chip do agente.                                              |
| 19. Composer               | Campo com altura automática (`field-sizing: content`, até cerca de 8 linhas) e miniaturas dos anexos de imagem.                                 |
| 20. Atalhos e movimento    | `Ctrl+K`, `Ctrl+N` e `Ctrl+.`; popovers e painel com transição curta, respeitando "reduzir movimento".                                          |

Medido depois: o custo por tecla na conversa longa (900 mensagens) caiu de 7,7 ms para 2,0 ms.

A análise original segue abaixo, sem alterações.

Base: capturas feitas com dados de exemplo em 1536×1000 e 1180×780 (pasta `docs/ui-analise/`) e leitura de `src/renderer/styles.css` e dos componentes.

## Resumo

A paleta funciona bem e deve ser mantida:

- o fundo grafite esverdeado (`#111518`), o verde de destaque (`#64ce8e`) e os estados âmbar, vermelho e laranja do Bypass são coerentes;
- o contraste de cor é bom na maior parte do texto (texto normal com 14,7:1, texto secundário com 6,8:1).

Os problemas estão em outros pontos:

1. **Tamanho do texto e densidade.** Há 38 regras com fonte de 8 a 10 px, justamente nos controles mais usados: a barra do composer, os modos e a barra de status.
2. **Espaço vertical.** A barra de título tem 79 px e o composer com a barra de seletores ocupa de 2 a 3 linhas. Em 1180×780, a conversa fica com cerca de 370 px de altura.
3. **Inconsistência do sistema visual.** São 221 cores hexadecimais diferentes para apenas 8 variáveis, com 46 cores de borda, 61 de fundo e 105 de texto. Existem 16 tamanhos de fonte e 11 raios de borda. Muitas cores são quase iguais e cumprem o mesmo papel.
4. **Alguns defeitos visuais concretos**, listados em P1: caixas de seleção empilhadas, atividades com ✓ verde mesmo quando falham, títulos de markdown desproporcionais e diff sem cores.

## O que já funciona bem

- **Tela inicial** (`01-boas-vindas.png`): hierarquia clara, ações principais evidentes e status dos CLIs à vista.
- **Cartões de estado na conversa:** o aviso (âmbar), o erro (vermelho) e a aprovação se distinguem bem pela cor e pelo ícone.
- **Plano no painel lateral** (`05-plano.png`): ações claras (Abrir .md, Mostrar na pasta, Copiar) e a decisão repetida no topo.
- **Multitarefa** (`06-multitarefa.png`): os cartões mostram o agente, o status e a borda de falha, e cada um tem sua resposta rápida. O fundo pontilhado diferencia bem o modo.
- **Bypass em laranja:** comunica o risco sem precisar de um aviso fixo.

## P1 — Defeitos visuais e ganhos rápidos

Mudanças pequenas e localizadas.

### 1. Caixas de seleção empilhadas sobre o texto

`label` é global `flex-direction: column` (`styles.css:117`). Só `.modal .checkbox` e `.board-composer .checkbox` voltam para linha (`styles.css:1996`, `:2362`).

Por isso, em Configurações (Sub-agentes padrão, Proteção contra repetição, Notificações) e no popover de sub-agentes, a caixa aparece sozinha numa linha e o texto na linha de baixo (`04-popover-subagentes.png`, `07-configuracoes.png`).

- **Proposta:** uma regra global `.checkbox { flex-direction: row; align-items: center }`. Para ligar e desligar recursos, trocar a caixa por um **interruptor** (switch) no mesmo verde.

### 2. Atividade sempre com ✓ verde

Toda linha de atividade usa o ícone `Check` (`App.tsx:2068`). Em `02-chat.png`, os dois `curl` que falharam aparecem com ✓ logo antes do cartão "Ação interrompida". O runtime já recebe o evento `outcome` de cada ferramenta.

- **Proposta:**
  - ícone neutro pelo tipo de ação (terminal, arquivo, busca, sub-agente);
  - ✓ só quando houver sucesso confirmado;
  - ✕ vermelho quando falhar.

### 3. Títulos de markdown desproporcionais

`.markdown` não define títulos, então vale o `h2` global de 27 px (`styles.css:91`) e o `h1` padrão do navegador (2em). No painel do plano, "Etapas" (`h2`, 27 px) fica **maior** que o título do documento (`h1`, cerca de 26 px) (`05-plano.png`).

- **Proposta:** escala própria do markdown: `h1` 20 px, `h2` 17 px, `h3` 15 px, peso 600, margem superior de 1,2em. Com isso, o plano e as respostas ficam mais legíveis.

### 4. Diff sem cores

O painel Alterações usa o Monaco com `language="diff"` (`Inspector.tsx:172`), mas o Monaco não tem realce para diff. O resultado é texto puro (`02-chat.png`).

- **Proposta:**
  - linhas `+` com fundo verde translúcido e linhas `−` com fundo vermelho translúcido;
  - cabeçalho por arquivo com contagem (`src/mobs.ts +2 −1`) e seções recolhíveis;
  - a lista de arquivos (`git-status`) vira links que rolam até o arquivo.

### 5. "Esta pasta está vazia" durante o carregamento

A aba Arquivos mostra o estado vazio enquanto a listagem ainda carrega (`03-arquivos-carregando.png`, `Inspector.tsx:272`).

- **Proposta:** um estado "Carregando…", ou linhas-esqueleto, distinto do vazio.

### 6. Tarefas com falha não aparecem na barra lateral

A barra lateral só marca tarefas `running`, `waiting` ou `queued` (`App.tsx:2337`). "Revisar autenticação", que falhou, parece igual às outras.

- **Proposta:** ponto vermelho para `failed` e ponto cinza para `interrupted`, com título explicativo no hover.

### 7. Texto pequeno demais nos controles principais

| Onde                               | Hoje  | Proposto |
| ---------------------------------- | ----- | -------- |
| Rótulos da barra do composer       | 9 px  | 11 px    |
| Botões Planejar/Executar/Bypass    | 9 px  | 12 px    |
| Seletores de agente/modelo/esforço | 10 px | 12 px    |
| Dica "Enter para enviar"           | 9 px  | 11 px    |
| Barra de status                    | 10 px | 11 px    |
| "LOCAL" ao lado da marca           | 8 px  | 10 px    |

- **Regra geral:** nada interativo abaixo de 12 px e nada informativo abaixo de 11 px.

Três cores ficam abaixo de 4,5:1 e merecem subir um tom:

- a lupa do atalho de busca (3,6:1);
- a dica do composer (3,7:1);
- o ícone de escopo dos prompts (4,1:1).

### 8. Pequenos ajustes de texto

- O aviso da proteção começa com letra minúscula ("o agente tentou…") porque reaproveita o motivo que vai para o agente. Basta capitalizar ao exibir.
- O erro usa o título genérico "A execução precisa de atenção". Quando o erro tiver uma causa conhecida (CLI não encontrado, cota, rede), vale usá-la como título.
- A busca tem dois ícones de lupa, o do campo e o `⌕` à direita (`App.tsx:520`). Trocar o segundo por um atalho real (`Ctrl K`) ou removê-lo.

## P2 — Estrutura e espaço

### 9. Barra do composer: de 2–3 linhas para 1

Em 1536 px com o painel aberto, os seletores quebram em duas linhas: Sub-agentes desce sozinho e o modo fica à direita (`02-chat.png`). Em 1180 px são três linhas (`08-janela-1180.png`). O conjunto composer + barra ocupa cerca de 290 px.

- **Proposta:** uma linha de "chips" compactos dentro do rodapé do próprio composer, ao lado do clipe e do enviar:
  - `Claude · Opus 5.5 · Alto ▾` abre um popover com agente, modelo e esforço. O botão de atualizar catálogo fica dentro dele.
  - `Imagens: Codex · GPT Image ▾`, e o botão "Gerar imagem" entra nesse mesmo popover.
  - `Sub-agentes: Codex · 3 ▾`.
  - O modo segmentado `Planejar | Executar | Bypass` à direita.
- Os rótulos "Agente · modelo", "Esforço" etc. saem da tela e ficam como título do popover e `aria-label`.
- Ganho estimado: 70–90 px de conversa a mais, sem perder nenhuma opção.

### 10. Altura da barra de título e da marca

A barra de título e o bloco da marca têm 79 px (`styles.css:270`, `:434`), quase o dobro do comum em apps desktop.

Além disso, o subtítulo da tarefa ("Forja de Escória / pasta original") se repete na barra de status.

- **Proposta:**
  - reduzir ambos para 52–56 px;
  - manter o caminho só na barra de status, que já é clicável;
  - no título, deixar o nome da tarefa e um selo pequeno do projeto.

### 11. Barra lateral em janelas menores

Em 780 px de altura, os blocos fixos da barra lateral deixam espaço para **uma** tarefa visível (`08-janela-1180.png`). Esses blocos são: marca, Nova tarefa, busca, Multitarefa, três cabeçalhos de seção e três botões de rodapé com o rótulo "Seu workspace local".

- **Propostas:**
  - Seções recolhíveis de verdade. O `ChevronDown` do projeto hoje é decorativo (`App.tsx:598`). Guardar o estado aberto/fechado de Prompts, Conversas e cada projeto.
  - Rodapé compacto: Arquivadas, Skills e MCP e Configurações viram uma linha de ícones com dica, e a versão fica no hover.
  - Tarefas com uma segunda informação discreta: agente (monograma C/X/D) e "há 5 min".

### 12. Configurações: navegação única e seções agrupadas

Hoje "Skills e MCP" e "Configurações" abrem a mesma página com conjuntos de abas diferentes. O título da página também muda ("Agentes e modelos", "Suas ferramentas, no mesmo lugar."), enquanto a barra de título diz "Configurações" ou "Extensões do workspace".

A aba Agentes é uma rolagem longa com 8 seções soltas (`Settings.tsx:284–481`), que misturam instalação dos CLIs com o comportamento dos agentes.

- **Proposta:** uma única página de Configurações com navegação lateral interna:
  1. **Agentes:** CLIs, instalação, acesso e modelo padrão.
  2. **Comportamento:** modo das novas tarefas, sub-agentes padrão, proteção contra repetição e diretrizes.
  3. **Imagens.**
  4. **Skills** e **MCP**.
  5. **App:** notificações, atualizações e modo código.
- Cada seção vira um cartão no padrão "linha de configuração": título e descrição à esquerda, controle à direita.
- Campos numéricos (4, 6, 2) com cerca de 80 px, em vez da largura inteira (`07-configuracoes.png`).
- O botão "Skills e MCP" da barra lateral pode continuar, abrindo direto a seção Skills.

### 13. Popover de sub-agentes

Os rótulos usam 13 px (herdados do `label` global) enquanto o resto do popover usa 11 px. As margens de 17 px também são herdadas, e o popover não tem título (`04-popover-subagentes.png`).

- **Proposta:**
  - título "Sub-agentes" com o interruptor ao lado;
  - CLI e modelo lado a lado, esforço e quantidade lado a lado;
  - texto de ajuda em uma linha.
- **Função nova sugerida:** um link "Voltar ao padrão". Hoje, depois que uma conversa é ajustada, ela só volta a seguir o padrão se "Aplicar a todas" for ligado.

### 14. Largura de leitura da conversa

Sem o painel lateral, as linhas de texto passam de 1.100 px (`04-chat-sem-painel`). Linhas longas cansam a leitura.

- **Proposta:** limitar a coluna de mensagens a cerca de 820 px, centralizada, e deixar os blocos de código e tabelas ocuparem até a largura disponível.
- `line-height` do markdown: de 1,85 para 1,65. O texto continua arejado e cabe mais conteúdo por tela.

### 15. Pedido pendente mais visível

A aprovação pendente tem o mesmo peso visual dos cartões de aviso e erro. Se o usuário rolar para cima, nada perto do composer indica que o agente está esperando.

- **Proposta:**
  - borda esquerda âmbar no cartão pendente;
  - uma faixa fina acima do composer, "O agente espera sua decisão · Ver", que rola até o cartão.

## P3 — Sistema visual e polimento

### 16. Tokens de design (mantendo a paleta)

Consolidar as 221 cores em cerca de 25 variáveis. Os valores abaixo já existem no CSS e só passam a ter nome:

```css
:root {
  /* Superfícies, da mais funda para a mais alta */
  --bg: #111518;
  --surface-1: #151a1e; /* barra lateral, painel, barra de título */
  --surface-2: #1a2025; /* cartões, composer, entradas */
  --surface-3: #1f272d; /* popovers, hover */
  /* Bordas */
  --border: #2a3239;
  --border-strong: #37424b;
  --border-focus: #688679;
  /* Texto */
  --text: #e2e7e9;
  --text-2: #b4bfc7;
  --muted: #91a0aa;
  --faint: #7e8b96; /* nunca abaixo de 4,5:1 */
  /* Destaque */
  --green: #64ce8e;
  --green-strong: #338c59;
  --green-bg: #1c3027;
  --green-border: #2f5a42;
  /* Estados */
  --amber: #e8c77a;
  --amber-bg: #3a311a55;
  --amber-border: #6b5a2a;
  --red: #eaa7a1;
  --red-bg: #311f2355;
  --red-border: #613a3a;
  --bypass: #ffd9bd;
  --bypass-bg: #6b3a1f;
  /* Agentes */
  --codex: #cbebd8;
  --claude: #eccfb9;
  --devin: #c3d8f2;
}
```

Escalas:

- **Fonte:** 11, 12, 13, 14, 16, 20 e 27 px (hoje são 16 tamanhos).
- **Raio:** 4 (selos), 6 (controles), 8 (cartões) e 12 (modais) (hoje são 11).
- **Espaçamento:** múltiplos de 4 px.

### 17. Componentes base

Hoje, botões, selos e campos têm variações feitas uma a uma (`.quiet`, `.compact`, `.text-button`, `.subagents-toggle`, `.board-chip`, `.update-pill`…).

- **Proposta:** poucas variantes nomeadas:
  - `Button`: primário, secundário, fantasma e perigo, em tamanhos `sm` e `md`;
  - `Chip`;
  - `Badge`;
  - `Switch`;
  - `Segmented`;
  - `Card`;
  - `Popover`.
- O CSS de 2.654 linhas pode ser dividido por área (base, layout, chat, painel, configurações, multitarefa).

### 18. Identidade por agente

Codex, Claude e Devin já têm cores próprias nos monogramas das Configurações (verde, terracota, azul). Hoje elas só aparecem ali.

- **Proposta:** usar as mesmas cores de forma discreta em mais lugares:
  - no avatar das respostas (hoje sempre verde com `</>`);
  - no selo do agente no quadro Multitarefa;
  - no seletor de agente.

  Isso ajuda a ver quem respondeu o quê numa conversa com troca de agente.

### 19. Composer

- **Altura automática:** cresce com o texto de 1 a 8 linhas, em vez da altura fixa de 90 px com alça de redimensionar.
  - Precisa ser medido com o teste de digitação de conversa longa, porque houve trabalho recente de desempenho nessa área.
- **Anexos como miniaturas** quando forem imagens.

### 20. Atalhos e microinterações

- `Ctrl K` para buscar tarefas, `Ctrl N` para nova tarefa e `Ctrl .` para interromper.
- Transição suave ao abrir o painel lateral e os popovers.
- Hover nos itens da barra lateral com fundo `--surface-3`.

## Ordem sugerida

1. **P1 inteiro:** CSS e componentes pequenos, sem mudança de fluxo.
2. **Tokens (item 16) antes do P2.** Com as variáveis prontas, a barra do composer, as Configurações e a barra lateral já nascem consistentes.
3. **P2 nesta ordem:**
   - barra do composer (maior ganho de espaço);
   - barra de título;
   - barra lateral;
   - Configurações;
   - demais itens.
4. **P3** conforme houver tempo.

Os testes E2E usam principalmente papéis e rótulos acessíveis (`getByRole`, `getByLabel`). Mantidos esses nomes, a maior parte deles continua válida depois das mudanças.
