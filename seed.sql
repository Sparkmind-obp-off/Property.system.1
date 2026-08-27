-- =====================================================================
-- Development seed data (§44 TEST DATA)
-- Traceability: PS-MASTER-001 §44 | PS-IMP-011 §36
--
-- Contents: 5 users (one per role), 5 properties, 5 tenants, segments,
--           offers, campaign, 10 leads, 3 visits, 2 negotiations, 1 rental.
--
-- NEVER use production data as fixtures (§44). Passwords are dev-only.
--   owner@propertysystem.local     / Owner#2026
--   operator@propertysystem.local  / Operator#2026
--   marketing@propertysystem.local / Marketing#2026
--   analyst@propertysystem.local   / Analyst#2026
--   admin@propertysystem.local     / Admin#2026
-- =====================================================================

/* ------------------------------- Identity ------------------------------- */

INSERT OR IGNORE INTO roles (id, name, description) VALUES
  ('rol_owner',     'OWNER',     'Property owner — oversight and rental authority'),
  ('rol_operator',  'OPERATOR',  'Daily operations across properties, leads and rentals'),
  ('rol_marketing', 'MARKETING', 'Offers, campaigns and lead acquisition'),
  ('rol_analyst',   'ANALYST',   'Market intelligence and performance analysis'),
  ('rol_admin',     'ADMIN',     'System administration and governance');

INSERT OR IGNORE INTO users (id, name, email, password_hash, status) VALUES
  ('usr_owner',     'Budi Santoso',  'owner@propertysystem.local',
   'pbkdf2$100000$zb7b3BmDJSbP5YGuTQIw3Q$T6cGQJzKGeUrdDdwAO_OPxXb-STMSBLHW7-ODLwCEx8', 'ACTIVE'),
  ('usr_operator',  'Siti Rahayu',   'operator@propertysystem.local',
   'pbkdf2$100000$8usMiOt1-jAK6pS_bwbiag$bOpOjSQ4xtR6xR9MWnoGyovH1JmqUjtFslsZjJoKq9s', 'ACTIVE'),
  ('usr_marketing', 'Agus Pratama',  'marketing@propertysystem.local',
   'pbkdf2$100000$X4gsPwgFMIzG4YTimFwoyg$zaD69EtFOuwNJBUCiOU7QaKRaG04phIiamcLSLRFga8', 'ACTIVE'),
  ('usr_analyst',   'Dewi Lestari',  'analyst@propertysystem.local',
   'pbkdf2$100000$C82OBifcq2N_1rXubgQurQ$QqxWMBJ0pSsK7q2GyzoIJYpudqPSpAo3OI-EWs-Lb14', 'ACTIVE'),
  ('usr_admin',     'System Admin',  'admin@propertysystem.local',
   'pbkdf2$100000$y-TIEn2vZ4bs0BYCvWk9_w$U_6OJIuaenRcbM3iR7l4WMfK583fN7ryGzB54HjueZI', 'ACTIVE');

INSERT OR IGNORE INTO user_roles (id, user_id, role_id) VALUES
  ('url_1', 'usr_owner',     'rol_owner'),
  ('url_2', 'usr_operator',  'rol_operator'),
  ('url_3', 'usr_marketing', 'rol_marketing'),
  ('url_4', 'usr_analyst',   'rol_analyst'),
  ('url_5', 'usr_admin',     'rol_admin');

/* ------------------------------ Market area ----------------------------- */

INSERT OR IGNORE INTO market_areas (id, name, description, latitude, longitude, radius, market_notes) VALUES
  ('mkt_kotalama', 'Kota Lama Commercial Strip',
   'Dense mixed-use corridor with daily foot traffic from a traditional market and two schools.',
   -6.9210, 107.6100, 1.2,
   'High demand for small food and service businesses. Parking is the main constraint.'),
  ('mkt_perumahan', 'Griya Asri Residential Cluster',
   'Residential cluster of ~900 households with limited local retail supply.',
   -6.9450, 107.6320, 0.9,
   'Underserved for laundry, barber and convenience retail. Low competition.');

