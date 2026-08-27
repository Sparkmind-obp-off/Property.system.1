# Property System (PS-MASTER-001)

Sistem bisnis vertikal untuk operasi properti rental — bukan website properti, tapi
**operational system** yang menjalankan rantai komersial:

```
PROPERTY → PROPERTY INTELLIGENCE → TARGET TENANT → OFFER → LEAD
        → QUALIFICATION → FOLLOW-UP → VISIT → NEGOTIATION → RENTAL
```

## Project Overview

- **Name**: Property System
- **System ID**: PS-MASTER-001 (vertical of Business System Builder)
- **Goal**: Mengubah inventori properti menjadi workflow komersial yang terstruktur,
  terukur, dan repeatable — tanpa manipulasi database manual.
- **Tech Stack**: Hono + TypeScript + Cloudflare Pages/Workers + D1 (SQLite) +
  vanilla-JS SPA (no build step untuk frontend)

## Status

| Gate | Hasil |
| --- | --- |
| Typecheck (`tsc --noEmit`) | ✅ clean |
| Unit tests | ✅ 121/121 pass (7 files) |
| Golden E2E flow (§42/§43) | ✅ 81/81 assertions pass |
| UI smoke test (semua screen) | ✅ 22/22 screens OK |
| Build (`vite build`) | ✅ `dist/_worker.js` ~187 kB |

## URLs

- **Local dev**: http://localhost:3000
- **Sandbox preview**: https://3000-ir0f8iuvvw2sor03y8odw-cc2fbc16.sandbox.novita.ai
- **GitHub**: https://github.com/Sparkmind-obp-off/Property.system.1
- **Production (Cloudflare Pages)**: https://property-system.pages.dev
- **Health check**: https://property-system.pages.dev/api/v1/health

## Login (dev seed only — §44)

| Role | Email | Password |
| --- | --- | --- |
| OWNER | `owner@propertysystem.local` | `Owner#2026` |
| OPERATOR | `operator@propertysystem.local` | `Operator#2026` |
| MARKETING | `marketing@propertysystem.local` | `Marketing#2026` |
| ANALYST | `analyst@propertysystem.local` | `Analyst#2026` |
| ADMIN | `admin@propertysystem.local` | `Admin#2026` |

Kredensial ini **hanya untuk development** (berasal dari `seed.sql`) dan **tidak pernah**
diterapkan ke produksi (§44).

## Login (production bootstrap)

Database produksi hanya berisi *reference data*: 5 role + 1 user ADMIN bootstrap.
Nol fixture bisnis (0 property / tenant / lead), sesuai §44.

| Role | Email | Password |
| --- | --- | --- |
| ADMIN | `admin@property-system.app` | dibuat via `scripts/gen-admin-credential.mjs` — tidak pernah di-commit (§45) |

Password bootstrap **wajib dirotasi setelah login pertama**. Seluruh user lain harus
dibuat lewat aplikasi (`POST /api/v1/users`), bukan lewat SQL.

## Architecture

Modular, domain-driven, API-first. Setiap modul memiliki batas kepemilikan yang jelas
(§4) dan tidak ada monolithic business service.

```
src/
├── index.tsx                     # Entry point: request pipeline + route mounting
├── shared/                       # errors, http contract, middleware, permissions,
│                                 # crypto (PBKDF2 + JWT), repository, validate, audit
└── modules/
    ├── identity/                 # auth, users, roles, permissions, audit logs
    ├── property/                 # property CRUD + lifecycle state machine
    ├── intelligence/             # SWOT / commercial analysis (explainable)
    ├── tenant/                    # tenant profile + segments
    ├── matching/                 # property ↔ tenant fit engine (score + reasons)
    ├── offer/                    # offer + campaign lifecycle
    ├── lead/                     # lead pipeline + qualification
    ├── operations/               # follow-up, visit, activity timeline
    ├── negotiation/              # proposal / counter / accept
    ├── rental/                   # rental lifecycle + activation transaction
    └── analytics/                # dashboard, funnel, market intelligence
```

Setiap modul berlapis: `domain/` (aturan bisnis murni, tanpa dependensi HTTP/ORM) →
`application/` (use case, orkestrasi, transaksi) → `api/` (kontrak HTTP).

### Request pipeline (§34)

```
REQUEST → REQUEST-ID → AUTHENTICATE → AUTHORIZE → VALIDATE
        → APPLICATION SERVICE → DOMAIN RULE → PERSISTENCE → RESPONSE
```

Tidak ada mutasi database langsung dari controller untuk operasi bisnis kritis.

### Response contract (§35)

```jsonc
// success
{ "data": {}, "meta": {} }
// error — kode stabil & machine-readable
{ "error": { "code": "BUSINESS_RULE_VIOLATION", "message": "Property is already rented." } }
```

## API Endpoints

Semua di bawah prefix `/api/v1`.

