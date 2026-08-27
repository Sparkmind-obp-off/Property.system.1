# Cloudflare Deployment — Property System

**Traceability:** PS-MASTER-001 §6 (secret configuration), §29 (deployment
documentation), §30 (preview environment), §31 (production environment),
§32 (development environment), §37 (no secret exposure)

Dokumen ini adalah prosedur resmi untuk men-deploy Property System ke
Cloudflare Pages/Workers dan mem-bootstrap akun Admin pertama.

> **Aturan mutlak (§37):** dokumen ini **tidak pernah** memuat nilai password,
> token, atau secret. Yang didokumentasikan hanya **nama variabel** dan
> **tempat mengisinya**.

---

## 1. Prasyarat

| Item | Nilai |
| --- | --- |
| Cloudflare Pages project | `property-system` |
| Build output directory | `dist` |
| D1 database | `property-system-production` |
| Runtime | Cloudflare Workers (`nodejs_compat`) |

---

## 2. Variabel produksi yang wajib

Semua variabel di bawah ini dikonfigurasi sebagai **encrypted secret** pada
environment **Production**.

| Variabel | Tipe | Wajib | Fungsi |
| --- | --- | --- | --- |
| `ADMIN_EMAIL` | Secret | ✅ | Identitas Admin pertama (§3) |
| `ADMIN_PASSWORD` | Secret | ✅ | Kredensial **bootstrap** Admin pertama (§3, §5) |
| `JWT_SECRET` | Secret | ✅ | Kunci penandatangan session token (§18) |
| `JWT_TTL_SECONDS` | Plain variable | ⬜ | Masa hidup token, default `43200` (12 jam) |

Ketentuan:

- `ADMIN_PASSWORD` minimal **12 karakter** — bootstrap ditolak jika lebih pendek.
- `ADMIN_EMAIL` harus alamat email valid.
- Tidak ada secret lain yang diperlukan. Jangan menambah secret tanpa kebutuhan (§6).
- Ketiga secret **tidak boleh** di-commit ke Git, ditulis di README, ditaruh di
  `seed.sql`, atau dikirim ke frontend (§28, §32, §37).

---

## 3. Langkah deployment (UI Cloudflare)

1. Buka **Cloudflare Dashboard → Workers & Pages**.
2. Buka (atau buat) project **`property-system`**.
3. Masuk ke **Settings**.
4. Buka **Variables and Secrets**.
5. Pilih environment **Production**.
6. Tambahkan `ADMIN_EMAIL` → **Encrypt**.
7. Tambahkan `ADMIN_PASSWORD` → **Encrypt**.
8. Tambahkan `JWT_SECRET` → **Encrypt**.
9. *(opsional)* Tambahkan `JWT_TTL_SECONDS` sebagai plain variable.
10. **Save**.
11. Jalankan **Deploy / Retry deployment** agar variabel terbaca oleh runtime.

> Variabel yang baru disimpan **belum aktif** sampai ada deployment baru.

### Alternatif via CLI (wrangler)

```bash
# Migrasi schema produksi (idempotent, aman diulang)
npm run db:migrate:prod

# Set secret produksi (nilai diminta interaktif — tidak pernah masuk shell history)
npx wrangler pages secret put ADMIN_EMAIL    --project-name property-system
npx wrangler pages secret put ADMIN_PASSWORD --project-name property-system
npx wrangler pages secret put JWT_SECRET     --project-name property-system

# Build + deploy production
npm run deploy:prod
```

---

## 4. Login pertama & verifikasi

1. Buka production URL: `https://property-system.pages.dev`
2. Halaman **login** muncul. Panel status pra-login menampilkan
   `Application / Database / Authentication / Bootstrap` (§16) — tanpa secret apa pun.
3. Masukkan `ADMIN_EMAIL` dan `ADMIN_PASSWORD`.
4. Autentikasi berjalan **server-side**; Admin dibuat otomatis pada permintaan
   pertama jika belum ada (§4).
5. Anda masuk sebagai **ADMIN** ke Admin Dashboard.
6. Buka **Settings → System Status** untuk memverifikasi:

   ```
   APPLICATION      READY
   DATABASE         CONNECTED
   AUTHENTICATION   ACTIVE
   BOOTSTRAP        COMPLETE
   ```

