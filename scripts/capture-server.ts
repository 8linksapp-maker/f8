/**
 * Servidor de captura de referência
 * - POST /api/capture: recebe URLs (Themeforest ou qualquer site)
 * - Para cada URL: screenshots viewport a viewport + page.html + styles.css + imagens
 * - Salva em public/reference/{slug}/
 * - Use como referência para criar o tema (não renderizamos o tema baixado)
 */
import puppeteer from 'puppeteer';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname =
  typeof (import.meta as unknown as { dir?: string }).dir !== 'undefined'
    ? (import.meta as unknown as { dir: string }).dir
    : dirname(fileURLToPath(import.meta.url));
const REFERENCE_BASE = join(__dirname, '..', 'public', 'reference');
const PROJECT_ROOT = join(__dirname, '..');
const CREDENTIALS_PATH = join(PROJECT_ROOT, 'data', 'credentials.json');
const VIEWPORT_WIDTH = 1920;

/** Lê credenciais: data/credentials.json prioriza sobre .env */
function loadCredentials(): { githubToken?: string; vercelToken?: string } {
  const cred: { githubToken?: string; vercelToken?: string } = {};
  try {
    if (existsSync(CREDENTIALS_PATH)) {
      const data = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
      if (data.githubToken) cred.githubToken = data.githubToken;
      if (data.vercelToken) cred.vercelToken = data.vercelToken;
    }
  } catch (_) {}
  if (!cred.githubToken) cred.githubToken = process.env.GITHUB_TOKEN;
  if (!cred.vercelToken) cred.vercelToken = process.env.VERCEL_TOKEN;
  return cred;
}

function getGitHubToken(): string | undefined {
  return loadCredentials().githubToken;
}

function getVercelToken(): string | undefined {
  return loadCredentials().vercelToken;
}

/** Injeta token na URL do remote (remove credenciais antigas) */
function injectTokenIntoUrl(url: string, token: string): string {
  return url.replace(/^https:\/\/(?:[^@\/]+@)?/, `https://${token}@`);
}

/** Extrai resumo do output do git commit (ex: "2 files changed, 10 insertions(+)") */
function parseCommitSummary(out: string): string | null {
  const m = out.match(/(\d+)\s+files?\s+changed[^.\n]*/);
  if (m) return m[0].trim();
  const m2 = out.match(/(\d+)\s+insertion[^.\n]*/);
  if (m2) return m2[0].trim();
  return null;
}

/** Garante user.name e user.email no repo para commits */
function ensureGitUser(cwd: string) {
  const hasName = spawnSync('git', ['config', 'user.name'], { cwd, encoding: 'utf-8' }).stdout?.trim();
  const hasEmail = spawnSync('git', ['config', 'user.email'], { cwd, encoding: 'utf-8' }).stdout?.trim();
  if (!hasName) spawnSync('git', ['config', 'user.name', '8links Hub'], { cwd });
  if (!hasEmail) spawnSync('git', ['config', 'user.email', 'hub@8links.local'], { cwd });
}
const VIEWPORT_HEIGHT = 1080;
const SCROLL_DELAY = 800;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugFromUrl(urlStr: string, index: number): string {
  try {
    const u = new URL(urlStr);
    const path = u.pathname.replace(/\/$/, '');
    const parts = path.split('/').filter(Boolean);
    return parts.length > 0 ? parts.join('-') : `page-${index + 1}`;
  } catch {
    return `page-${index + 1}`;
  }
}

async function fetchExternalCss(href: string, baseUrl: string): Promise<string> {
  try {
    const resolved = new URL(href, baseUrl).href;
    const res = await fetch(resolved, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (res.ok) return await res.text();
  } catch (_) {
    /* ignore */
  }
  return '';
}

function rmDirRecursive(dir: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) rmDirRecursive(full);
    else unlinkSync(full);
  }
  rmdirSync(dir);
}

/** Extrai URLs de imagens do HTML (img src, background-image) */
function extractImageUrls(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const origin = base.origin;
  const basePath = base.pathname.replace(/\/[^/]*$/, '/');
  const seen = new Set<string>();

  function resolve(href: string): string | null {
    if (!href || href.startsWith('data:') || href.startsWith('blob:')) return null;
    try {
      const u = new URL(href, origin + basePath);
      return u.href;
    } catch {
      return null;
    }
  }

  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(html))) {
    const url = resolve(m[1].replace(/&quot;/g, '"').trim());
    if (url) seen.add(url);
  }

  const bgRegex = /background-image\s*:\s*url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = bgRegex.exec(html))) {
    const url = resolve(m[1].replace(/&quot;/g, '"').trim());
    if (url) seen.add(url);
  }

  return Array.from(seen);
}

/** Baixa imagem e salva; retorna path relativo ou null */
async function downloadImage(
  imageUrl: string,
  imagesDir: string,
  index: number
): Promise<{ file: string; url: string } | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        redirect: 'follow',
      });
      if (!res.ok) {
        if (attempt === 2) console.log(`  \x1b[31m✖ HTTP ${res.status}:\x1b[0m ${imageUrl.slice(-50)}`);
        continue;
      }
      const contentType = res.headers.get('content-type') || '';
      let ext = '.png';
      if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';
      else if (contentType.includes('gif')) ext = '.gif';
      else if (contentType.includes('webp')) ext = '.webp';
      else if (contentType.includes('svg')) ext = '.svg';
      else {
        const u = new URL(imageUrl);
        const pathExt = extname(u.pathname);
        if (pathExt && ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(pathExt.toLowerCase())) ext = pathExt;
      }
      const filename = `img-${String(index).padStart(3, '0')}${ext}`;
      const buffer = await res.arrayBuffer();
      writeFileSync(join(imagesDir, filename), new Uint8Array(buffer));
      return { file: filename, url: imageUrl };
    } catch (e) {
      if (attempt === 2) console.log(`  \x1b[31m✖ Erro ao baixar:\x1b[0m ${(e as Error).message}`);
    }
  }
  return null;
}

interface PageResult {
  slug: string;
  url: string;
  files: string[];
  contentData?: ContentData;
}

interface ContentData {
  colors: { bg: string[]; text: string[]; accent: string[] };
  fonts: string[];
  sections: { tag: string; heading?: string; layout?: string; columns?: number }[];
  nav: string[];
  buttons: string[];
  headings: { tag: string; text: string }[];
  keyText: string[];
}