### Identity
| Method | Path | Keterangan |
| --- | --- | --- |
| POST | `/auth/login` | Login, mengembalikan JWT |
| POST | `/auth/logout` | Logout |
| GET | `/auth/me` | Sesi + roles + permissions |
| GET | `/users` | Daftar user (ADMIN) |
| POST | `/users` | Buat user (ADMIN) |
| PATCH | `/users/:id` | Update user (ADMIN) |
| GET | `/roles` · `/permissions` | Katalog otorisasi |
| GET | `/audit-logs` | Jejak audit (ADMIN, §46) |

### Property
| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/properties` | List (filter, pagination) |
| POST | `/properties` | Buat properti |
| GET | `/properties/:id` | Detail + intelligence + leads |
| PATCH | `/properties/:id` | Update |
| DELETE | `/properties/:id` | Archive (konfirmasi, §29) |
| POST | `/properties/:id/verify` | Verifikasi (OWNER) |
| POST | `/properties/:id/analyze` | Property intelligence (§6) |
| GET | `/properties/:id/matches` | Kandidat tenant + skor + alasan |

### Tenant & Matching
| Method | Path |
| --- | --- |
| GET/POST `/tenants` · GET/PATCH `/tenants/:id` |
| GET | `/tenants/:id/matches` |
| GET/POST `/tenant-segments` |

### Offer & Campaign
| Method | Path | Keterangan |
| --- | --- | --- |
| GET/POST | `/offers` | Offer lifecycle DRAFT→READY→PUBLISHED→PAUSED→ARCHIVED |
| POST | `/offers/:id/publish` | Publikasi (konfirmasi, §29) |
| POST | `/offers/:id/pause` · `/offers/:id/archive` | Transisi eksplisit |
| GET/POST | `/campaigns` | Campaign + performa |

### Lead
| Method | Path | Keterangan |
| --- | --- | --- |
| GET/POST | `/leads` | Pipeline NEW→CONTACTED→QUALIFIED→VISIT→NEGOTIATION→WON/LOST |
| GET | `/leads/:id` | Detail + timeline + next action |
| POST | `/leads/:id/qualify` | Kualifikasi explainable (§11) |
| POST | `/leads/:id/contact` · `/leads/:id/lose` | Transisi eksplisit |
| POST | `/leads/:id/assign` | Assign owner |

### Operations
| Method | Path | Keterangan |
| --- | --- | --- |
| GET/POST | `/follow-ups` | PENDING/COMPLETED/RESCHEDULED/CANCELLED |
| POST | `/follow-ups/:id/complete` · `/reschedule` · `/cancel` | |
| GET/POST | `/visits` | Scheduling |
| POST | `/visits/:id/confirm` · `/complete` · `/cancel` · `/reschedule` | Hasil: STRONG_FIT/POTENTIAL/WEAK_FIT/NO_FIT |
| GET | `/activities` | Activity timeline (operational memory, §13) |

### Negotiation
| Method | Path |
| --- | --- |
| GET/POST | `/negotiations` |
| POST | `/negotiations/:id/counter` · `/accept` · `/reject` |

### Rental
| Method | Path | Keterangan |
| --- | --- | --- |
| GET/POST | `/rentals` | DRAFT→PENDING→ACTIVE→EXPIRING→ENDED |
| POST | `/rentals/:id/activate` | **Operasi kritis & transaksional** (§17) |
| POST | `/rentals/:id/end` · `/cancel` | |

### Analytics & Market
| Method | Path |
| --- | --- |
| GET | `/dashboard` — action center (§19) |
| GET | `/analytics/funnel` · `/analytics/properties` · `/analytics/campaigns` |
| GET | `/market` — market intelligence (§21) |

Semua transisi bisnis kritis memakai endpoint eksplisit, bukan `PATCH status`
sembarang (§33).

## Data Architecture

- **Storage**: Cloudflare D1 (SQLite) — satu-satunya sumber kebenaran transaksional
- **Migrations**: `migrations/0001_identity.sql` … `0007_governance.sql` (versioned)
- **Seed**: `seed.sql` — 5 user, 5 properti, 5 tenant, 10 lead, 3 visit,
  2 negosiasi, 1 rental (§44)

### Domain entities

`users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `sessions`,
`properties`, `property_media`, `property_analyses`, `tenants`, `tenant_segments`,
`offers`, `campaigns`, `leads`, `lead_qualifications`, `follow_ups`, `visits`,
`activities`, `negotiations`, `negotiation_rounds`, `rentals`, `audit_logs`,
`notifications`.

### Integritas yang dijaga

- **Double-rental protection (§18)**: satu properti tidak bisa punya dua rental
  ACTIVE — dijaga di level database + aplikasi (unique partial index + transaksi),
  bukan hanya validasi frontend.
- **State machine**: transisi tidak valid ditolak dengan
  `INVALID_STATE_TRANSITION`.