/* --------------------- Nearby businesses (competition) ------------------- */
-- Market intelligence must be able to answer "who already operates here?"
-- (§21). Without these rows the competition signal is structurally blind.

INSERT OR IGNORE INTO businesses
  (id, market_area_id, name, business_type, category, address,
   distance_from_property, source, notes) VALUES
  ('biz_kl_warteg',  'mkt_kotalama',  'Warteg Bu Imas',        'Warung makan harian',  'FOOD',
   'Jl. Kota Lama No. 4, Bandung',      60, 'FIELD_SURVEY',
   'Ramai jam makan siang. Menandakan permintaan kuliner harian yang stabil.'),
  ('biz_kl_kopi',    'mkt_kotalama',  'Kopi Sudut Pasar',      'Kedai kopi',           'FOOD',
   'Jl. Kota Lama No. 21, Bandung',    140, 'FIELD_SURVEY',
   'Segmen anak muda pada sore hari; kompetitor langsung untuk kuliner ringan.'),
  ('biz_kl_sembako', 'mkt_kotalama',  'Toko Sembako Berkah',   'Toko sembako',         'GROCERY',
   'Jl. Kota Lama No. 8, Bandung',      90, 'FIELD_SURVEY',
   'Pemasok kebutuhan pedagang sekitar; memperkuat ekosistem usaha kecil.'),
  ('biz_kl_barber',  'mkt_kotalama',  'Barbershop Gaya Kota',  'Barbershop',           'BARBER',
   'Jl. Kota Lama No. 30, Bandung',    260, 'FIELD_SURVEY',
   'Satu-satunya barbershop di koridor ini; kapasitas belum jenuh.'),
  ('biz_kl_bengkel', 'mkt_kotalama',  'Bengkel Motor Rahmat',  'Bengkel motor',        'WORKSHOP',
   'Jl. Kota Lama No. 44, Bandung',    380, 'FIELD_SURVEY',
   'Menarik traffic kendaraan; positif untuk usaha yang butuh visibilitas jalan.'),
  ('biz_ga_minimart','mkt_perumahan', 'Minimart Griya Asri',   'Minimarket',           'RETAIL',
   'Griya Asri Boulevard No. 10, Bandung', 120, 'FIELD_SURVEY',
   'Satu-satunya retail modern di cluster; suplai layanan lain masih kosong.'),
  ('biz_ga_laundry', 'mkt_perumahan', 'Laundry Cepat Asri',    'Laundry kiloan',       'LAUNDRY',
   'Griya Asri Blok C No. 3, Bandung',  540, 'FIELD_SURVEY',
   'Kapasitas terbatas dan sering penuh; indikasi permintaan laundry belum terlayani.'),
  ('biz_ga_katering','mkt_perumahan', 'Katering Dapur Ibu',    'Katering rumahan',     'FOOD',
   'Griya Asri Blok B No. 12, Bandung', 610, 'FIELD_SURVEY',
   'Beroperasi dari rumah tanpa gerai; kandidat penyewa ruang usaha.');

/* ------------------------------- Properties ----------------------------- */

INSERT OR IGNORE INTO properties
  (id, owner_id, market_area_id, name, property_type, address, latitude, longitude,
   width, length, area_size, price, price_period, availability_status, lifecycle_status, description)
