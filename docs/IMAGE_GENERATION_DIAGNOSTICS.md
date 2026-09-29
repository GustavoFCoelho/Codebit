# Diagnóstico de imagens vazias do Codex

## Problema e comportamento atual

Um evento `item/completed` de `imageGeneration` com `result` vazio e sem `savedPath` encerrava o canal do App Server imediatamente. Qualquer explicação posterior do agente ou erro final do turno era perdido. Isso impedia distinguir uma falha do provedor de uma resposta sem imagem; não demonstrava a causa original da geração falhar.

O estado é tratado em `src/main/codex-image-reply.ts`. Uma imagem vazia mantém o canal aberto até o fim do turno ou por até 30 segundos. O erro do turno tem prioridade sobre a explicação textual. Sem detalhe disponível, o retorno continua sendo explicitamente genérico. A espera total de dez minutos, cancelamento e limite de uma geração por tarefa permanecem.

O caminho `savedPath` também aguarda a leitura assíncrona, mesmo que `turn/completed` chegue antes dela. A leitura concluída fornece a imagem; uma falha de leitura mantém seu erro próprio.

## Registro local

Falhas do fluxo Codex salvam um JSON em `logs/image-generations/<uuid>.json`, dentro do diretório de dados do Codebit. O caminho aparece na mensagem de erro. A geração só libera a tarefa após a tentativa de gravação; se a gravação falhar, o erro original continua disponível com um aviso.

O registro contém os identificadores da sessão/turno, status da imagem, presença de resultado/caminho, tipo de falha, conclusão do turno e explicação posterior filtrada. Há limite de 80 eventos e 2.000 caracteres por texto. Não são gravados o prompt enviado, `revisedPrompt`, base64, caminho do anexo nem cabeçalhos de autenticação. Tokens conhecidos, atribuições de credenciais e conteúdo binário textual são removidos. Mensagens do provedor podem citar partes do pedido; o filtro não é um classificador universal de dados pessoais.

## Validação

Em 28/09/2026, passaram 22 testes focados em imagens e `npm run check`:

```powershell
npm test -- --run tests/images.test.ts tests/codex-image-reply.test.ts
npm run check
```

Os testes cobrem explicação posterior, erro final, limite de espera, cancelamento, sucesso após resultado vazio, leitura de `savedPath`, limite de uso, integridade do diagnóstico filtrado e liberação da tarefa para uma próxima geração. O teste de integração usa o CLI simulado com uma imagem vazia seguida de explicação tardia.

Nenhuma geração real foi necessária para os testes. Eles validam o tratamento dos eventos, não a disponibilidade do serviço nem o sucesso do conceito verde pendente no ArmorSmithER.

## Ativação

Esta é uma correção local no código 0.2.7, sem atualização de CLI ou dependências. A compilação prepara o novo núcleo; o processo já aberto precisa ser reiniciado para carregá-lo. No modo código, use o aviso de reinício do núcleo. O mecanismo do aplicativo aguarda tarefas em andamento antes de reiniciar.