- **Rental activation (§17)**: validasi properti tersedia, tenant valid, terms
  lengkap, negosiasi diterima, lalu transaksional menandai properti `RENTED`.
- **Otorisasi server-side (§3)**: penyembunyian UI hanya lapisan usability.
- **Audit (§46)**: WHO / WHAT / WHEN / ENTITY / RESULT untuk aksi bisnis penting.

## Frontend

SPA vanilla-JS modular tanpa build step, di `public/static/js/`:

```
core/     router.js · api.js · shell.js · dom.js
screens/  dashboard · properties · tenants · leads · activities · visits
          negotiations · rentals · offers · market · analytics · settings · login
```

Navigasi mengikuti workflow user, bukan entitas database (§22). Setiap screen
menangani state LOADING / EMPTY / SUCCESS / ERROR / PERMISSION-DENIED / NOT-FOUND
(§27), dan empty state selalu menawarkan next action.

Deep link (`/dashboard`, `/leads/led_x`) di-resolve ke app shell oleh Worker
catch-all route, sementara `/api/*` yang tak dikenal tetap mengembalikan 404
berkontrak.

## User Guide

1. Buka aplikasi → login (lihat tabel kredensial di atas).
2. **Dashboard** menampilkan yang butuh aksi lebih dulu: follow-up jatuh tempo,
   lead belum dikontak, visit besok, negosiasi menunggu respons.
3. **Properties** → tambah properti → `Analyze` untuk melihat
   strengths/weaknesses/opportunities/risks → `Find Tenant` untuk kandidat tenant
   beserta skor dan alasannya.
4. **Offers** → buat offer dari properti → `Publish` untuk mulai akuisisi lead.
5. **Leads** → pipeline kanban → `Qualify` → jadwalkan visit → catat hasil visit.
6. **Negotiations** → ajukan/counter → `Accept`.
7. **Rentals** → `Activate` (properti otomatis jadi tidak tersedia) → `End`
   (properti kembali AVAILABLE).
8. **Analytics** → funnel LEAD → QUALIFIED → VISIT → NEGOTIATION → RENTAL.

## Development

```bash
npm install

# Database lokal (SQLite otomatis via --local)
npm run db:migrate:local
npm run db:seed

# Build + jalankan
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000/api/v1/health

# Reset database lokal
npm run db:reset
```

## Testing

```bash
npm run typecheck            # tsc --noEmit
npx vitest run tests/unit    # 121 unit tests — domain rules & state machines
node tests/e2e/golden-flow.mjs   # 81 assertions — golden vertical slice §42/§43
node tests/e2e/ui-smoke.mjs      # 22 screens — console errors, failed requests
```

Golden E2E memverifikasi jalur utama end-to-end plus proteksi: double active
rental ditolak, rented property tak bisa di-remarket, ACTIVE rental tak bisa
dibatalkan (harus di-end), dan otorisasi per-role ditegakkan server-side.

## Deployment

- **Platform**: Cloudflare Pages (Workers runtime) + D1
- **Status**: ✅ ACTIVE — https://property-system.pages.dev
- **Cloudflare Pages project**: `property-system` (production branch `main`)
- **D1 database**: `property-system-production` (binding `DB`), 7 migrasi applied
- **Build output**: `dist/` (`_worker.js` ~187 kB)
- **Secrets**: `JWT_SECRET` di-set sebagai Pages secret produksi
  (`wrangler pages secret put JWT_SECRET`); lihat `.env.example`. Secrets tidak
  pernah di-commit (§45).

### First-time production setup

```bash
npx wrangler d1 create property-system-production          # catat database_id → wrangler.jsonc
npx wrangler pages project create property-system --production-branch main

npm run db:migrate:prod                                    # 7 migrasi → D1 remote
npm run db:bootstrap:prod                                  # reference data: 5 roles

node scripts/gen-admin-credential.mjs                      # password + PBKDF2 hash
# insert user ADMIN memakai hash tersebut (lihat header bootstrap-production.sql)

npx wrangler pages secret put JWT_SECRET --project-name property-system
```

### Redeploy

```bash
npm run build
npm run deploy:prod
```

### Production data policy (§44)

`seed.sql` adalah fixture **development** dan tidak pernah dijalankan terhadap D1
remote. Produksi hanya di-bootstrap dengan reference data
(`scripts/bootstrap-production.sql`) — nol property/tenant/lead palsu.

## Traceability

Spesifikasi sumber: dokumen `01`–`11` (PS-VIS-001 … PS-IMP-011) dan
PS-MASTER-001. Setiap modul, use case, endpoint, tabel, screen, dan test
menelusuri kembali ke pasal spesifikasi — dicatat sebagai komentar
`Traceability:` di header tiap file. Tidak ada orphan UI, orphan API, orphan
use case, atau orphan database field (§40, §51).

**Last Updated**: 2026-08-27