VALUES
  ('prp_ruko_3x6', 'usr_owner', 'mkt_kotalama', 'Ruko 3x6 Kota Lama', 'SHOPHOUSE',
   'Jl. Kota Lama No. 12, Bandung', -6.9212, 107.6104, 3, 6, 18,
   2500000, 'MONTH', 'AVAILABLE', 'MARKETED',
   'Two-floor shophouse directly on the main strip. Ready for food or service business.'),

  ('prp_kios_2x3', 'usr_owner', 'mkt_kotalama', 'Kios 2x3 Depan Pasar', 'KIOSK',
   'Jl. Pasar Baru No. 4, Bandung', -6.9205, 107.6090, 2, 3, 6,
   900000, 'MONTH', 'AVAILABLE', 'MARKETED',
   'Compact kiosk with very high foot traffic. Ideal for takeaway food or phone accessories.'),

  ('prp_kontrakan_a', 'usr_owner', 'mkt_perumahan', 'Kontrakan Griya Asri Blok A', 'HOUSE',
   'Griya Asri Blok A No. 7, Bandung', -6.9452, 107.6325, 6, 8, 48,
   1800000, 'MONTH', 'AVAILABLE', 'ACTIVE',
   'Two-bedroom rental house inside a residential cluster. Suitable for a small family.'),

  ('prp_ruang_usaha', 'usr_owner', 'mkt_perumahan', 'Ruang Usaha Griya Asri', 'COMMERCIAL_SPACE',
   'Griya Asri Boulevard No. 2, Bandung', -6.9448, 107.6318, 4, 9, 36,
   3200000, 'MONTH', 'AVAILABLE', 'VERIFIED',
   'Corner commercial unit facing the cluster entrance. Strong visibility, needs signage.'),

  ('prp_gudang_kecil', 'usr_owner', 'mkt_kotalama', 'Gudang Kecil Kota Lama', 'WAREHOUSE',
   'Jl. Industri Kecil No. 21, Bandung', -6.9230, 107.6120, 8, 12, 96,
   4500000, 'MONTH', 'UNAVAILABLE', 'DRAFT',
   'Small storage unit with truck access. Still being verified.');

INSERT OR IGNORE INTO property_analyses
  (id, property_id, access_score, visibility_score, location_score, space_score, overall_score,
   strengths, weaknesses, opportunities, risks, recommended_uses, analysis_status, created_by)
VALUES
  ('ana_ruko_3x6', 'prp_ruko_3x6', 8, 9, 9, 7, 84,
   '["On the main commercial strip","Very high pedestrian traffic","Two usable floors"]',
   '["Limited parking","Narrow frontage at 3m"]',
   '["Food business with takeaway window","Service business with waiting area"]',
   '["Signage strategy required to stand out","Competing food stalls within 100m"]',
   '["FOOD_BUSINESS","SERVICE_BUSINESS","RETAIL"]',
   'COMPLETED', 'usr_analyst'),
  ('ana_ruang_usaha', 'prp_ruang_usaha', 7, 8, 6, 8, 78,
   '["Corner unit","Low local competition","Serves 900 households"]',
   '["Lower through-traffic than the market strip"]',
   '["Laundry","Barber","Convenience retail"]',
   '["Depends on cluster residents only"]',
   '["LAUNDRY","BARBER","RETAIL"]',
   'COMPLETED', 'usr_analyst');

/* --------------------------- Tenant segments ---------------------------- */

INSERT OR IGNORE INTO tenant_segments
  (id, name, description, business_category, minimum_space, maximum_space, budget_min, budget_max, requirements, status)
VALUES
  ('seg_food_umkm', 'UMKM Kuliner Kecil',
   'Small food businesses needing high foot traffic and a compact footprint.',
   'FOOD_BUSINESS', 6, 30, 800000, 3000000,
   '["High foot traffic","Water and electricity","Frontage for a display counter"]', 'ACTIVE'),
  ('seg_laundry', 'Laundry Kiloan',
   'Neighbourhood laundry services serving residential clusters.',
   'LAUNDRY', 20, 60, 1500000, 3500000,
   '["Water supply","Drying area","Residential catchment"]', 'ACTIVE'),
  ('seg_barber', 'Barbershop',
   'Barbershops serving residential clusters and local workers.',
   'BARBER', 12, 40, 1200000, 3000000,
   '["Visible frontage","Waiting area","Stable electricity"]', 'ACTIVE');

/* -------------------------------- Tenants ------------------------------- */

INSERT OR IGNORE INTO tenants
  (id, name, tenant_type, business_category, contact_name, phone, email,
   budget_min, budget_max, space_need, location_preference, business_description, status)
