# f8 Studio — Criador de Sites 8links

Ferramenta para criar sites profissionais a partir de referências visuais, sem precisar saber programar.
Feito para ser usado junto com o **Cursor** (editor com IA).

---

## 👉 [Clique aqui para ver o guia de configuração](https://htmlpreview.github.io/?https://github.com/medeirosjj123/f8/blob/main/docs/index.html)

> Como criar contas no GitHub e Vercel, baixar o Cursor, configurar o token e criar seu primeiro site.

---

---

## Início rápido

### Pré-requisitos
- [Bun](https://bun.sh) instalado (`curl -fsSL https://bun.sh/install | bash`)
- [Cursor](https://cursor.com) instalado
- Conta no [GitHub](https://github.com) e na [Vercel](https://vercel.com)

### Rodar o f8

```bash
cd f8
bun install
bun run dev
```

Acesse **http://localhost:4321** — o painel abre no navegador.

---

## Como criar um site (fluxo resumido)

1. **Abrir o f8** — rode `bun run dev` no Cursor e acesse http://localhost:4321
2. **Criar Site** — clique em "Criar Site" na sidebar, dê um nome ao projeto
3. **Capturar referência** — cole a URL do site que quer usar como modelo
4. **Gerar prompts** — clique em "Gerar prompts" (automático, sem configuração)
5. **Salvar + copiar** — salve os prompts e copie o comando
6. **Colar no Cursor** — abra o chat do Cursor (`Ctrl+L` / `⌘L`), modo **Agent**, cole e aguarde
7. **Publicar** — em "Meus Sites", clique em "Publicar na Vercel"

---

## Estrutura do projeto

```
f8/
├── src/
│   ├── pages/
│   │   ├── index.astro       # Painel principal (f8 Studio)
│   │   └── guia.astro        # Guia de configuração para iniciantes
│   ├── layouts/
│   └── styles/
├── scripts/
│   ├── capture-server.ts     # Servidor de captura (porta 3001)
│   ├── prepare-site.ts       # Cria scaffold de novo site
│   └── check-links-standalone.cjs
├── sites/                    # Sites gerados ficam aqui
│   ├── meu-site/
│   └── outro-site/
├── public/
│   └── reference/            # Screenshots e HTML capturados
├── data/
│   └── credentials.json      # Token do GitHub (local, não sobe pro git)
└── package.json
```

---

## Comandos

| Comando | O que faz |
|---------|-----------|
| `bun run dev` | Inicia o painel + servidor de captura |
| `bun run build` | Gera build de produção |
| `bun run kill-ports` | Mata processos nas portas 3001 e 4321 |
| `bun run dev:fresh` | Mata portas e reinicia o dev |

---

## Conectar site à rede 8links (PBN)

Após publicar o site na Vercel, adicione-o em **Sites da Rede** no painel 8links:

| Campo | Valor |
|-------|-------|
| `domain` | URL do site na Vercel (ex: `meu-site.vercel.app`) |
| `username` | `seu-usuario-github/nome-do-repo` |
| `application_password` | Token do GitHub (o mesmo configurado no f8) |
| `primary_niche` | Nicho principal do site |

A bridge 8links faz push dos posts via Git → Vercel faz deploy automático.

---

## Posts (formato Markdown)

Os posts ficam em `sites/[nome]/src/content/posts/` e seguem este formato:

```yaml
---
title: Título do post
description: Descrição para SEO
pubDate: 2025-03-07
draft: false
image: /imagens/capa.jpg
tags: [categoria1, categoria2]
---

Conteúdo em Markdown...
```

O slug é gerado pelo nome do arquivo: `meu-post.md` → `/blog/meu-post`
