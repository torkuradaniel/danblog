import { writeFileSync } from 'fs';
import { globby } from 'globby';

const SITE_URL = 'https://torkura.com';

async function generateSitemap() {
  // Get all HTML files from dist directory
  const pages = await globby([
    'dist/**/*.html',
    '!dist/**/404.html',
  ]);

  // Generate sitemap XML
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map((page) => {
    const path = page
      .replace('dist/', '')
      .replace('/index.html', '')
      .replace('.html', '');
    const url = `${SITE_URL}/${path}`;
    
    return `  <url>
    <loc>${url}</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`;
  })
  .join('\n')}
</urlset>`;

  // Write sitemap to dist directory
  writeFileSync('dist/sitemap.xml', sitemap);
  console.log('✓ Sitemap generated successfully!');
}

generateSitemap().catch(console.error);