async function extractContentData(page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>['newPage']>>): Promise<ContentData> {
  return page.evaluate(() => {
    function rgbToHex(rgb: string): string | null {
      const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      if (r === 0 && g === 0 && b === 0 && rgb.includes('rgba') && rgb.includes('0)')) return null;
      return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    }

    function isTransparent(v: string): boolean {
      return !v || v === 'transparent' || v === 'rgba(0, 0, 0, 0)' || v === 'rgba(0,0,0,0)';
    }

    // Cores
    const bgCount: Record<string, number> = {};
    const textCount: Record<string, number> = {};
    const accentCount: Record<string, number> = {};

    const bodyEls = Array.from(document.querySelectorAll('body, header, main, section, footer, div')).slice(0, 200);
    for (const el of bodyEls) {
      const cs = getComputedStyle(el as Element);
      const bg = cs.backgroundColor;
      const fg = cs.color;
      if (!isTransparent(bg)) {
        const hex = rgbToHex(bg);
        if (hex) bgCount[hex] = (bgCount[hex] || 0) + 1;
      }
      if (fg) {
        const hex = rgbToHex(fg);
        if (hex) textCount[hex] = (textCount[hex] || 0) + 1;
      }
    }
    for (const el of document.querySelectorAll('a, button')) {
      const cs = getComputedStyle(el as Element);
      const fg = cs.color;
      if (fg) {
        const hex = rgbToHex(fg);
        if (hex) accentCount[hex] = (accentCount[hex] || 0) + 1;
      }
    }

    const topN = (obj: Record<string, number>, n: number) =>
      Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

    const colors = {
      bg: topN(bgCount, 5),
      text: topN(textCount, 3),
      accent: topN(accentCount, 3),
    };

    // Fontes
    const genericFonts = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
    const fontSet = new Set<string>();
    for (const sel of ['body', 'h1', 'h2', 'p', 'button']) {
      const el = document.querySelector(sel);
      if (el) {
        const ff = getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/['"]/g, '');
        if (ff && !genericFonts.has(ff.toLowerCase())) fontSet.add(ff);
      }
    }
    const fonts = Array.from(fontSet).slice(0, 5);

    // Seções
    const sectionEls = Array.from(document.querySelectorAll('header, nav, main, section, footer, [role="banner"], [role="main"]')).slice(0, 15);
    const sections = sectionEls.map(el => {
      const tag = el.tagName.toLowerCase();
      const headingEl = el.querySelector('h1, h2, h3');
      const heading = headingEl ? (headingEl.textContent || '').trim().slice(0, 60) : undefined;
      const cs = getComputedStyle(el as HTMLElement);
      const display = cs.display;
      let layout: string | undefined;
      let columns: number | undefined;
      if (display === 'grid') {
        layout = 'grid';
        const gtc = cs.gridTemplateColumns;
        if (gtc && gtc !== 'none') {
          columns = gtc.trim().split(/\s+/).filter(Boolean).length;
        }
      } else if (display === 'flex') {
        layout = 'flex';
      }
      const result: { tag: string; heading?: string; layout?: string; columns?: number } = { tag };
      if (heading) result.heading = heading;
      if (layout) result.layout = layout;
      if (columns) result.columns = columns;
      return result;
    });

    // Nav
    const navLinks = Array.from(document.querySelectorAll('nav a, header a'))
      .map(a => (a.textContent || '').trim())
      .filter(t => t.length > 0 && t.length < 50)
      .slice(0, 12);
    const nav = [...new Set(navLinks)];

    // Botões
    const btnEls = Array.from(document.querySelectorAll('button, a[class*="btn"], [role="button"], input[type="submit"]'));
    const buttons = btnEls
      .map(b => ((b as HTMLInputElement).value || b.textContent || '').trim())
      .filter(t => t.length > 0 && t.length < 60)
      .slice(0, 10);

    // Headings
    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => ({
      tag: h.tagName.toLowerCase(),
      text: (h.textContent || '').trim().slice(0, 80),
    }));

    // Texto-chave
    const keyText: string[] = [];
    let totalChars = 0;
    for (const p of document.querySelectorAll('p')) {
      const cs = getComputedStyle(p as HTMLElement);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const t = (p.textContent || '').trim();
      if (t.length > 20) {
        keyText.push(t.slice(0, 200));
        totalChars += t.length;
        if (totalChars >= 500) break;
      }
    }

    return { colors, fonts, sections, nav, buttons, headings, keyText };
  }) as Promise<ContentData>;
}

