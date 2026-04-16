require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const axios = require('axios');
const FormData = require('form-data');
const cheerio = require('cheerio');

// ─── Config ───────────────────────────────────────────────────────────────────

const GHOST_CONTENT_PATH = process.env.GHOST_CONTENT_PATH || '/var/lib/ghost/content';
const STRAPI_API_URL = process.env.STRAPI_API_URL || 'http://localhost:1337';
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN;
const DRY_RUN = process.env.DRY_RUN === 'true';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null;
const DELAY_MS = 100;

if (!STRAPI_API_TOKEN) {
  console.error('ERROR: STRAPI_API_TOKEN is required. Generate one in Strapi Admin → Settings → API Tokens');
  process.exit(1);
}

const strapiHeaders = {
  Authorization: `Bearer ${STRAPI_API_TOKEN}`,
};

// ─── Strapi helpers ───────────────────────────────────────────────────────────

async function strapiGet(endpoint, params = {}) {
  const res = await axios.get(`${STRAPI_API_URL}/api${endpoint}`, {
    headers: strapiHeaders,
    params,
  });
  return res.data;
}

async function strapiPost(endpoint, data) {
  const res = await axios.post(`${STRAPI_API_URL}/api${endpoint}`, data, {
    headers: { ...strapiHeaders, 'Content-Type': 'application/json' },
  });
  return res.data;
}