VALUES
  ('tnt_warung_bu_ani', 'Warung Bu Ani', 'BUSINESS', 'FOOD_BUSINESS', 'Ani Suryani',
   '081200000001', 'ani@example.local', 1500000, 2800000, 18, 'Kota Lama',
   'Rice and side-dish warung serving market workers from 6am.', 'PROSPECT'),

  ('tnt_laundry_bersih', 'Laundry Bersih Wangi', 'BUSINESS', 'LAUNDRY', 'Rudi Hartono',
   '081200000002', 'rudi@example.local', 2000000, 3400000, 36, 'Griya Asri',
   'Per-kilo laundry service expanding to a second outlet.', 'PROSPECT'),

  ('tnt_barber_gaya', 'Barbershop Gaya', 'BUSINESS', 'BARBER', 'Fajar Nugroho',
   '081200000003', 'fajar@example.local', 1200000, 2600000, 20, 'Griya Asri',
   'Two-chair barbershop targeting cluster residents.', 'PROSPECT'),

  ('tnt_kopi_seduh', 'Kopi Seduh Kecil', 'BUSINESS', 'FOOD_BUSINESS', 'Maya Puspita',
   '081200000004', 'maya@example.local', 700000, 1200000, 6, 'Kota Lama',
   'Takeaway coffee counter, no seating required.', 'PROSPECT'),

  ('tnt_keluarga_wijaya', 'Keluarga Wijaya', 'INDIVIDUAL', 'OTHER', 'Andi Wijaya',
   '081200000005', 'andi@example.local', 1500000, 2000000, 48, 'Griya Asri',
   'Family of four looking for a two-bedroom rental house.', 'PROSPECT');

/* --------------------------- Offers & campaign --------------------------- */

INSERT OR IGNORE INTO offers
  (id, property_id, tenant_segment_id, title, description, value_proposition, price, terms, cta, status, published_at, created_by)
VALUES
  ('ofr_ruko_food', 'prp_ruko_3x6', 'seg_food_umkm',
   'Ruko Strategis Depan Pasar — Siap Usaha Kuliner',
   'Ruko 3x6 dua lantai di jalur utama Kota Lama, cocok untuk usaha kuliner.',
   'Traffic tinggi sepanjang hari + lantai dua untuk dapur atau stok.',
   2500000, 'Minimum 12 bulan. Deposit 1 bulan.', 'Tanya Sekarang', 'ACTIVE',
   datetime('now', '-14 days'), 'usr_marketing'),

  ('ofr_ruang_laundry', 'prp_ruang_usaha', 'seg_laundry',
   'Ruang Usaha Sudut — Ideal Laundry Kiloan',
   'Unit sudut 4x9 di gerbang cluster dengan 900 KK di sekitarnya.',
   'Kompetisi rendah, permintaan harian stabil dari penghuni cluster.',
   3200000, 'Minimum 12 bulan. Deposit 1 bulan.', 'Jadwalkan Survei', 'ACTIVE',
   datetime('now', '-7 days'), 'usr_marketing'),

  ('ofr_kios_kopi', 'prp_kios_2x3', 'seg_food_umkm',
   'Kios 2x3 Depan Pasar — Cocok Kopi & Takeaway',
   'Kios kecil dengan traffic pejalan sangat tinggi.',
   'Biaya sewa rendah dengan eksposur maksimum.',
   900000, 'Minimum 6 bulan.', 'Tanya Sekarang', 'READY',
   NULL, 'usr_marketing');

INSERT OR IGNORE INTO campaigns
  (id, offer_id, name, channel, objective, status, start_at, end_at, budget, created_by)
VALUES
  ('cmp_wa_kotalama', 'ofr_ruko_food', 'WhatsApp Outreach — UMKM Kuliner Kota Lama',
   'WHATSAPP', 'Generate 10 qualified food-business leads', 'RUNNING',
   datetime('now', '-14 days'), datetime('now', '+16 days'), 500000, 'usr_marketing');

/* --------------------------------- Leads -------------------------------- */

INSERT OR IGNORE INTO leads
  (id, property_id, tenant_id, offer_id, campaign_id, source, status, score, temperature,
   assigned_to, first_contact_at, last_contact_at, lost_reason)
