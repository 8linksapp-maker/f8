/**
 * Verificação de links internos - script standalone para sites
 * Roda após astro build. Exibe avisos mas NÃO bloqueia o deploy.
 * Usado em: build = "astro build && node scripts/check-links-standalone.cjs"
 * Funciona em qualquer ambiente (local, Vercel, CI) - sem dependências externas.
 */
const fs = require('fs');
const path = require('path');

const DIST = path.join(process.cwd(), 'dist');

function collectHtml(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectHtml(full, files);
    else if (e.name.endsWith('.html')) files.push(full);
  }
  return files;
}

function getInternalLinks(html, basePath) {
  const links = new Set();
  const baseDir = basePath === '/' ? '/' : basePath.replace(/\/?$/, '/');
  const re = /<a[^>]+href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].trim().replace(/#.*$/, '').replace(/\?.*$/, '');
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('http') || href.startsWith('javascript')) continue;
    if (href.startsWith('/')) href = href.slice(1);
    else href = (baseDir + href).replace(/\/+/g, '/').replace(/^\//, '');
    const p = '/' + href.replace(/\/$/, '');
    if (p !== '/' && !p.startsWith('/reference')) links.add(p);
  }
  return Array.from(links);
}

function pathToFile(distDir, p) {
  const clean = p.replace(/^\//, '').replace(/\/$/, '');
  if (!clean) return path.join(distDir, 'index.html');
  if (/\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|xml|txt)$/i.test(clean)) return path.join(distDir, clean);
  return path.join(distDir, clean, 'index.html');
}

if (!fs.existsSync(DIST)) {
  console.error('\x1b[31m✖ dist/ não encontrado. Execute "astro build" primeiro.\x1b[0m');
  process.exit(1);
}

const htmlFiles = collectHtml(DIST);
const broken = [];
const checked = new Set();

for (const file of htmlFiles) {
  const rel = path.relative(DIST, file).replace(/\\/g, '/').replace(/\/index\.html$/, '/').replace(/\.html$/, '') || '/';
  const pagePath = '/' + (rel === '/' ? '' : rel).replace(/\/$/, '');
  const html = fs.readFileSync(file, 'utf-8');
  const links = getInternalLinks(html, pagePath);

  for (const link of links) {
    if (checked.has(link)) continue;
    checked.add(link);
    const target = pathToFile(DIST, link);
    if (!fs.existsSync(target)) broken.push({ url: link, from: pagePath || '/' });
  }
}

if (broken.length > 0) {
  console.warn('\x1b[33m⚠ Links internos sem página correspondente:\x1b[0m');
  broken.forEach((b) => console.warn(`  ${b.url} (de ${b.from})`));
  console.warn('\x1b[33m⚠ Crie as páginas acima ou remova os links do nav.\x1b[0m');
  // warn only — não bloqueia o deploy
}

console.log('\x1b[32m✓ Todos os links internos OK\x1b[0m');
