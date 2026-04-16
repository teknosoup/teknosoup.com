# teknosoup.com

Personal blog and website powered by **Next.js** (frontend) and **Strapi** (headless CMS), migrated from Ghost.

## Stack

- **Frontend** — Next.js 16 with App Router, React 19, TypeScript, Tailwind CSS
- **CMS** — Strapi v5 (self-hosted)
- **Database** — PostgreSQL (production), SQLite (local dev)
- **Deployment** — Docker Compose on a self-hosted VM

## Project Structure

```
teknosoup.com/
├── next/                  # Next.js frontend
├── strapi/                # Strapi CMS
├── scripts/
│   └── ghost-migration/   # One-time Ghost → Strapi migration script
├── docker-compose.yml     # Production Docker setup
└── .env.example           # Environment variable template
```

## Local Development

### Prerequisites

- Node.js v18+
- Yarn (`corepack enable` or `npm install -g yarn`)

### Setup

```sh
git clone git@github.com:teknosoup/teknosoup.com.git
cd teknosoup.com
yarn install
yarn setup
yarn dev
```

- Strapi admin: http://localhost:1337/admin
- Frontend: http://localhost:3000

## Production (Docker)

All services run via Docker Compose: Ghost (legacy, during migration), Strapi, PostgreSQL, and Next.js.

```sh
cp .env.example .env
# Fill in secrets, then:
docker compose up -d --build
```

Services:
| Service | Port | URL |
|---------|------|-----|
| Next.js | 3000 | teknosoup.com |
| Strapi | 1337 | cms.teknosoup.com |
| Ghost (legacy) | 2368 | — |

## Ghost Migration

To import posts from the legacy Ghost blog:

```sh
# 1. Fill in Ghost DB credentials + Strapi API token in .env
# 2. Test with one post
LIMIT=1 docker compose run --rm migration

# 3. Run full migration (idempotent — safe to re-run)
docker compose run --rm migration
```

The migration script reads directly from Ghost's MySQL database, uploads images to Strapi's media library, and creates articles preserving original slugs and publish dates.

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|----------|-------------|
| `POSTGRES_PASSWORD` | PostgreSQL password for Strapi |
| `STRAPI_APP_KEYS` | Comma-separated Strapi app keys |
| `STRAPI_ADMIN_JWT_SECRET` | Strapi admin JWT secret |
| `STRAPI_API_TOKEN_SALT` | Strapi API token salt |
| `STRAPI_TRANSFER_TOKEN_SALT` | Strapi transfer token salt |
| `STRAPI_JWT_SECRET` | Strapi JWT secret |
| `STRAPI_API_TOKEN` | Full-access API token (for migration) |

Generate secrets with: `openssl rand -base64 32`