async function strapiUpload(filePath, fileName) {
  const form = new FormData();
  form.append('files', fs.createReadStream(filePath), fileName);
  const res = await axios.post(`${STRAPI_API_URL}/api/upload`, form, {
    headers: { ...strapiHeaders, ...form.getHeaders() },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return res.data[0]; // Returns the uploaded media object
}

// ─── Category helpers ─────────────────────────────────────────────────────────

const categoryCache = {}; // slug → strapi category id

async function upsertCategory(name, slug) {
  if (categoryCache[slug]) return categoryCache[slug];

  const existing = await strapiGet('/categories', {
    'filters[slug][$eq]': slug,
  });

  if (existing.data && existing.data.length > 0) {
    categoryCache[slug] = existing.data[0].id;
    return existing.data[0].id;
  }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would create category: ${name} (${slug})`);
    categoryCache[slug] = `dry-run-${slug}`;
    return categoryCache[slug];
  }

  const created = await strapiPost('/categories', {
    data: { name, slug },
  });
  categoryCache[slug] = created.data.id;
  console.log(`  Created category: ${name}`);
  return created.data.id;
}

// ─── Image helpers ────────────────────────────────────────────────────────────

const imageCache = {}; // local path → strapi media URL

async function uploadLocalImage(localImagePath) {
  if (imageCache[localImagePath]) return imageCache[localImagePath];

  const absolutePath = localImagePath.startsWith('/')
    ? path.join(GHOST_CONTENT_PATH, localImagePath)
    : path.join(GHOST_CONTENT_PATH, '/', localImagePath);

  if (!fs.existsSync(absolutePath)) {
    console.warn(`  WARNING: Image not found at ${absolutePath}, skipping`);
    return null;
  }

  if (DRY_RUN) {
    const fakeUrl = `${STRAPI_API_URL}/uploads/dry-run-${path.basename(localImagePath)}`;
    imageCache[localImagePath] = { url: fakeUrl, id: null };
    return imageCache[localImagePath];
  }

  const uploaded = await strapiUpload(absolutePath, path.basename(localImagePath));
  imageCache[localImagePath] = { url: uploaded.url, id: uploaded.id };
  return imageCache[localImagePath];
}

// Convert a Ghost image URL (e.g. /content/images/2023/01/photo.jpg)
// to a local filesystem path relative to GHOST_CONTENT_PATH
function ghostUrlToLocalPath(ghostUrl) {
  // Ghost stores images at: /content/images/...
  // On disk: GHOST_CONTENT_PATH/images/...
  const match = ghostUrl.match(/\/content\/(images\/.+)/);
  if (match) return match[1];
  return null;
}

async function rewriteImagesInHtml(html) {
  if (!html) return html;

  const $ = cheerio.load(html, { decodeEntities: false });
  const imgTags = $('img').toArray();

  for (const img of imgTags) {
    const src = $(img).attr('src');
    if (!src) continue;

    const localPath = ghostUrlToLocalPath(src);
    if (!localPath) continue; // Skip external images

    const uploaded = await uploadLocalImage(localPath);
    if (uploaded) {
      const newSrc = uploaded.url.startsWith('http')
        ? uploaded.url
        : `${STRAPI_API_URL}${uploaded.url}`;
      $(img).attr('src', newSrc);
    }
  }

  // Return only the body content (cheerio wraps in html/body)
  return $('body').html();
}

// ─── Slug check ───────────────────────────────────────────────────────────────

async function slugExistsInStrapi(slug) {
  const result = await strapiGet('/articles', {
    'filters[slug][$eq]': slug,
    'fields[0]': 'slug',
  });
  return result.data && result.data.length > 0;
}

// ─── Main migration ───────────────────────────────────────────────────────────

async function migrate() {
  console.log(`\n🚀 Ghost → Strapi migration starting`);
  console.log(`   Strapi: ${STRAPI_API_URL}`);
  console.log(`   Ghost content path: ${GHOST_CONTENT_PATH}`);
  console.log(`   Dry run: ${DRY_RUN}`);
  if (LIMIT) console.log(`   Limit: ${LIMIT} posts`);
  console.log('');

  // Connect to Ghost MySQL
  const db = await mysql.createConnection({
    host: process.env.GHOST_DB_HOST || '127.0.0.1',
    port: parseInt(process.env.GHOST_DB_PORT || '3306', 10),
    user: process.env.GHOST_DB_USER || 'ghost',
    password: process.env.GHOST_DB_PASSWORD,
    database: process.env.GHOST_DB_NAME || 'ghost',
  });
  console.log('✅ Connected to Ghost MySQL\n');

  // Fetch all published posts
  let query = `
    SELECT
      p.id,
      p.title,
      p.slug,
      p.html,
      p.custom_excerpt,
      p.feature_image,
      p.published_at
    FROM posts p
    WHERE p.status = 'published'
      AND p.type = 'post'
    ORDER BY p.published_at ASC
  `;
  if (LIMIT) query += ` LIMIT ${LIMIT}`;

  const [posts] = await db.query(query);
  console.log(`📄 Found ${posts.length} published posts in Ghost\n`);

  // Fetch all post→tag relationships
  const [postTags] = await db.query(`
    SELECT pt.post_id, t.name, t.slug
    FROM posts_tags pt
    JOIN tags t ON t.id = pt.tag_id
  `);

  // Build a map: post_id → [{name, slug}]
  const tagsByPost = {};
  for (const { post_id, name, slug } of postTags) {
    if (!tagsByPost[post_id]) tagsByPost[post_id] = [];
    tagsByPost[post_id].push({ name, slug });
  }

  // Stats
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const prefix = `[${i + 1}/${posts.length}]`;

    try {
      process.stdout.write(`${prefix} "${post.title}" (${post.slug}) ... `);

      // Skip if already in Strapi
      if (await slugExistsInStrapi(post.slug)) {
        console.log('SKIPPED (already exists)');
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log('DRY RUN — would create');
        created++;
        continue;
      }

      // Upload feature image
      let featureImageId = null;
      if (post.feature_image) {
        const localPath = ghostUrlToLocalPath(post.feature_image);
        if (localPath) {
          const uploaded = await uploadLocalImage(localPath);
          if (uploaded) featureImageId = uploaded.id;
        }
      }

      // Rewrite images in HTML content
      const processedHtml = await rewriteImagesInHtml(post.html);

      // Upsert categories from tags
      const tags = tagsByPost[post.id] || [];
      const categoryIds = [];
      for (const tag of tags) {
        const id = await upsertCategory(tag.name, tag.slug);
        if (id && !id.toString().startsWith('dry-run')) categoryIds.push(id);
      }

      // Build article payload
      const articleData = {
        title: post.title,
        slug: post.slug,
        description: post.custom_excerpt || post.title.substring(0, 160),
        html: processedHtml,
        publishedAt: post.published_at,
        locale: 'en',
      };

      if (featureImageId) {
        articleData.image = featureImageId;
      }

      if (categoryIds.length > 0) {
        articleData.categories = categoryIds;
      }

      // Create article in Strapi
      await strapiPost('/articles', { data: articleData });
      console.log('✓');
      created++;

      // Rate limit
      await new Promise((r) => setTimeout(r, DELAY_MS));
    } catch (err) {
      const message = err.response?.data?.error?.message || err.message;
      console.log(`ERROR: ${message}`);
      errors++;
    }
  }

  await db.end();

  console.log('\n─────────────────────────────────');
  console.log(`✅ Created:  ${created}`);
  console.log(`⏭  Skipped:  ${skipped}`);
  console.log(`❌ Errors:   ${errors}`);
  console.log(`📦 Total:    ${posts.length}`);
  console.log('─────────────────────────────────\n');

  if (errors > 0) {
    console.log('Some posts failed. Re-run the script — it will skip already-created posts and retry failures.\n');
  }
}

migrate().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