VALUES
  ('led_ani_ruko',      'prp_ruko_3x6',     'tnt_warung_bu_ani',    'ofr_ruko_food',     'cmp_wa_kotalama', 'CAMPAIGN', 'NEGOTIATION',     82, 'HOT',  'usr_operator', datetime('now','-12 days'), datetime('now','-2 days'), NULL),
  ('led_laundry_ruang', 'prp_ruang_usaha',  'tnt_laundry_bersih',   'ofr_ruang_laundry', NULL,              'INBOUND',  'VISITED',         74, 'HOT',  'usr_operator', datetime('now','-9 days'),  datetime('now','-3 days'), NULL),
  ('led_barber_ruang',  'prp_ruang_usaha',  'tnt_barber_gaya',      'ofr_ruang_laundry', NULL,              'ORGANIC',  'QUALIFIED',       61, 'WARM', 'usr_operator', datetime('now','-8 days'),  datetime('now','-4 days'), NULL),
  ('led_kopi_kios',     'prp_kios_2x3',     'tnt_kopi_seduh',       'ofr_kios_kopi',     NULL,              'INBOUND',  'VISIT_SCHEDULED', 66, 'WARM', 'usr_operator', datetime('now','-6 days'),  datetime('now','-1 days'), NULL),
  ('led_wijaya_rumah',  'prp_kontrakan_a',  'tnt_keluarga_wijaya',  NULL,                NULL,              'REFERRAL', 'RESPONDED',       48, 'COOL', 'usr_operator', datetime('now','-5 days'),  datetime('now','-2 days'), NULL),
  ('led_ani_kios',      'prp_kios_2x3',     'tnt_warung_bu_ani',    'ofr_kios_kopi',     'cmp_wa_kotalama', 'CAMPAIGN', 'CONTACTED',       35, 'COOL', 'usr_operator', datetime('now','-4 days'),  datetime('now','-4 days'), NULL),
  ('led_kopi_ruko',     'prp_ruko_3x6',     'tnt_kopi_seduh',       'ofr_ruko_food',     'cmp_wa_kotalama', 'CAMPAIGN', 'NEW',             12, 'LOW',  'usr_operator', NULL,                       NULL,                      NULL),
  ('led_barber_kios',   'prp_kios_2x3',     'tnt_barber_gaya',      'ofr_kios_kopi',     NULL,              'OUTBOUND', 'NEW',             10, 'LOW',  'usr_marketing', NULL,                      NULL,                      NULL),
  ('led_laundry_ruko',  'prp_ruko_3x6',     'tnt_laundry_bersih',   'ofr_ruko_food',     NULL,              'OUTBOUND', 'LOST',             0, 'LOW',  'usr_operator', datetime('now','-11 days'), datetime('now','-10 days'),
   'Butuh area jemur yang tidak tersedia di lokasi ini.'),
  ('led_wijaya_ruang',  'prp_ruang_usaha',  'tnt_keluarga_wijaya',  NULL,                NULL,              'OTHER',    'LOST',             0, 'LOW',  'usr_operator', datetime('now','-7 days'),  datetime('now','-6 days'),
   'Mencari hunian, bukan ruang usaha.');

INSERT OR IGNORE INTO lead_qualifications
  (id, lead_id, business_type, budget, timeline, space_need, location_need, intended_use,
   decision_status, fit_score, qualification_result, reasoning, notes, qualified_by)
VALUES
  ('qlf_ani', 'led_ani_ruko', 'FOOD_BUSINESS', 2600000, 'IMMEDIATE', 18, 'HIGH',
   'Warung makan pagi sampai sore', 'DECISION_MAKER', 86, 'QUALIFIED',
   '["Budget covers the asking price","Space requirement matches 18 m2","Business category matches recommended uses","Timeline is immediate"]',
   'Sudah menyewa di lokasi lain, siap pindah bulan depan.', 'usr_operator'),

  ('qlf_laundry', 'led_laundry_ruang', 'LAUNDRY', 3300000, 'WITHIN_30_DAYS', 36, 'MEDIUM',
   'Laundry kiloan cabang kedua', 'DECISION_MAKER', 79, 'QUALIFIED',
   '["Budget covers the asking price","Space requirement matches 36 m2","Residential catchment supports laundry demand"]',
   'Perlu memastikan kapasitas air dan area jemur.', 'usr_operator'),

  ('qlf_barber', 'led_barber_ruang', 'BARBER', 2400000, 'WITHIN_90_DAYS', 20, 'MEDIUM',
   'Barbershop dua kursi', 'INFLUENCER', 58, 'PARTIALLY_QUALIFIED',
   '["Business category is suitable for the area","Budget is below the asking price","Decision maker is not the contact"]',
   'Butuh diskusi dengan partner sebelum komitmen.', 'usr_operator');

