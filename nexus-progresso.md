# Nexus — progresso

Repositório: [pedaeadr-hash/Nexus](https://github.com/pedaeadr-hash/Nexus). Aplicação estática em HTML, CSS e JavaScript com sinalização PeerJS e mídia WebRTC. Publicação automática na Vercel a partir de `main`.

## Interface

- Identidade em preto, grafite e prata; símbolo geométrico próprio e ícones vetoriais.
- Navegação lateral no computador, trilho no tablet e navegação inferior no celular.
- Perfis com monogramas Cromo, Carbono e Polar, preparados para receber artes próprias.
- Transições de entrada/saída, hover, foco e preferência por movimento reduzido.
- Preferências de áudio, transmissão, aparência e interação social.

## Camada social

- Identidade persistente por navegador, com prova criptográfica para as conexões de dados.
- Solicitações de amizade, aceite, recusa, cancelamento, remoção e bloqueio.
- DMs com fila offline persistente, confirmação de entrega/leitura, respostas, edição e remoção.
- Chamadas privadas com aceite explícito e sessões de mídia autorizadas.
- Espaços nomeados, convites por link/DM e validade/renovação do convite.
- Canais de texto e voz independentes, configurados pelo anfitrião.
- Participantes e presença, voz em grupo e transmissão por chamada/canal.
- Busca, digitação, mensagens salvas, fixadas e contagem de não lidas.
- Controles da voz disponíveis durante a navegação, menu de canais no celular e liberação manual de áudio quando necessária.

## Verificação

36 testes automatizados de interface, modelo e protocolo social. Conferência de três perfis de demonstração em conexões PeerJS/WebRTC reais com mídia sintética, incluindo DMs, chamadas privadas, chat e voz em grupo e transmissão de tela recebida por outro participante. Imagens em `docs/social-desktop.jpg` e `docs/social-mobile.jpg`.

## Limites e próxima etapa

O anfitrião precisa permanecer conectado para manter o espaço disponível. Histórico e identidade ficam no navegador. DMs em fila precisam de remetente e destinatário conectados para serem entregues. As chamadas usam conexões entre participantes; não há backend persistente, contas recuperáveis, sincronização entre dispositivos, TURN próprio ou infraestrutura para grandes conferências.

Pendentes de definição: nome definitivo e arquivos dos ícones de perfil. Próxima etapa estrutural: backend de autenticação e mensagens, persistência e infraestrutura de mídia para disponibilidade contínua. Validação física entre dispositivos e navegadores distintos permanece necessária.