7. Buka **Settings → Security → Change Password** dan **rotasi kredensial
   bootstrap sekarang** (§14). Status akan menandai rotasi tertunda sampai ini
   dilakukan.
8. Buka **Settings → Users** untuk membuat user OWNER / OPERATOR / MARKETING /
   ANALYST. **Tidak perlu lagi membuka Cloudflare** untuk mengelola user biasa (§7, §12).

Verifikasi cepat lewat API (tanpa membocorkan secret):

```bash
curl https://property-system.pages.dev/api/v1/system/public-status
```

---

## 5. Perilaku redeploy (§4, §35)

| Kondisi | Perilaku |
| --- | --- |
| Deployment pertama, belum ada Admin | Admin dibuat dari `ADMIN_EMAIL` + `ADMIN_PASSWORD` |
| Redeploy, Admin sudah ada | **Tidak** membuat Admin baru, **tidak** menimpa password |
| `ADMIN_PASSWORD` diubah di Cloudflare setelah bootstrap | **Diabaikan** — password dikelola di dalam aplikasi |
| Secret belum diisi | Status `NOT_CONFIGURED`, login ditolak dengan pesan aman |

Konsekuensi penting: setelah bootstrap, **Cloudflare bukan lagi tempat
mengelola kredensial**. Password diubah dari dalam Property System.

---

## 6. Preview vs Production (§30)

- Environment **Preview** harus memakai secret dan database **terpisah**.
- Jangan pernah menyalin `ADMIN_PASSWORD` produksi ke Preview.
- Jika Preview tidak diberi `ADMIN_EMAIL`/`ADMIN_PASSWORD`, sistem akan berada di
  status `NOT_CONFIGURED` — ini aman dan memang disengaja.

## 7. Development lokal (§32)

Gunakan `.dev.vars` (sudah ada di `.gitignore`, jangan pernah di-commit):

```
JWT_SECRET=<random panjang khusus lokal>
JWT_TTL_SECONDS=43200
ADMIN_EMAIL=admin@property-system.local
ADMIN_PASSWORD=<kredensial khusus lokal, min. 12 karakter>
```

```bash
npm run build
npm run db:migrate:local
pm2 start ecosystem.config.cjs
```

Kredensial produksi **tidak boleh** masuk ke `.dev.vars`, dokumentasi,
test fixture, `seed.sql`, atau GitHub.

---

## 8. Troubleshooting

| Gejala | Penyebab | Tindakan |
| --- | --- | --- |
| `Bootstrap: NOT CONFIGURED` | `ADMIN_EMAIL`/`ADMIN_PASSWORD` belum diisi di Production | Isi lalu **redeploy** |
| `ADMIN_PASSWORD must be at least 12 characters` | Secret terlalu pendek | Ganti dengan yang lebih panjang, redeploy |
| `Authentication: DEGRADED` | `JWT_SECRET` belum diisi | Isi `JWT_SECRET`, redeploy |
| `Database: UNAVAILABLE` | Binding D1 salah / migrasi belum jalan | Cek `wrangler.jsonc`, jalankan `npm run db:migrate:prod` |
| Login gagal walau secret benar | Deployment lama masih aktif | Jalankan deployment baru |
| Lupa password Admin | Bukan lagi ranah Cloudflare | Gunakan Admin lain → **Reset Access**, atau reset kredensial via prosedur DB terkontrol |

---

## 9. Checklist rilis

- [ ] `ADMIN_EMAIL` terpasang sebagai secret Production
- [ ] `ADMIN_PASSWORD` terpasang sebagai secret Production (≥ 12 karakter)
- [ ] `JWT_SECRET` terpasang sebagai secret Production
- [ ] `npm run db:migrate:prod` sukses (8 migrasi)
- [ ] Deployment production sukses
- [ ] `/api/v1/system/public-status` → `bootstrap: COMPLETE`
- [ ] Login Admin berhasil
- [ ] Password bootstrap sudah dirotasi dari dalam aplikasi
- [ ] User OWNER/OPERATOR/MARKETING/ANALYST dibuat dari Settings → Users
- [ ] Redeploy tidak menduplikasi Admin dan tidak mereset password
- [ ] Tidak ada secret di Git, README, log, atau response API
