# Voz local — componentes e validação

O usuário autorizou a instalação do Vosk e do modelo português. A instalação é restrita a `.voice/` no projeto, sem alterar Python global, login, permissões de microfone ou inicialização do Windows.

| Componente | Origem e versão | Licença |
| --- | --- | --- |
| Vosk API | [PyPI](https://pypi.org/project/vosk/0.3.45/), 0.3.45; wheel Windows x64 | [Apache-2.0](licenses/vosk-Apache-2.0.txt), texto obtido do [repositório oficial](https://github.com/alphacep/vosk-api/blob/master/COPYING) |
| Modelo português | [Catálogo oficial](https://alphacephei.com/vosk/models), `vosk-model-small-pt-0.3`, 31 MB | Apache-2.0, conforme catálogo |
| Entrada de áudio | [sounddevice](https://pypi.org/project/sounddevice/0.5.5/), 0.5.5, PortAudio no wheel Windows | [MIT](licenses/sounddevice-MIT.txt); o arquivo inclui os avisos dos componentes empacotados |
| Saída de voz | System.Speech / Microsoft Maria Desktop já instalada no Windows | Componente do sistema, não redistribuído |

O ZIP veio de `https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip`. SHA-256 medido e fixado para instalações repetíveis: `6e1ce909032e1afa7a88e68a3d628ecafff302bdf195befab308826c395e93b7`. Este é um digest da cópia obtida por HTTPS, não uma assinatura fornecida pelo autor. Dependências Python estão fixadas em `scripts/voice-requirements.txt`; licenças adicionais acompanham os pacotes instalados.

## Verificações

- Modelo carregado em Python 3.13 x64, fora do processo Electron, evitando incompatibilidades de ABI de extensões Node.
- `probe` carrega o modelo e verifica PortAudio, sem abrir dispositivo; a consulta de voz do Windows também não grava nem fala.
- WAVs PCM mono 16 kHz/16 bits gerados pela Maria no próprio computador. Nenhum áudio enviado à rede.
- “Ei, Codebit” reconhecida na gramática de ativação; “codebit” é traduzida para as palavras conhecidas “code bit”. “Olá computador” validada como alternativa.
- Frases de comando e avisos sintéticos usados como negativos da frase “Ei, Codebit”. Isso não mede taxa de falsas ativações em ambientes reais.
- “Crie uma nova tarefa” transcrita exatamente; “Revise os arquivos do projeto” apresentou erro. Confiança numérica alta não garante texto correto.
- Ciclo real de estados, confirmação e anúncio validado com entrega a um simulador de tarefa. Nenhum CLI real iniciado.
- Saída falada validada em arquivo WAV e pelo evento de conclusão; qualidade audível em alto-falantes não foi testada.
- Microfone físico, permissões, taxa de amostragem suportada pelo dispositivo, sotaques, ruído e consumo prolongado ainda precisam de teste manual ao usuário ativar.

## Arquitetura

`VoiceController` mantém destino, revisão, fila, pausa e avisos. `VoskVoiceEngine` coordena o worker Python e a voz do Windows. O worker só cria `RawInputStream` após `listen`, encerra a entrada antes de entregar resultados e reconhece a frase com gramática restrita mais `[unk]`. Anúncios exigem confirmação de `pause` antes da síntese. `stop` encerra ambos os processos; IDs de requisição e geração descartam callbacks antigos.

O modo de reprodução de WAV só existe quando o worker recebe explicitamente `--test-audio-directory`; arquivos fora dessa pasta são recusados. O aplicativo não passa esse argumento. A saída de teste do Windows também é limitada ao diretório explicitamente configurado pelo teste. O fluxo normal não escreve áudio.