/* --------------------- Matching, activities, follow-ups ------------------ */

INSERT OR IGNORE INTO tenant_property_matches
  (id, property_id, tenant_id, tenant_segment_id, fit_score, location_score, demand_score,
   space_score, price_score, business_score, competition_score, operational_score,
   recommendation, reasoning, risks, mismatches)
VALUES
  ('mtc_ani_ruko', 'prp_ruko_3x6', 'tnt_warung_bu_ani', NULL, 84, 9, 9, 10, 8, 10, 5, 8,
   'HIGH_FIT',
   '["Budget compatible","Space compatible","Business category compatible","Area activity compatible"]',
   '["Visibility may require signage strategy","Parking is limited"]',
   '[]'),
  ('mtc_laundry_ruang', 'prp_ruang_usaha', 'tnt_laundry_bersih', NULL, 78, 8, 8, 9, 7, 9, 3, 7,
   'HIGH_FIT',
   '["Budget compatible","Space compatible","Low local competition"]',
   '["Water capacity must be verified"]',
   '[]');

INSERT OR IGNORE INTO activities (id, lead_id, user_id, activity_type, subject, description, occurred_at, metadata) VALUES
  ('act_ani_1', 'led_ani_ruko', 'usr_operator', 'MESSAGE', 'WhatsApp perkenalan penawaran ruko', 'Mengirim detail ruko dan harga.', datetime('now','-12 days'), '{}'),
  ('act_ani_2', 'led_ani_ruko', 'usr_operator', 'CALL',    'Telepon konfirmasi minat',           'Tenant menyatakan minat kuat.',   datetime('now','-11 days'), '{}'),
  ('act_ani_3', 'led_ani_ruko', 'usr_operator', 'VISIT',   'Survei lokasi selesai',              'Hasil: STRONG_FIT.',              datetime('now','-5 days'),  '{}'),
  ('act_laundry_1', 'led_laundry_ruang', 'usr_operator', 'MESSAGE', 'Balasan pertanyaan air dan listrik', NULL, datetime('now','-8 days'), '{}'),
  ('act_laundry_2', 'led_laundry_ruang', 'usr_operator', 'VISIT',   'Survei lokasi selesai', 'Hasil: POTENTIAL.', datetime('now','-3 days'), '{}');

INSERT OR IGNORE INTO follow_ups (id, lead_id, assigned_to, action_type, due_at, status, notes, created_by) VALUES
  ('fup_overdue_barber', 'led_barber_ruang',  'usr_operator', 'CALL',           datetime('now','-2 days'), 'PENDING', 'Tanya hasil diskusi dengan partner.', 'usr_operator'),
  ('fup_today_kopi',     'led_kopi_kios',     'usr_operator', 'VISIT_REMINDER', datetime('now'),           'PENDING', 'Ingatkan survei besok pagi.',         'usr_operator'),
  ('fup_upcoming_wijaya','led_wijaya_rumah',  'usr_operator', 'MESSAGE',        datetime('now','+3 days'), 'PENDING', 'Kirim foto interior kontrakan.',      'usr_operator'),
  ('fup_done_ani',       'led_ani_ruko',      'usr_operator', 'CALL',           datetime('now','-6 days'), 'COMPLETED','Konfirmasi jadwal survei.',          'usr_operator');

/* -------------------------------- Visits -------------------------------- */

