# Nexus — Progresso do Projeto

> App de chamada de voz/vídeo P2P no navegador, sem servidor, sem instalação.  
> Stack: HTML único · WebRTC · PeerJS · Vercel

---

## Repositório & Deploy

| Item | Valor |
|---|---|
| GitHub | `pedaeadr-hash/Nexus` |
| URL de produção | `nexus-adrian-c778.vercel.app` |
| Plano Vercel | Hobby (gratuito) |
| Arquivo principal | `index.html` |

---

## Histórico de decisões

### 1. GitHub — estrutura do perfil
- README do perfil (`pedaeadr-hash/pedaeadr-hash`) criado com vibe **clean e profissional**
- Destaque para o Callzin como projeto principal
- Badges de stack: HTML · CSS · JavaScript · WebRTC
- README do repositório `Nexus` criado separadamente

### 2. `.gitignore`
Arquivo minimalista — projeto não tem `node_modules`, `.env` nem `dist`:
```
.DS_Store
Thumbs.db
.vscode/
.idea/
*.log
```

### 3. Deploy na Vercel
- Preset: `Other` (não é Next.js)
- Root directory: `./`
- Sem variáveis de ambiente
- **Problema encontrado:** arquivo estava com nome `callzinFINAL_ESTAVEL_VOZ (1) (1).html`
- **Fix 1:** renomeado para `Index.html` — ainda quebrava (I maiúsculo, Linux é case-sensitive)
- **Fix 2:** `git mv Index.html index.html` + commit → deploy funcionou ✅

### 4. Link no WhatsApp abrindo página errada
- Estava compartilhando URL do dashboard da Vercel (`vercel.com/adrian-c778/nexus/...`)
- URL correta para compartilhar: `https://nexus-adrian-c778.vercel.app`
- Obtida clicando em **Visit** no painel do deploy ✅

---

## Limites do plano gratuito Vercel (Hobby)

| Recurso | Limite/mês | Uso estimado (10 pessoas/dia) |
|---|---|---|
| Banda | 100 GB | ~5 MB |
| Edge Requests | 1 milhão | ~300 |
| Deploys | 100/dia | — |

> O tráfego pesado (áudio/vídeo) é P2P direto entre os usuários — não passa pela Vercel.  
> Risco de exceder limite: **praticamente zero**.

---

## Melhorias aplicadas no código

### v1 — Qualidade adaptativa por dispositivo
**Problema:** celular usava Full HD 60fps por padrão, pesado demais para rede móvel.

**Fix:**
```js
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (!profile.screenQuality) profile.screenQuality = isMobile ? 'sd30' : 'fhd60';
```
- PC → Full HD 60fps (padrão anterior mantido)
- Celular → SD 30fps (854×480) automaticamente
- Usuário ainda pode mudar nas Configurações

**Resultado:** travamento melhorou ✅

---

### v2 — Redução de delay no celular
**Problema:** delay absurdo de áudio e vídeo juntos no celular.

**Causa raiz:** celular roteando pelo TURN server + jitter buffer conservador do navegador acumulando até 500ms desnecessários.

**Fixes aplicados:**

```js
// 1. Configuração WebRTC mais eficiente
config: {
  sdpSemantics: 'unified-plan',   // protocolo moderno, melhor suporte mobile
  bundlePolicy: 'max-bundle',     // áudio e vídeo no mesmo canal (menos overhead)
  rtcpMuxPolicy: 'require'        // reduz conexões paralelas desnecessárias
}

// 2. Zerar jitter buffer de áudio
if (receiver && receiver.jitterBufferTarget !== undefined) {
  receiver.jitterBufferTarget = 0; // sai assim que chega, sem acumular
}
```

**Commit:** `fix: reduce latency on mobile (jitter buffer, bundle policy, unified-plan)`

**Resultado:** delay reduziu significativamente ✅

---

## Limitações conhecidas no celular

| Funcionalidade | Status |
|---|---|
| Voz (microfone/áudio) | ✅ Funciona |
| Interface responsiva | ✅ Funciona |
| Link de convite | ✅ Funciona |
| Compartilhar tela | ❌ `getDisplayMedia` não suportado no mobile |
| Escolher saída de áudio | ❌ `setSinkId` não funciona no iOS Safari |
| iOS Safari geral | ⚠️ Funciona mas com restrições de autoplay |
| Melhor experiência mobile | ✅ Android + Chrome |

---

## Próximos passos em aberto

- [ ] Opção B de controle de qualidade: espectador pede pro transmissor baixar o bitrate via `dataConn`
- [ ] Domínio próprio (ex: `nexus.com.br`) para URL mais limpa
- [ ] Aviso no celular sobre limitação de compartilhamento de tela

---

*Última atualização: agosto de 2026*