async function capturePage(
  browser: Awaited<ReturnType<typeof puppeteer.launch>>,
  url: string,
  pageIndex: number
): Promise<PageResult> {
  const slug = slugFromUrl(url, pageIndex);
  const pageDir = join(REFERENCE_BASE, slug);
  if (existsSync(pageDir)) {
    rmDirRecursive(pageDir);
  }
  mkdirSync(pageDir, { recursive: true });

  const page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  } catch (e) {
    await page.close();
    throw new Error(`Falha ao carregar ${url}: ${(e as Error).message}`);
  }

  await sleep(2000);

  const savedFiles: string[] = [];

  const scrollHeight = await page.evaluate(() => {
    return Math.max(
      document.body?.scrollHeight ?? 0,
      document.documentElement?.scrollHeight ?? 0,
      window.innerHeight
    );
  });
  const totalViews = Math.max(1, Math.ceil(scrollHeight / VIEWPORT_HEIGHT));

  for (let i = 0; i < totalViews; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * VIEWPORT_HEIGHT);
    await sleep(SCROLL_DELAY);
    const filename = `screenshot-${String(i + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: join(pageDir, filename), fullPage: false });
    savedFiles.push(`${slug}/${filename}`);
  }

  const html = await page.content();
  writeFileSync(join(pageDir, 'page.html'), html, 'utf-8');
  savedFiles.push(`${slug}/page.html`);

  const imageUrlsFromDom = await page.evaluate(() => {
    const urls = new Set<string>();
    const base = window.location.href;
    document.querySelectorAll('img[src]').forEach((img) => {
      const src = (img as HTMLImageElement).src;
      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) urls.add(src);
    });
    document.querySelectorAll('[style*="background-image"]').forEach((el) => {
      const style = (el as HTMLElement).style.backgroundImage;
      const m = style?.match(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/);
      if (m?.[1]) {
        try {
          const resolved = new URL(m[1], base).href;
          if (!resolved.startsWith('data:') && !resolved.startsWith('blob:')) urls.add(resolved);
        } catch (_) {}
      }
    });
    return Array.from(urls);
  });

  const imageUrlsFromHtml = extractImageUrls(html, url);
  const imageUrls = [...new Set([...imageUrlsFromDom, ...imageUrlsFromHtml])];

  const imagesDir = join(pageDir, 'images');
  const imagesManifest: { file: string; url: string }[] = [];
  if (imageUrls.length > 0) {
    mkdirSync(imagesDir, { recursive: true });
    console.log(`  Baixando ${imageUrls.length} imagem(ns)...`);
    for (let i = 0; i < imageUrls.length; i++) {
      const result = await downloadImage(imageUrls[i], imagesDir, i + 1);
      if (result) {
        imagesManifest.push(result);
        savedFiles.push(`${slug}/images/${result.file}`);
      } else {
        console.log(`  \x1b[33m⚠ Falha ao baixar: ${imageUrls[i].slice(0, 60)}...\x1b[0m`);
      }
    }
    if (imagesManifest.length > 0) {
      writeFileSync(
        join(pageDir, 'images.json'),
        JSON.stringify(imagesManifest, null, 2),
        'utf-8'
      );
      savedFiles.push(`${slug}/images.json`);
      console.log(`  \x1b[32m✓ ${imagesManifest.length} imagem(ns) salva(s)\x1b[0m`);
    }
  }

  const cssData = await page.evaluate(() => {
    const result: { inline: string[]; external: string[] } = { inline: [], external: [] };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        if (sheet.href) result.external.push(sheet.href);
        else if (sheet.ownerNode instanceof HTMLStyleElement)
          result.inline.push(sheet.ownerNode.textContent || '');
      } catch (_) {}
    }
    for (const style of document.querySelectorAll('style')) {
      const t = (style as HTMLStyleElement).textContent || '';
      if (!result.inline.includes(t)) result.inline.push(t);
    }
    return result;
  });

  let allCss = cssData.inline.join('\n\n/* ----- inline ----- */\n\n');
  for (const href of cssData.external) {
    const css = await fetchExternalCss(href, url);
    if (css) allCss += `\n\n/* ----- ${href} ----- */\n\n${css}`;
  }
  writeFileSync(join(pageDir, 'styles.css'), allCss || '/* No CSS */', 'utf-8');
  savedFiles.push(`${slug}/styles.css`);

  const contentData = await extractContentData(page);
  writeFileSync(join(pageDir, 'content-data.json'), JSON.stringify(contentData, null, 2), 'utf-8');
  savedFiles.push(`${slug}/content-data.json`);

  // Manter structure.json por compatibilidade, derivado de contentData
  const structure = { headings: contentData.headings };
  writeFileSync(join(pageDir, 'structure.json'), JSON.stringify(structure, null, 2), 'utf-8');
  savedFiles.push(`${slug}/structure.json`);

  await page.close();
  return { slug, url, files: savedFiles, contentData };
}

function inferBaseUrlFromSlug(slug: string): string {
  if (slug.startsWith('demos-medcity-')) {
    const page = slug.replace('demos-medcity-', '');
    return `https://7oroof.com/demos/medcity/${page}`;
  }
  return `https://example.com/${slug.replace(/-/g, '/')}`;
}

async function downloadImagesForSlug(
  slug: string,
  pageUrl?: string
): Promise<{ slug: string; images: { file: string; url: string }[]; count: number }> {
  const pageDir = join(REFERENCE_BASE, slug);
  const pagePath = join(pageDir, 'page.html');
  if (!existsSync(pagePath)) return { slug, images: [], count: 0 };
  const html = readFileSync(pagePath, 'utf-8');
  const baseUrl = pageUrl || inferBaseUrlFromSlug(slug);
  const imageUrls = extractImageUrls(html, baseUrl);
  if (imageUrls.length === 0) return { slug, images: [], count: 0 };
  const imagesDir = join(pageDir, 'images');
  mkdirSync(imagesDir, { recursive: true });
  const manifest: { file: string; url: string }[] = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const result = await downloadImage(imageUrls[i], imagesDir, i + 1);
    if (result) manifest.push(result);
  }
  if (manifest.length > 0) {
    writeFileSync(join(pageDir, 'images.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  }
  return { slug, images: manifest, count: manifest.length };
}

async function capture(urls: string[]): Promise<{ pages: PageResult[] }> {
  if (!existsSync(REFERENCE_BASE)) mkdirSync(REFERENCE_BASE, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const pages: PageResult[] = [];
  for (let i = 0; i < urls.length; i++) {
    const result = await capturePage(browser, urls[i], i);
    pages.push(result);
  }
  await browser.close();
  return { pages };
}

const PORT = parseInt(process.env.CAPTURE_PORT ?? '3001', 10);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

try {
  Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    async fetch(req) {
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }
      const url = new URL(req.url);
      const pathname = url.pathname;

      if ((pathname === '/' || pathname === '/health') && req.method === 'GET') {
        return new Response(JSON.stringify({ ok: true, port: PORT }), { headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      if (pathname === '/api/version' && req.method === 'GET') {
        const projectRoot = join(__dirname, '..');
        let version = '?';
        try {
          const vf = join(projectRoot, 'VERSION');
          if (existsSync(vf)) version = readFileSync(vf, 'utf-8').trim();
        } catch (_) {}
        const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, encoding: 'utf-8' });
        const hash = commit.stdout?.trim() || '';
        return new Response(JSON.stringify({ version, hash }), {
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      if (pathname === '/api/credentials' && req.method === 'GET') {
        try {
          const cred = loadCredentials();
          return new Response(
            JSON.stringify({
              hasGithub: !!cred.githubToken,
              hasVercel: !!cred.vercelToken,
            }),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        } catch (e) {
          return new Response(
            JSON.stringify({ hasGithub: false, hasVercel: false }),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
      }

      if (pathname === '/api/credentials' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { githubToken?: string; vercelToken?: string };
          mkdirSync(join(PROJECT_ROOT, 'data'), { recursive: true });
          const cred: Record<string, string> = {};
          if (typeof body.githubToken === 'string') cred.githubToken = body.githubToken.trim() || '';
          if (typeof body.vercelToken === 'string') cred.vercelToken = body.vercelToken.trim() || '';
          if (Object.keys(cred).length > 0) {
            let existing: Record<string, string> = {};
            if (existsSync(CREDENTIALS_PATH)) {
              try {
                existing = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
              } catch (_) {}
            }
            const merged = { ...existing, ...cred };
            if (!merged.githubToken) delete merged.githubToken;
            if (!merged.vercelToken) delete merged.vercelToken;
            writeFileSync(CREDENTIALS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
            console.log('  \x1b[32m✓\x1b[0m Credenciais salvas');
          }
          return new Response(
            JSON.stringify({ success: true, hasGithub: !!loadCredentials().githubToken, hasVercel: !!loadCredentials().vercelToken }),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        } catch (e) {
          console.error('\x1b[31m✖ Erro ao salvar credenciais:\x1b[0m', e);
          return new Response(
            JSON.stringify({ success: false, error: (e as Error).message }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
      }

      if (pathname === '/api/feedback' && req.method === 'POST') {
        try {
          const body = (await req.json()) as {
            tipo: string;
            descricao: string;
            nome?: string;
            email?: string;
          };
          const { tipo, descricao, nome, email } = body;
          if (!tipo || !descricao) {
            return new Response(JSON.stringify({ error: 'tipo e descricao são obrigatórios' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
          }
          const token = process.env.FEEDBACK_TOKEN;
          if (!token) {
            return new Response(JSON.stringify({ error: 'FEEDBACK_TOKEN não configurado' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
          }
          const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const feedback = {
            id,
            tipo,
            ferramenta: 'f8 Studio',
            descricao,
            nome: nome || null,
            email: email || null,
            whatsapp: null,
            screenshot: null,
            created_at: new Date().toISOString(),
            status: 'backlog',
          };
          const filePath = `feedback/${new Date().toISOString().slice(0, 10)}-${id}.json`;
          const content = Buffer.from(JSON.stringify(feedback, null, 2), 'utf-8').toString('base64');
          const ghRes = await fetch(`https://api.github.com/repos/8linksapp-maker/feedback-cnx-astro/contents/${filePath}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Feedback f8: ${tipo}`, content, branch: 'main' }),
          });
          if (!ghRes.ok) {
            const err = await ghRes.text();
            console.error('\x1b[31m✖ Erro ao salvar feedback:\x1b[0m', err);
            return new Response(JSON.stringify({ error: 'Erro ao salvar feedback' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
          }
          console.log(`  \x1b[32m✓\x1b[0m Feedback recebido: ${tipo}`);
          return new Response(JSON.stringify({ success: true, id }), { headers: { 'Content-Type': 'application/json', ...CORS } });
        } catch (e) {
          return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
      }

      if (pathname === '/api/github/create-repo' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { slug: string; repoName?: string; private?: boolean; doPush?: boolean };
          const slug = (body.slug || '').trim().replace(/[^a-z0-9-]/gi, '-').toLowerCase();
          const repoName = (body.repoName || slug).trim().replace(/[^a-zA-Z0-9-_]/g, '-') || slug;
          const isPrivate = !!body.private;
          const doPush = body.doPush !== false;

          if (!slug) {
            return new Response(JSON.stringify({ success: false, error: 'slug obrigatório' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
          }

          const token = getGitHubToken();
          if (!token) {
            return new Response(
              JSON.stringify({ success: false, error: 'Configure o token do GitHub em Configurações → Credenciais' }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }

          const siteDir = join(PROJECT_ROOT, 'sites', slug);
          if (!existsSync(siteDir)) {
            return new Response(
              JSON.stringify({ success: false, error: `Site sites/${slug} não encontrado` }),
              { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }

          const createRes = await fetch('https://api.github.com/user/repos', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: repoName,
              private: isPrivate,
              description: `Site PBN - ${slug}`,
              auto_init: false,
            }),
          });

          if (!createRes.ok) {
            const errData = await createRes.json().catch(() => ({}));
            const msg = errData.message || errData.error || createRes.statusText || `HTTP ${createRes.status}`;
            return new Response(
              JSON.stringify({ success: false, error: `GitHub: ${msg}` }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }

          const repo = (await createRes.json()) as { clone_url?: string; html_url?: string };
          const cloneUrl = repo.clone_url || `https://github.com/${(repo as { full_name?: string }).full_name || 'user/' + repoName}.git`;

          const projectPath = join(siteDir, 'project.json');
          const meta: Record<string, string> = existsSync(projectPath) ? JSON.parse(readFileSync(projectPath, 'utf-8')) : {};
          meta.remoteUrl = cloneUrl;
          writeFileSync(projectPath, JSON.stringify(meta, null, 2), 'utf-8');

          const authUrl = injectTokenIntoUrl(cloneUrl, token);
          if (!existsSync(join(siteDir, '.git'))) spawnSync('git', ['init'], { cwd: siteDir });
          const hasOrigin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: siteDir }).status === 0;
          if (hasOrigin) spawnSync('git', ['remote', 'set-url', 'origin', authUrl], { cwd: siteDir });
          else spawnSync('git', ['remote', 'add', 'origin', authUrl], { cwd: siteDir });

          let pushed = false;
          if (doPush) {
            ensureGitUser(siteDir);
            spawnSync('git', ['config', 'http.postBuffer', '524288000'], { cwd: siteDir });
            spawnSync('git', ['add', '.'], { cwd: siteDir });
            const commit = spawnSync('git', ['commit', '-m', 'Site inicial'], { cwd: siteDir, encoding: 'utf-8' });
            const push = spawnSync('git', ['push', '-u', 'origin', meta.branch || 'main'], { cwd: siteDir, encoding: 'utf-8' });
            pushed = push.status === 0;
            if (push.status !== 0 && !commit.stderr?.includes('nothing to commit')) {
              console.error('\x1b[31m✖ Erro push:\x1b[0m', push.stderr);
            }
          }

          console.log('  \x1b[32m✓\x1b[0m Repositório criado:', cloneUrl);
          return new Response(
            JSON.stringify({
              success: true,
              remoteUrl: cloneUrl,
              htmlUrl: repo.html_url,
              pushed,
            }),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        } catch (e) {
          console.error('\x1b[31m✖ Erro criar repo GitHub:\x1b[0m', e);
          return new Response(
            JSON.stringify({ success: false, error: (e as Error).message }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
      }

      if (pathname === '/api/sites' && req.method === 'GET') {
        try {
          const projectRoot = join(__dirname, '..');
          const sitesDir = join(projectRoot, 'sites');
          const list: { name: string; slug: string; path: string; createdAt: string; displayName?: string; deployUrl?: string; remoteUrl?: string; branch: string; hasBuild?: boolean }[] = [];
          if (existsSync(sitesDir)) {
            const entries = readdirSync(sitesDir, { withFileTypes: true });
            for (const e of entries) {
              if (e.isDirectory() && !e.name.startsWith('.')) {
                const projectPath = join(sitesDir, e.name, 'project.json');
                let displayName = e.name;
                let createdAt = '';
                let deployUrl = '';
                let remoteUrl = '';
                let branch = 'main';
                try {
                  if (existsSync(projectPath)) {
                    const meta = JSON.parse(readFileSync(projectPath, 'utf-8'));
                    displayName = meta.displayName || meta.name || e.name;
                    createdAt = meta.createdAt || '';
                    deployUrl = meta.deployUrl || '';
                    remoteUrl = meta.remoteUrl || '';
                    branch = meta.branch || 'main';
                  }
                  const stat = statSync(join(sitesDir, e.name));
                  if (!createdAt) createdAt = stat.mtime?.toISOString?.() || new Date().toISOString();
                } catch (_) {}
                const hasBuild = existsSync(join(sitesDir, e.name, 'dist'));
                list.push({ name: e.name, slug: e.name, path: `sites/${e.name}`, createdAt, displayName, deployUrl: deployUrl || undefined, remoteUrl: remoteUrl || undefined, branch, hasBuild });
              }
            }
            list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
          }
          return new Response(
            JSON.stringify({ sites: list }),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        } catch (e) {
          console.error('\x1b[31m✖ Erro listar sites:\x1b[0m', e);
          return new Response(
            JSON.stringify({ sites: [], error: (e as Error).message }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
      }

      if (pathname === '/api/sites/update-deploy-url' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { slug?: string; deployUrl?: string };
          const slug = body?.slug?.trim();
          const deployUrl = body?.deployUrl?.trim() ?? '';
          if (!slug || slug.includes('..')) {
            return new Response(JSON.stringify({ error: 'slug obrigatório' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
          }
          const projectRoot = join(__dirname, '..');
          const projectPath = join(projectRoot, 'sites', slug, 'project.json');
          if (!existsSync(projectPath)) {
            return new Response(JSON.stringify({ error: 'Site não encontrado' }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } });
          }
          const meta = JSON.parse(readFileSync(projectPath, 'utf-8'));
          meta.deployUrl = deployUrl || undefined;
          if (!deployUrl) delete meta.deployUrl;
          writeFileSync(projectPath, JSON.stringify(meta, null, 2), 'utf-8');
          return new Response(JSON.stringify({ success: true, deployUrl: meta.deployUrl }), { headers: { 'Content-Type': 'application/json', ...CORS } });
        } catch (e) {
          console.error('\x1b[31m✖ Erro ao atualizar deployUrl:\x1b[0m', e);
          return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
      }

      const siteActionMatch = pathname.match(/^\/api\/sites\/([^/]+)\/(git-status|git-commit|git-push|git-remote|git-init|build|delete)$/);
      if (siteActionMatch) {
        const [, slug, action] = siteActionMatch;
        const projectRoot = join(__dirname, '..');
        const siteDir = join(projectRoot, 'sites', slug);
        if (!existsSync(siteDir) || slug.includes('..')) {
          return new Response(JSON.stringify({ error: 'Site não encontrado' }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
        try {
          const projectPath = join(siteDir, 'project.json');
          const meta: Record<string, string> = existsSync(projectPath) ? JSON.parse(readFileSync(projectPath, 'utf-8')) : {};
          const getRemote = () => {
            if (meta.remoteUrl) return meta.remoteUrl;
            const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: siteDir, encoding: 'utf-8' });
            return r.status === 0 ? (r.stdout?.trim() || '') : '';
          };
          const branch = meta.branch || 'main';

          if (action === 'git-status' && req.method === 'GET') {
            const hasGit = existsSync(join(siteDir, '.git'));
            let remote = '';
            let lastCommit = '';
            let hasUncommitted = false;
            if (hasGit) {
              remote = getRemote();
              const log = spawnSync('git', ['log', '-1', '--format=%h %s %cr'], { cwd: siteDir, encoding: 'utf-8' });
              lastCommit = log.stdout?.trim() || '';
              const st = spawnSync('git', ['status', '--porcelain'], { cwd: siteDir, encoding: 'utf-8' });
              hasUncommitted = (st.stdout?.trim() || '').length > 0;
            }
            return new Response(JSON.stringify({
              hasGit,
              remoteUrl: remote || meta.remoteUrl || undefined,
              branch,
              lastCommit: lastCommit || undefined,
              hasUncommitted,
            }), { headers: { 'Content-Type': 'application/json', ...CORS } });
          }

          if (action === 'git-init' && req.method === 'POST') {
            if (existsSync(join(siteDir, '.git'))) {
              return new Response(JSON.stringify({ success: true, message: 'Git já inicializado' }), { headers: { 'Content-Type': 'application/json', ...CORS } });
            }
            spawnSync('git', ['init'], { cwd: siteDir });
            return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
          }

          if (action === 'git-commit' && req.method === 'POST') {
            const body = (await req.json()) as { message?: string };
            const message = (body?.message || 'Atualização').trim().slice(0, 200);
            if (!existsSync(join(siteDir, '.git'))) spawnSync('git', ['init'], { cwd: siteDir });
            ensureGitUser(siteDir);
            spawnSync('git', ['add', '.'], { cwd: siteDir });
            const commit = spawnSync('git', ['commit', '-m', message], { cwd: siteDir, encoding: 'utf-8' });
            const out = (commit.stderr || '') + (commit.stdout || '');
            const nothingToCommit = out.includes('nothing to commit');
            if (commit.status !== 0 && !nothingToCommit) {
              const err = (commit.stderr || commit.stdout || 'Erro no commit').trim();
              return new Response(JSON.stringify({ success: false, error: err || 'Erro no commit' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
            }
            const summary = parseCommitSummary(out);
            return new Response(JSON.stringify({
              success: true,
              message: nothingToCommit ? 'Nada para commitar — working tree limpo' : (summary || 'Commit realizado'),
              nothingToCommit,
            }), { headers: { 'Content-Type': 'application/json', ...CORS } });
          }

          if (action === 'git-remote' && req.method === 'POST') {
            const body = (await req.json()) as { remoteUrl?: string; branch?: string };
            const remoteUrl = (body?.remoteUrl || '').trim();
            const newBranch = (body?.branch || 'main').trim() || 'main';
            if (remoteUrl) {
              if (!existsSync(join(siteDir, '.git'))) spawnSync('git', ['init'], { cwd: siteDir });
              meta.remoteUrl = remoteUrl;
              const token = getGitHubToken();
              const url = token ? injectTokenIntoUrl(remoteUrl, token) : remoteUrl;
              const hasOrigin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: siteDir }).status === 0;
              if (hasOrigin) spawnSync('git', ['remote', 'set-url', 'origin', url], { cwd: siteDir });
              else spawnSync('git', ['remote', 'add', 'origin', url], { cwd: siteDir });
            }
            meta.branch = newBranch;
            writeFileSync(projectPath, JSON.stringify(meta, null, 2), 'utf-8');
            return new Response(JSON.stringify({ success: true, remoteUrl: meta.remoteUrl, branch: meta.branch }), { headers: { 'Content-Type': 'application/json', ...CORS } });
          }

          if (action === 'git-push' && req.method === 'POST') {
            const remote = getRemote() || meta.remoteUrl;
            if (!remote) {
              return new Response(JSON.stringify({ success: false, error: 'Configure o repositório remoto antes de fazer push' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
            }
            const token = getGitHubToken();
            if (!token) {
              return new Response(JSON.stringify({ success: false, error: 'Configure o token do GitHub em Configurações → Credenciais para fazer push' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
            }
            if (!existsSync(join(siteDir, '.git'))) spawnSync('git', ['init'], { cwd: siteDir });
            ensureGitUser(siteDir);
            const authUrl = injectTokenIntoUrl(remote, token);
            const hasOrigin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: siteDir }).status === 0;
            if (hasOrigin) spawnSync('git', ['remote', 'set-url', 'origin', authUrl], { cwd: siteDir });
            else spawnSync('git', ['remote', 'add', 'origin', authUrl], { cwd: siteDir });
            spawnSync('git', ['config', 'http.postBuffer', '524288000'], { cwd: siteDir });
            spawnSync('git', ['add', '.'], { cwd: siteDir });
            const commit = spawnSync('git', ['commit', '-m', 'Atualização automática'], { cwd: siteDir, encoding: 'utf-8' });
            const commitOut = (commit.stderr || '') + (commit.stdout || '');
            if (commit.status !== 0 && !commitOut.includes('nothing to commit')) {
              const err = (commit.stderr || commit.stdout || 'Erro no commit').trim();
              return new Response(JSON.stringify({ success: false, error: err }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
            }
            const push = spawnSync('git', ['push', '-u', 'origin', branch], { cwd: siteDir, encoding: 'utf-8' });
            if (push.status !== 0) {
              const err = (push.stderr || push.stdout || 'Erro no push').trim();
              return new Response(JSON.stringify({ success: false, error: err || 'Erro no push' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
            }
            return new Response(JSON.stringify({
              success: true,
              message: 'Push concluído — alterações enviadas ao repositório remoto',
            }), { headers: { 'Content-Type': 'application/json', ...CORS } });
          }

          if (action === 'build' && req.method === 'POST') {
            const install = spawnSync('bun', ['install'], { cwd: siteDir, encoding: 'utf-8', timeout: 120000 });
            if (install.status !== 0) {
              return new Response(JSON.stringify({ success: false, error: install.stderr || install.stdout || 'Erro no install' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
            }
            const build = spawnSync('bun', ['run', 'build'], { cwd: siteDir, encoding: 'utf-8', timeout: 120000 });
            if (build.status !== 0) {
              return new Response(JSON.stringify({ success: false, error: build.stderr || build.stdout || 'Erro no build' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
            }
            const distDir = join(siteDir, 'dist');
            const { runCheckLinks } = await import('./check-links.ts');
            const linkResult = await runCheckLinks(distDir);
            if (!linkResult.ok) {
              const msg = linkResult.broken.map((b) => `${b.url} (de ${b.from})`).join('; ');
              console.error('\x1b[31m✖ Links quebrados em', slug, ':\x1b[0m', msg);
              return new Response(JSON.stringify({
                success: false,
                error: `Links quebrados: ${msg}`,
                linkCheck: { ok: false, broken: linkResult.broken },
              }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
            }
            return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
          }

          if (action === 'delete' && req.method === 'POST') {
            const sitesDir = join(projectRoot, 'sites');
            const canonicalPath = join(sitesDir, slug);
            if (!canonicalPath.startsWith(sitesDir) || !existsSync(canonicalPath)) {
              return new Response(JSON.stringify({ error: 'Site não encontrado' }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } });
            }
            rmSync(canonicalPath, { recursive: true, force: true });
            console.log(`  \x1b[32m✓\x1b[0m Site excluído: sites/${slug}`);
            return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
          }
        } catch (e) {
          console.error('\x1b[31m✖ Erro Git/Build:\x1b[0m', e);
          return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
      }

      if (pathname === '/api/images' && req.method === 'GET') {
        const slug = url.searchParams.get('slug');
        if (!slug) {
          return new Response(JSON.stringify({ error: 'slug obrigatório' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        const imagesPath = join(REFERENCE_BASE, slug, 'images.json');
        if (!existsSync(imagesPath)) {
          return new Response(JSON.stringify({ slug, images: [], hasImages: false }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
        const manifest = JSON.parse(readFileSync(imagesPath, 'utf-8'));
        return new Response(
          JSON.stringify({ slug, images: manifest, hasImages: manifest.length > 0 }),
          { headers: { 'Content-Type': 'application/json', ...CORS } }
        );
      }

      if (pathname === '/api/download-images' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { slugs?: string[]; pages?: { slug: string; url?: string }[] };
          const pages = body.pages?.length
            ? body.pages
            : (body.slugs || []).map((s: string) => ({ slug: s }));
          if (pages.length === 0) {
            return new Response(
              JSON.stringify({ error: 'Informe slugs ou pages' }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }
          const results: { slug: string; images: { file: string; url: string }[]; count: number }[] = [];
          for (const p of pages) {
            const r = await downloadImagesForSlug(p.slug, p.url);
            results.push(r);
            if (r.count > 0) console.log(`  \x1b[32m✓\x1b[0m ${p.slug}: ${r.count} imagem(ns)`);
          }
          return new Response(
            JSON.stringify({ success: true, pages: results }),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        } catch (e) {
          console.error('\x1b[31m✖ Erro ao baixar imagens:\x1b[0m', e);
          return new Response(
            JSON.stringify({ error: (e as Error).message }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
      }

      if (pathname === '/api/save-prompts' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { content?: string; slug?: string };
          const content = body?.content;
          const slug = typeof body?.slug === 'string' ? body.slug.replace(/[^a-z0-9-]/g, '') : '';
          if (typeof content !== 'string') {
            return new Response(
              JSON.stringify({ error: 'Informe content (string)' }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }
          const projectRoot = join(__dirname, '..');
          const relPath = slug
            ? join('sites', slug, 'prompts.md')
            : 'prompts-gerados.md';
          const filePath = join(projectRoot, relPath);
          // Ensure directory exists before writing
          const fileDir = join(projectRoot, slug ? join('sites', slug) : '.');
          if (!existsSync(fileDir)) mkdirSync(fileDir, { recursive: true });
          writeFileSync(filePath, content, 'utf-8');

          // Save page slugs into project.json if pages array provided
          const pages = Array.isArray((body as { pages?: string[] }).pages) ? (body as { pages?: string[] }).pages! : null;
          if (slug && pages) {
            const projectPath = join(projectRoot, 'sites', slug, 'project.json');
            if (existsSync(projectPath)) {
              try {
                const meta = JSON.parse(readFileSync(projectPath, 'utf-8'));
                meta.referencePages = pages;
                writeFileSync(projectPath, JSON.stringify(meta, null, 2), 'utf-8');
              } catch (_) {}
            }
          }
          console.log(`  \x1b[32m✓\x1b[0m ${relPath} salvo`);
          return new Response(
            JSON.stringify({ success: true, path: relPath }),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        } catch (e) {
          console.error('\x1b[31m✖ Erro ao salvar prompts:\x1b[0m', e);
          return new Response(
            JSON.stringify({ error: (e as Error).message }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
      }

      if (pathname === '/api/test-links' && req.method === 'POST') {
        try {
          const projectRoot = join(__dirname, '..');
          const build = spawnSync('bun', ['run', 'build'], { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 });
          if (build.status !== 0) {
            return new Response(
              JSON.stringify({ ok: false, error: 'Build falhou', broken: [{ url: 'build', from: build.stderr || build.stdout || 'Erro' }] }),
              { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }
          const { runCheckLinks } = await import('./check-links.ts');
          const result = await runCheckLinks();
          return new Response(
            JSON.stringify(result),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        } catch (e) {
          console.error('\x1b[31m✖ Erro test-links:\x1b[0m', e);
          return new Response(
            JSON.stringify({ ok: false, error: (e as Error).message, broken: [] }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
      }

      const pagesMatch = pathname.match(/^\/api\/sites\/([^/]+)\/pages$/);
      if (pagesMatch && req.method === 'GET') {
        const slug = pagesMatch[1];
        if (!slug || slug.includes('..')) {
          return new Response(JSON.stringify({ error: 'slug inválido' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
        const projectRoot = join(__dirname, '..');
        const projectPath = join(projectRoot, 'sites', slug, 'project.json');
        if (!existsSync(projectPath)) {
          return new Response(JSON.stringify({ pages: [] }), { headers: { 'Content-Type': 'application/json', ...CORS } });
        }
        try {
          const meta = JSON.parse(readFileSync(projectPath, 'utf-8'));
          const referenceSlugs: string[] = meta.referencePages || [];
          const pages = referenceSlugs.map((pageSlug: string) => {
            const pageDir = join(REFERENCE_BASE, pageSlug);
            const files: string[] = [];
            if (existsSync(pageDir)) {
              try {
                const entries = readdirSync(pageDir, { withFileTypes: true });
                for (const e of entries) {
                  if (!e.isDirectory()) files.push(`${pageSlug}/${e.name}`);
                  else {
                    const sub = readdirSync(join(pageDir, e.name));
                    for (const f of sub) files.push(`${pageSlug}/${e.name}/${f}`);
                  }
                }
              } catch (_) {}
            }
            let contentData: ContentData | undefined;
            const cdPath = join(pageDir, 'content-data.json');
            if (existsSync(cdPath)) {
              try { contentData = JSON.parse(readFileSync(cdPath, 'utf-8')); } catch (_) {}
            }
            return { slug: pageSlug, url: '', files, contentData };
          }).filter(p => p.files.length > 0);
          return new Response(JSON.stringify({ pages }), { headers: { 'Content-Type': 'application/json', ...CORS } });
        } catch (e) {
          return new Response(JSON.stringify({ pages: [], error: (e as Error).message }), { headers: { 'Content-Type': 'application/json', ...CORS } });
        }
      }

      // ─── Reference cleanup ──────────────────────────────────────────────
      if (pathname === '/api/references/orphans' && req.method === 'GET') {
        try {
          const projectRoot = join(__dirname, '..');
          const sitesDir = join(projectRoot, 'sites');
          // Collect all used slugs from project.json files
          const usedSlugs = new Set<string>();
          if (existsSync(sitesDir)) {
            for (const e of readdirSync(sitesDir, { withFileTypes: true })) {
              if (!e.isDirectory()) continue;
              const pjPath = join(sitesDir, e.name, 'project.json');
              if (!existsSync(pjPath)) continue;
              try {
                const meta = JSON.parse(readFileSync(pjPath, 'utf-8'));
                const pages: string[] = meta.referencePages || [];
                pages.forEach(s => usedSlugs.add(s));
              } catch (_) {}
            }
          }
          // List all reference folders
          const orphans: string[] = [];
          if (existsSync(REFERENCE_BASE)) {
            for (const e of readdirSync(REFERENCE_BASE, { withFileTypes: true })) {
              if (e.isDirectory() && !usedSlugs.has(e.name)) orphans.push(e.name);
            }
          }
          return new Response(JSON.stringify({ orphans, usedCount: usedSlugs.size }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } catch (e) {
          return new Response(JSON.stringify({ orphans: [], error: (e as Error).message }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }

      if (pathname === '/api/references/cleanup' && req.method === 'POST') {
        try {
          const projectRoot = join(__dirname, '..');
          const sitesDir = join(projectRoot, 'sites');
          const body = (await req.json()) as { slugs?: string[] };
          let toDelete: string[] = [];
          if (Array.isArray(body?.slugs) && body.slugs.length > 0) {
            // Delete only the specified slugs
            toDelete = body.slugs.map(s => String(s).replace(/\.\./g, '').trim()).filter(Boolean);
          } else {
            // Delete all orphans
            const usedSlugs = new Set<string>();
            if (existsSync(sitesDir)) {
              for (const e of readdirSync(sitesDir, { withFileTypes: true })) {
                if (!e.isDirectory()) continue;
                const pjPath = join(sitesDir, e.name, 'project.json');
                if (!existsSync(pjPath)) continue;
                try {
                  const meta = JSON.parse(readFileSync(pjPath, 'utf-8'));
                  const pages: string[] = meta.referencePages || [];
                  pages.forEach(s => usedSlugs.add(s));
                } catch (_) {}
              }
            }
            if (existsSync(REFERENCE_BASE)) {
              for (const e of readdirSync(REFERENCE_BASE, { withFileTypes: true })) {
                if (e.isDirectory() && !usedSlugs.has(e.name)) toDelete.push(e.name);
              }
            }
          }
          const deleted: string[] = [];
          for (const slug of toDelete) {
            const dir = join(REFERENCE_BASE, slug);
            if (existsSync(dir)) {
              rmDirRecursive(dir);
              deleted.push(slug);
              console.log(`  \x1b[32m✓\x1b[0m Referência removida: ${slug}`);
            }
          }
          return new Response(JSON.stringify({ success: true, deleted, count: deleted.length }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } catch (e) {
          console.error('\x1b[31m✖ Erro cleanup:\x1b[0m', e);
          return new Response(JSON.stringify({ success: false, error: (e as Error).message }), {
            status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }

      // ─── Update system ──────────────────────────────────────────────────
      if (pathname === '/api/update/check' && req.method === 'GET') {
        try {
          const projectRoot = join(__dirname, '..');
          // Fetch from maker remote
          const fetch = spawnSync('git', ['fetch', 'maker', '--no-tags', '-q'], {
            cwd: projectRoot, encoding: 'utf-8', timeout: 15000,
          });
          if (fetch.status !== 0) {
            return new Response(JSON.stringify({ available: false, error: fetch.stderr?.trim() || 'Erro ao buscar atualizações' }), {
              headers: { 'Content-Type': 'application/json', ...CORS },
            });
          }
          const localRev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf-8' });
          const remoteRev = spawnSync('git', ['rev-parse', 'maker/main'], { cwd: projectRoot, encoding: 'utf-8' });
          const local = localRev.stdout?.trim();
          const remote = remoteRev.stdout?.trim();
          if (!remote) {
            return new Response(JSON.stringify({ available: false, error: 'Branch maker/main não encontrado' }), {
              headers: { 'Content-Type': 'application/json', ...CORS },
            });
          }
          const available = local !== remote;
          let changelog: string[] = [];
          if (available) {
            const log = spawnSync('git', ['log', `${local}..${remote}`, '--oneline', '--no-merges'], {
              cwd: projectRoot, encoding: 'utf-8',
            });
            changelog = (log.stdout || '').trim().split('\n').filter(Boolean).slice(0, 20);
          }
          // Read local version from VERSION file
          let localVersion = '?';
          const vf = join(projectRoot, 'VERSION');
          if (existsSync(vf)) {
            try { localVersion = readFileSync(vf, 'utf-8').trim(); } catch (_) {}
          }
          return new Response(JSON.stringify({ available, localVersion, local: local?.slice(0, 7), remote: remote?.slice(0, 7), changelog }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } catch (e) {
          return new Response(JSON.stringify({ available: false, error: (e as Error).message }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }

      if (pathname === '/api/update/apply' && req.method === 'POST') {
        try {
          const projectRoot = join(__dirname, '..');
          const results: { step: string; ok: boolean; out?: string }[] = [];

          // 1. Stash any local changes
          const stash = spawnSync('git', ['stash', '--include-untracked', '-m', 'f8-auto-update-stash'], {
            cwd: projectRoot, encoding: 'utf-8', timeout: 15000,
          });
          const stashed = !(stash.stdout || '').includes('No local changes to save');
          results.push({ step: 'stash', ok: stash.status === 0, out: stash.stdout?.trim() });

          // 2. Merge from maker/main
          const merge = spawnSync('git', ['merge', 'maker/main', '--no-edit', '--strategy-option=theirs'], {
            cwd: projectRoot, encoding: 'utf-8', timeout: 30000,
          });
          results.push({ step: 'merge', ok: merge.status === 0, out: (merge.stdout || merge.stderr || '').trim() });

          if (merge.status !== 0) {
            // Abort merge on failure
            spawnSync('git', ['merge', '--abort'], { cwd: projectRoot });
            if (stashed) spawnSync('git', ['stash', 'pop'], { cwd: projectRoot, encoding: 'utf-8' });
            return new Response(JSON.stringify({ success: false, results, error: 'Conflito ao aplicar atualização. Contate o suporte.' }), {
              status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
            });
          }

          // 3. Restore stash
          if (stashed) {
            const pop = spawnSync('git', ['stash', 'pop'], { cwd: projectRoot, encoding: 'utf-8', timeout: 10000 });
            results.push({ step: 'stash-pop', ok: pop.status === 0, out: pop.stdout?.trim() });
          }

          // 4. Install new deps if package.json changed
          const install = spawnSync('bun', ['install', '--frozen-lockfile'], {
            cwd: projectRoot, encoding: 'utf-8', timeout: 60000,
          });
          results.push({ step: 'bun-install', ok: install.status === 0 });

          console.log('\x1b[32m✓\x1b[0m Atualização aplicada com sucesso');
          return new Response(JSON.stringify({ success: true, results }), {
            headers: { 'Content-Type': 'application/json', ...CORS },
          });
        } catch (e) {
          console.error('\x1b[31m✖ Erro ao aplicar update:\x1b[0m', e);
          return new Response(JSON.stringify({ success: false, error: (e as Error).message }), {
            status: 500, headers: { 'Content-Type': 'application/json', ...CORS },
          });
        }
      }

      if (pathname === '/api/sites/prepare' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { name?: string };
          const name = (body?.name || '').trim().replace(/[^a-z0-9-]/gi, '-').toLowerCase();
          if (!name) {
            return new Response(JSON.stringify({ success: false, error: 'Nome obrigatório' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
          }
          const projectRoot = join(__dirname, '..');
          const out = spawnSync('bun', ['run', 'scripts/prepare-site.ts', name], { cwd: projectRoot, encoding: 'utf-8', timeout: 30000 });
          if (out.status !== 0) {
            return new Response(JSON.stringify({ success: false, error: out.stderr || out.stdout || 'Erro' }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
          }
          return new Response(JSON.stringify({ success: true, path: `sites/${name}` }), { headers: { 'Content-Type': 'application/json', ...CORS } });
        } catch (e) {
          console.error('\x1b[31m✖ Erro prepare-site:\x1b[0m', e);
          return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
      }

      if (pathname === '/api/export-site' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { name?: string; remoteUrl?: string };
          const name = body?.name?.trim() || `site-${Date.now()}`;
          const remoteUrl = (body?.remoteUrl || '').trim();
          const projectRoot = join(__dirname, '..');
          const out = spawnSync('bun', ['run', 'scripts/export-site.ts', name], { cwd: projectRoot, encoding: 'utf-8', timeout: 60000 });
          if (out.status !== 0) {
            return new Response(
              JSON.stringify({ success: false, error: out.stderr || out.stdout || 'Erro na exportação' }),
              { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }
          if (remoteUrl) {
            const siteDir = join(projectRoot, 'sites', name);
            const projectPath = join(siteDir, 'project.json');
            if (existsSync(projectPath)) {
              const meta = JSON.parse(readFileSync(projectPath, 'utf-8'));
              meta.remoteUrl = remoteUrl;
              writeFileSync(projectPath, JSON.stringify(meta, null, 2), 'utf-8');
              const token = getGitHubToken();
              const url = token ? injectTokenIntoUrl(remoteUrl, token) : remoteUrl;
              const hasOrigin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: siteDir }).status === 0;
              if (hasOrigin) spawnSync('git', ['remote', 'set-url', 'origin', url], { cwd: siteDir });
              else spawnSync('git', ['remote', 'add', 'origin', url], { cwd: siteDir });
            }
          }
          return new Response(
            JSON.stringify({ success: true, path: `sites/${name}` }),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        } catch (e) {
          console.error('\x1b[31m✖ Erro export:\x1b[0m', e);
          return new Response(
            JSON.stringify({ success: false, error: (e as Error).message }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
      }

      if (pathname === '/api/git-push' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { siteName: string; remoteUrl?: string; branch?: string };
          const { siteName, remoteUrl, branch = 'main' } = body;
          if (!siteName?.trim()) {
            return new Response(
              JSON.stringify({ success: false, error: 'siteName obrigatório' }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }
          const siteDir = join(__dirname, '..', 'sites', siteName.trim());
          if (!existsSync(siteDir)) {
            return new Response(
              JSON.stringify({ success: false, error: `Pasta sites/${siteName} não existe` }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }
          const token = getGitHubToken();
          let url = remoteUrl ? (token ? injectTokenIntoUrl(remoteUrl, token) : remoteUrl) : null;
          if (!url && token) {
            const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: siteDir, encoding: 'utf-8' });
            if (r.status === 0 && r.stdout?.trim()) url = injectTokenIntoUrl(r.stdout.trim(), token);
          }
          if (url) {
            const hasOrigin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: siteDir }).status === 0;
            if (hasOrigin) spawnSync('git', ['remote', 'set-url', 'origin', url], { cwd: siteDir });
            else spawnSync('git', ['remote', 'add', 'origin', url], { cwd: siteDir });
          }
          ensureGitUser(siteDir);
          spawnSync('git', ['config', 'http.postBuffer', '524288000'], { cwd: siteDir });
          spawnSync('git', ['add', '.'], { cwd: siteDir });
          const commit = spawnSync('git', ['commit', '-m', 'Site inicial'], { cwd: siteDir });
          if (commit.status !== 0 && !commit.stderr?.includes('nothing to commit')) {
            return new Response(
              JSON.stringify({ success: false, error: commit.stderr || 'Erro no commit' }),
              { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }
          const push = spawnSync('git', ['push', '-u', 'origin', branch], { cwd: siteDir, encoding: 'utf-8' });
          if (push.status !== 0) {
            return new Response(
              JSON.stringify({ success: false, error: push.stderr || 'Erro no push' }),
              { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }
          return new Response(
            JSON.stringify({ success: true }),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        } catch (e) {
          console.error('\x1b[31m✖ Erro git-push:\x1b[0m', e);
          return new Response(
            JSON.stringify({ success: false, error: (e as Error).message }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
      }

      if (pathname === '/api/reset' && req.method === 'POST') {
        try {
          const projectRoot = join(__dirname, '..');
          spawnSync('bun', ['run', 'scripts/reset.ts'], { cwd: projectRoot, encoding: 'utf-8' });
          return new Response(
            JSON.stringify({ success: true }),
            { headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        } catch (e) {
          console.error('\x1b[31m✖ Erro reset:\x1b[0m', e);
          return new Response(
            JSON.stringify({ success: false, error: (e as Error).message }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
      }

      if (pathname.startsWith('/preview/') && req.method === 'GET') {
        const projectRoot = join(__dirname, '..');
        const sitesDir = join(projectRoot, 'sites');
        const rest = pathname.slice('/preview/'.length).replace(/^\//, '');
        const parts = rest.split('/').filter(Boolean);
        const slug = parts[0] || '';
        if (!slug || slug.includes('..')) {
          return new Response(JSON.stringify({ error: 'Slug inválido' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
        const distDir = join(sitesDir, slug, 'dist');
        if (!existsSync(distDir)) {
          return new Response(
            JSON.stringify({ error: `Build não encontrado. Execute: cd sites/${slug} && bun run build` }),
            { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
        const relPath = parts.slice(1).join('/') || '';
        let filePath = join(distDir, relPath === '' ? 'index.html' : relPath);
        if (existsSync(filePath) && statSync(filePath).isDirectory()) {
          filePath = join(filePath, 'index.html');
        } else if (!existsSync(filePath) && relPath !== '') {
          const asDir = join(distDir, relPath, 'index.html');
          if (existsSync(asDir)) filePath = asDir;
        }
        if (!existsSync(filePath)) {
          return new Response(JSON.stringify({ error: 'Arquivo não encontrado' }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } });
        }
        let content = readFileSync(filePath);
        const ext = extname(filePath);
        const prefix = `/preview/${slug}`;
        if (ext === '.html') {
          const html = content.toString('utf-8');
          const rewritten = html
            .replace(/\s(href|src)=["']\/(?!\/)/g, ` $1="${prefix}/`)
            .replace(/content=(["'])(\d+);url=\/(?!\/)/g, (_, q, n) => `content=${q}${n};url=${prefix}/`);
          content = Buffer.from(rewritten, 'utf-8');
        }
        const mimes: Record<string, string> = {
          '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
          '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
          '.woff': 'font/woff', '.woff2': 'font/woff2',
        };
        return new Response(content, {
          headers: { 'Content-Type': mimes[ext] || 'application/octet-stream', ...CORS },
        });
      }

      if (pathname === '/' || pathname === '/api' || pathname === '/api/health') {
        return new Response(
          JSON.stringify({
            ok: true,
            endpoints: [
              'POST /api/capture',
              'POST /api/download-images',
              'POST /api/save-prompts',
              'POST /api/test-links',
              'POST /api/export-site',
              'POST /api/git-push',
              'GET/POST /api/credentials',
              'POST /api/github/create-repo',
              'POST /api/reset',
              'GET /api/sites',
              'POST /api/sites/update-deploy-url',
              'GET /api/images?slug=xxx',
              'GET /preview/:slug (local preview)',
            ],
          }),
          { headers: { 'Content-Type': 'application/json', ...CORS } }
        );
      }

      if (pathname !== '/api/capture' || req.method !== 'POST') {
        return new Response(
          JSON.stringify({ error: 'Use POST /api/capture ou POST /api/download-images. Reinicie o servidor: bun run dev:full' }),
          { status: 404, headers: { 'Content-Type': 'application/json', ...CORS } }
        );
      }

      try {
        const body = (await req.json()) as { url?: string; urls?: string[] };
        let urls: string[] = [];
        if (Array.isArray(body.urls) && body.urls.length > 0) {
          urls = body.urls.map((u) => String(u).trim()).filter(Boolean);
        } else if (body?.url?.trim()) {
          urls = [body.url.trim()];
        }
        if (urls.length === 0) {
          return new Response(
            JSON.stringify({ error: 'Informe url ou urls (array)' }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
          );
        }
        for (const u of urls) {
          if (!u.startsWith('http://') && !u.startsWith('https://')) {
            return new Response(
              JSON.stringify({ error: `URL inválida: ${u}` }),
              { status: 400, headers: { 'Content-Type': 'application/json', ...CORS } }
            );
          }
        }
        const { pages } = await capture(urls);
        return new Response(
          JSON.stringify({
            success: true,
            pages,
            files: pages.flatMap((p) => p.files),
          }),
          { headers: { 'Content-Type': 'application/json', ...CORS } }
        );
      } catch (e) {
        console.error('\x1b[31m✖ Erro na captura:\x1b[0m', e);
        return new Response(
          JSON.stringify({ error: (e as Error).message }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...CORS } }
        );
      }
    },
  });
  console.log(`\n\x1b[32m✓\x1b[0m Servidor de captura em http://localhost:${PORT}`);
  console.log(`  POST /api/capture - capturar páginas`);
  console.log(`  POST /api/download-images - baixar imagens`);
  console.log(`  POST /api/save-prompts - salvar prompts no projeto`);
  console.log(`  GET  /api/images?slug=xxx - listar imagens\n`);
} catch (e: unknown) {
  const err = e as { code?: string };
  if (err?.code === 'EADDRINUSE') {
    console.error('\x1b[31m✖ Porta 3001 em uso.\x1b[0m Mate: lsof -ti:3001 | xargs kill -9');
  } else {
    console.error('\x1b[31m✖ Erro:\x1b[0m', e);
  }
  process.exit(1);
}