INSERT OR IGNORE INTO visits (id, property_id, lead_id, scheduled_by, scheduled_at, status, result, notes, completed_at) VALUES
  ('vst_ani_ruko',      'prp_ruko_3x6',    'led_ani_ruko',      'usr_operator', datetime('now','-5 days'), 'COMPLETED', 'STRONG_FIT', 'Sangat cocok, langsung menawar harga.', datetime('now','-5 days')),
  ('vst_laundry_ruang', 'prp_ruang_usaha', 'led_laundry_ruang', 'usr_operator', datetime('now','-3 days'), 'COMPLETED', 'POTENTIAL',  'Perlu cek kapasitas air.',              datetime('now','-3 days')),
  ('vst_kopi_kios',     'prp_kios_2x3',    'led_kopi_kios',     'usr_operator', datetime('now','+1 days'), 'SCHEDULED', NULL,         'Survei pagi sebelum pasar ramai.',      NULL);

/* ----------------------------- Negotiations ----------------------------- */

INSERT OR IGNORE INTO negotiations
  (id, property_id, lead_id, visit_id, created_by, current_price, proposed_price, agreed_price,
   terms, status, started_at, agreed_at, closed_at, notes)
VALUES
  ('ngt_ani_ruko', 'prp_ruko_3x6', 'led_ani_ruko', 'vst_ani_ruko', 'usr_operator',
   2500000, 2200000, 2350000,
   'Sewa 12 bulan, deposit 1 bulan, pembayaran per bulan.', 'AGREED',
   datetime('now','-4 days'), datetime('now','-2 days'), datetime('now','-2 days'),
   'Sepakat di tengah setelah dua putaran.'),

  ('ngt_laundry_ruang', 'prp_ruang_usaha', 'led_laundry_ruang', 'vst_laundry_ruang', 'usr_operator',
   3200000, 2900000, NULL,
   'Sewa 12 bulan, minta gratis satu bulan pertama.', 'COUNTER_OFFER',
   datetime('now','-2 days'), NULL, NULL,
   'Menunggu jawaban tenant atas penawaran balik.');

INSERT OR IGNORE INTO negotiation_rounds (id, negotiation_id, actor, round_type, price, terms, notes, created_by, created_at) VALUES
  ('nrd_ani_1', 'ngt_ani_ruko', 'TENANT', 'PROPOSAL',      2200000, NULL, 'Penawaran awal tenant.',   'usr_operator', datetime('now','-4 days')),
  ('nrd_ani_2', 'ngt_ani_ruko', 'OWNER',  'COUNTER_OFFER', 2400000, NULL, 'Penawaran balik pemilik.', 'usr_operator', datetime('now','-3 days')),
  ('nrd_ani_3', 'ngt_ani_ruko', 'OWNER',  'ACCEPT',        2350000, 'Sewa 12 bulan, deposit 1 bulan.', 'Disepakati.', 'usr_operator', datetime('now','-2 days')),
  ('nrd_lau_1', 'ngt_laundry_ruang', 'TENANT', 'PROPOSAL',      2900000, NULL, 'Minta potongan harga.',    'usr_operator', datetime('now','-2 days')),
  ('nrd_lau_2', 'ngt_laundry_ruang', 'OWNER',  'COUNTER_OFFER', 3050000, NULL, 'Penawaran balik pemilik.', 'usr_operator', datetime('now','-1 days'));

/* -------------------------------- Rental -------------------------------- */
-- One rental in DRAFT so the golden E2E flow can activate it (§42).
-- It intentionally stays DRAFT: activation is an explicit domain operation and
-- must never be seeded as ACTIVE (that would bypass §17 validation).

INSERT OR IGNORE INTO rentals
  (id, property_id, tenant_id, lead_id, negotiation_id, start_date, end_date,
   price, payment_period, deposit, terms, status, created_by)
VALUES
  ('rnt_ani_ruko', 'prp_ruko_3x6', 'tnt_warung_bu_ani', 'led_ani_ruko', 'ngt_ani_ruko',
   date('now', '+7 days'), date('now', '+372 days'),
   2350000, 'MONTH', 2350000,
   'Sewa 12 bulan, deposit 1 bulan, pembayaran per bulan di muka.', 'DRAFT', 'usr_operator');
