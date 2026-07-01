'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.release');
const RELEASE_DIR = path.join(OUT_DIR, 'pamyat-qr');
const ZIP_PATH = path.join(ROOT, 'pamyat-qr-release.zip');

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'test-results',
  'playwright-report',
  '.git',
  '.release',
  'sessions',
  'logs'
]);

const EXCLUDE_FILES = new Set([
  '.DS_Store',
  'pamyat-qr-release.zip',
  'pamyat-qr-current.zip',
  'pamyat-qr-current-with-results.zip'
]);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function mkdir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function shouldSkip(absPath) {
  const rel = path.relative(ROOT, absPath);
  const parts = rel.split(path.sep);

  if (parts.includes('node_modules')) return true;
  if (parts.includes('test-results')) return true;
  if (parts.includes('playwright-report')) return true;
  if (parts.includes('.git')) return true;
  if (parts.includes('.release')) return true;
  if (parts.includes('sessions')) return true;
  if (parts.includes('logs')) return true;
  if (parts.join('/') === 'uploads/tmp') return true;
  if (parts[0] === 'uploads' && parts[1] === 'tmp') return true;

  const base = path.basename(absPath);
  if (EXCLUDE_FILES.has(base)) return true;
  if (base.endsWith('.zip')) return true;

  return false;
}

function copyDir(src, dest) {
  if (shouldSkip(src)) return;
  const st = fs.statSync(src);

  if (st.isDirectory()) {
    mkdir(dest);
    for (const name of fs.readdirSync(src)) {
      copyDir(path.join(src, name), path.join(dest, name));
    }
    return;
  }

  mkdir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function walk(dir, cb) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, cb);
    else cb(p);
  }
}

function isTextFile(p) {
  return /\.(html|css|js|json|md)$/i.test(p);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function convertImages() {
  const imageRoots = [
    path.join(RELEASE_DIR, 'public'),
    path.join(RELEASE_DIR, 'uploads')
  ];

  const replacements = [];

  for (const root of imageRoots) {
    walk(root, file => {
      if (!/\.(jpe?g|png)$/i.test(file)) return;
      replacements.push(file);
    });
  }

  const map = [];

  for (const oldPath of replacements) {
    const newPath = oldPath.replace(/\.(jpe?g|png)$/i, '.webp');

    try {
      await sharp(oldPath)
        .rotate()
        .resize({
          width: 1800,
          height: 1800,
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality: 76, effort: 5 })
        .toFile(newPath);

      const oldRel = path.relative(RELEASE_DIR, oldPath).replaceAll(path.sep, '/');
      const newRel = path.relative(RELEASE_DIR, newPath).replaceAll(path.sep, '/');

      map.push({
        oldRel,
        newRel,
        oldBase: path.basename(oldPath),
        newBase: path.basename(newPath)
      });

      fs.unlinkSync(oldPath);
    } catch (e) {
      console.warn('[image skip]', oldPath, e.message);
    }
  }

  return map;
}

function rewriteReferences(map) {
  const textFiles = [];
  walk(RELEASE_DIR, file => {
    if (isTextFile(file)) textFiles.push(file);
  });

  for (const file of textFiles) {
    let txt = fs.readFileSync(file, 'utf8');
    let changed = false;

    for (const item of map) {
      const pairs = [
        [item.oldRel, item.newRel],
        [item.oldRel.replace(/^public\//, '/static/'), item.newRel.replace(/^public\//, '/static/')],
        [item.oldRel.replace(/^public\//, ''), item.newRel.replace(/^public\//, '')],
        [item.oldBase, item.newBase]
      ];

      for (const [from, to] of pairs) {
        const next = txt.replace(new RegExp(escapeRegExp(from), 'g'), to);
        if (next !== txt) {
          txt = next;
          changed = true;
        }
      }
    }

    if (changed) fs.writeFileSync(file, txt, 'utf8');
  }
}


function normalizeDemoAssetReferences() {
  const demoFiles = [
    {
      file: path.join(RELEASE_DIR, 'public', 'examples', 'b2b', 'index.html'),
      prefix: '/static/examples/b2b/assets/'
    },
    {
      file: path.join(RELEASE_DIR, 'public', 'examples', 'b2c', 'index.html'),
      prefix: '/static/examples/b2c/assets/'
    },
    {
      file: path.join(RELEASE_DIR, 'public', 'examples', 'memory', 'index.html'),
      prefix: '/static/examples/memory/assets/'
    }
  ];

  for (const item of demoFiles) {
    if (!fs.existsSync(item.file)) continue;
    let txt = fs.readFileSync(item.file, 'utf8');
    const before = txt;

    txt = txt.replace(/(["'])assets\/([^"']+\.(?:webp|jpg|jpeg|png|svg|mp4))\1/g, (m, q, name) => `${q}${item.prefix}${name}${q}`);
    txt = txt.replace(/url\((["']?)assets\/([^"')]+\.(?:webp|jpg|jpeg|png|svg|mp4))\1\)/g, (m, q, name) => `url(${q}${item.prefix}${name}${q})`);

    if (txt !== before) fs.writeFileSync(item.file, txt, 'utf8');
  }
}


function writeManifest(map) {
  const manifest = {
    createdAt: new Date().toISOString(),
    source: ROOT,
    releaseDir: RELEASE_DIR,
    convertedImages: map.length,
    rules: {
      excluded: [
        'node_modules',
        'test-results',
        'playwright-report',
        '.git',
        '.release',
        'sessions',
        'logs',
        'uploads/tmp',
        '*.zip',
        '.DS_Store'
      ],
      images: 'jpg/jpeg/png -> webp, max 1800px, quality 76'
    },
    images: map
  };

  fs.writeFileSync(
    path.join(RELEASE_DIR, 'RELEASE_PACKAGE_MANIFEST.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
}

async function zipRelease() {
  rmrf(ZIP_PATH);

  const output = fs.createWriteStream(ZIP_PATH);
  const archive = archiver('zip', { zlib: { level: 9 } });

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(RELEASE_DIR, 'pamyat-qr');
    archive.finalize();
  });

  return fs.statSync(ZIP_PATH).size;
}

(async () => {
  console.log('[pack] cleaning release dir');
  rmrf(OUT_DIR);
  mkdir(RELEASE_DIR);

  console.log('[pack] copying project');
  copyDir(ROOT, RELEASE_DIR);

  console.log('[pack] converting images');
  const map = await convertImages();

  console.log(`[pack] converted images: ${map.length}`);
  console.log('[pack] rewriting references');
  rewriteReferences(map);

  console.log('[pack] normalizing demo asset references');
  normalizeDemoAssetReferences();

  console.log('[pack] writing manifest');
  writeManifest(map);

  console.log('[pack] creating zip');
  const size = await zipRelease();

  console.log('[pack] done');
  console.log(`[pack] zip: ${ZIP_PATH}`);
  console.log(`[pack] size: ${(size / 1024 / 1024).toFixed(2)} MB`);
})();
