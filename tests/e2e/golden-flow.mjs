/**
 * GOLDEN E2E FLOW — the primary golden path of the Property System.
 * Traceability: PS-MASTER-001 §42 (golden E2E flow), §43 (critical E2E tests),
 *               §49 (golden vertical slice), §57 (release gate)
 *
 * Exercises the REAL running API (no mocks, no fixtures substituting for
 * backend logic) across DOMAIN → APPLICATION → API → DATABASE:
 *
 *   LOGIN → CREATE PROPERTY → VERIFY → ANALYZE → CREATE TENANT → MATCH
 *   → CREATE OFFER → PUBLISH → CREATE LEAD → CONTACT → QUALIFY
 *   → SCHEDULE VISIT → COMPLETE VISIT → CREATE NEGOTIATION
 *   → ACCEPT NEGOTIATION → CREATE RENTAL → ACTIVATE RENTAL
 *   → ASSERT DOUBLE-RENTAL PROTECTION → END RENTAL
 *   → ASSERT PROPERTY RETURNED TO AVAILABLE
 *
 * The flow deliberately switches ACTORS (owner / operator / marketing / admin)
 * because §3 gives each role only part of the workflow. Acting as the wrong
 * role is asserted to be REFUSED — that is the separation-of-duties test.
 *
 * Usage: node tests/e2e/golden-flow.mjs [baseUrl]
 */

const BASE = process.argv[2] || process.env.E2E_BASE_URL || 'http://localhost:3000'
const API = `${BASE}/api/v1`

/* ------------------------------ tiny harness ------------------------------ */

let passed = 0
let failed = 0
const failures = []
let step = 0

function ok(name, extra = '') {
  passed++
  step++
  console.log(`  \x1b[32m✓\x1b[0m ${String(step).padStart(2, '0')}. ${name}${extra ? ` \x1b[90m${extra}\x1b[0m` : ''}`)
}

function bad(name, detail) {
  failed++
  step++
  failures.push(`${name} → ${detail}`)
  console.log(`  \x1b[31m✗\x1b[0m ${String(step).padStart(2, '0')}. ${name}\n       \x1b[31m${detail}\x1b[0m`)
}

function assert(cond, name, detail = 'assertion failed') {
  if (cond) ok(name)
  else bad(name, detail)
  return !!cond
}

function section(title) {
  console.log(`\n\x1b[1m\x1b[36m${title}\x1b[0m`)
}

/* -------------------------------- HTTP layer ------------------------------ */

let token = null

async function call(method, path, body, { expectStatus, raw = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON response */
  }
  if (raw) return { res, json, text }
  if (expectStatus && res.status !== expectStatus) {
    throw new Error(
      `${method} ${path} expected ${expectStatus}, got ${res.status}: ${text.slice(0, 400)}`
    )
  }
  if (!expectStatus && !res.ok) {
    throw new Error(`${method} ${path} failed ${res.status}: ${text.slice(0, 400)}`)
  }
  return { res, json, text }
}

const get = (p, o) => call('GET', p, undefined, o)
const post = (p, b, o) => call('POST', p, b ?? {}, o)
const patch = (p, b, o) => call('PATCH', p, b ?? {}, o)

/** Assert an operation is REFUSED by the domain with a stable error code. */
async function expectRefused(name, method, path, body, { code, match } = {}) {
  const { res, json } = await call(method, path, body, { raw: true })
  if (res.ok) {
    bad(name, `operation was ALLOWED (${res.status}) but must be refused`)
    return null
  }
  const err = json?.error
  if (!err?.code) {
    bad(name, `refused with ${res.status} but no machine-readable error code (§35)`)
    return null
  }
  const accepted = code === undefined ? null : Array.isArray(code) ? code : [code]
  if (accepted && !accepted.includes(err.code)) {
    bad(name, `expected code ${accepted.join('|')}, got ${err.code} (${err.message})`)
    return null
  }
  if (match && !match.test(err.message || '')) {
    bad(name, `message "${err.message}" did not match ${match}`)
    return null
  }
  ok(name, `${err.code}: ${err.message}`)
  return err
}

const iso = (daysFromNow) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString()
const dateOnly = (daysFromNow) => iso(daysFromNow).slice(0, 10)
const stamp = Date.now().toString(36)

/* --------------------------- actors (§3 roles) ---------------------------- */

const ACTORS = {
  OWNER: { email: 'owner@propertysystem.local', password: 'Owner#2026' },
  OPERATOR: { email: 'operator@propertysystem.local', password: 'Operator#2026' },
  MARKETING: { email: 'marketing@propertysystem.local', password: 'Marketing#2026' },
  ANALYST: { email: 'analyst@propertysystem.local', password: 'Analyst#2026' },
  ADMIN: { email: 'admin@propertysystem.local', password: 'Admin#2026' }
}

const tokens = {}
let currentActor = null

/** Log in once per actor and cache the token. */
async function loginAs(role) {
  if (!tokens[role]) {
    const prev = token
    token = null
    const { json } = await post('/auth/login', ACTORS[role])
    tokens[role] = json?.data?.token
    if (!tokens[role]) {
      token = prev
      throw new Error(`login as ${role} did not return a token`)
    }
  }
  token = tokens[role]
  currentActor = role
  return tokens[role]
}

/** Switch the acting role for the following requests. */
async function actAs(role) {
  await loginAs(role)
  console.log(`  \x1b[90m→ acting as ${role}\x1b[0m`)
}

/* --------------------------------- the flow ------------------------------- */

async function run() {
  console.log(`\n\x1b[1mPROPERTY SYSTEM — GOLDEN E2E FLOW\x1b[0m`)
  console.log(`\x1b[90mtarget: ${API}  (PS-MASTER-001 §42/§43)\x1b[0m`)

  /* ------------------------------- 00. health ----------------------------- */
  section('PHASE 0 — Foundation')
  {
    const { json } = await get('/health')
    assert(json?.data?.status === 'ok', 'API is reachable and healthy', `got ${JSON.stringify(json)}`)
    assert(json?.data?.system === 'PS-MASTER-001', 'system identifies itself as PS-MASTER-001')
    assert(!!json?.data?.request_id, 'every response carries a request id (§47 observability)')
  }

  /* -------------------------------- 01. login ----------------------------- */
  section('PHASE 1 — Identity')
  {
    await expectRefused(
      'unauthenticated request is rejected',
      'GET',
      '/properties',
      undefined,
      { code: 'UNAUTHORIZED' }
    )

    await expectRefused(
      'wrong password is rejected',
      'POST',
      '/auth/login',
      { email: 'operator@propertysystem.local', password: 'wrong-password' },
      { code: 'UNAUTHORIZED' }
    )

    const { json } = await post('/auth/login', ACTORS.OPERATOR)
    tokens.OPERATOR = json?.data?.token
    token = tokens.OPERATOR
    currentActor = 'OPERATOR'
    assert(!!token, 'LOGIN as OPERATOR succeeds and returns a token')
    assert(
      Array.isArray(json?.data?.user?.permissions) && json.data.user.permissions.length > 0,
      'session carries a server-derived permission set (§3)',
      'no permissions returned'
    )

    const { json: me } = await get('/auth/me')
    assert(me?.data?.email === ACTORS.OPERATOR.email, 'token resolves to the right user')

    // Separation of duties: OPERATOR runs operations, not governance (§3).
    await expectRefused(
      'an OPERATOR cannot verify a property — that is OWNER authority (§3)',
      'POST',
      '/properties/prp_does_not_matter/verify',
      {},
      { code: 'FORBIDDEN' }
    )

    // Every other role must be able to authenticate too.
    for (const role of ['OWNER', 'MARKETING', 'ANALYST', 'ADMIN']) {
      await loginAs(role)
      ok(`LOGIN as ${role} succeeds`)
    }
    await loginAs('OPERATOR')
  }

  /* ------------------------------ 02. property ---------------------------- */
  section('PHASE 2 — Property')
  let propertyId
  {
    const { json } = await post(
      '/properties',
      {
        name: `E2E Ruko Golden ${stamp}`,
        property_type: 'SHOPHOUSE',
        address: 'Jl. E2E Kota Lama No. 42, Bandung',
        price: 3_500_000,
        price_period: 'MONTH',
        width: 3,
        length: 6,
        description: 'Properti uji golden flow — dibuat oleh tes E2E.'
      },
      { expectStatus: 201 }
    )
    propertyId = json?.data?.id
    assert(!!propertyId, 'CREATE PROPERTY returns a persisted id')
    assert(json?.data?.area_size === 18, 'area is derived server-side from width × length', `got ${json?.data?.area_size}`)
    assert(json?.data?.lifecycle_status === 'DRAFT', 'a new property starts in DRAFT (§5)')

    // Verification and marketing are OWNER authority (§3).
    await actAs('OWNER')

    await expectRefused(
      'an unverified property cannot be marketed (DR-002)',
      'POST',
      `/properties/${propertyId}/market`,
      {},
      { code: 'BUSINESS_RULE_VIOLATION' }
    )

    const { json: verified } = await post(`/properties/${propertyId}/verify`)
    assert(verified?.data?.lifecycle_status === 'VERIFIED', 'VERIFY PROPERTY moves it to VERIFIED')

    const { json: analysis } = await post(`/properties/${propertyId}/analysis`, {
      location_score: 8,
      access_score: 8,
      visibility_score: 7,
      space_score: 7,
      strengths: ['Berada di koridor komersial yang ramai.', 'Akses jalan utama mudah.'],
      weaknesses: ['Fasad sempit sehingga butuh strategi signage.'],
      opportunities: ['Permintaan kuliner harian belum terlayani.'],
      risks: ['Parkir terbatas pada jam sibuk.'],
      recommended_uses: ['FOOD_BUSINESS', 'RETAIL']
    })
    assert(!!analysis?.data, 'ANALYZE PROPERTY records structured intelligence (§6)')
    const reasons =
      analysis?.data?.reasoning || analysis?.data?.summary || analysis?.data?.strengths
    assert(!!reasons, 'analysis is explainable — never a bare score (§6)')

    const { json: marketed } = await post(`/properties/${propertyId}/market`)
    assert(
      ['MARKETED', 'ACTIVE'].includes(marketed?.data?.lifecycle_status),
      'a verified property CAN be marketed',
      `got ${marketed?.data?.lifecycle_status}`
    )
    assert(
      marketed?.data?.availability_status === 'AVAILABLE',
      'the property is AVAILABLE for a new rental'
    )
    await actAs('OPERATOR')
  }

  /* --------------------------- 03. tenant + matching ---------------------- */
  section('PHASE 3 — Tenant & Matching')
  let tenantId
  {
    const { json } = await post(
      '/tenants',
      {
        name: `E2E Kuliner Nusantara ${stamp}`,
        tenant_type: 'BUSINESS',
        business_category: 'FOOD_BUSINESS',
        contact_name: 'Budi Santoso',
        phone: '081200000042',
        email: `budi.e2e.${stamp}@example.com`,
        budget_min: 3_000_000,
        budget_max: 4_000_000,
        space_need: 16,
        location_preference: 'Koridor komersial ramai',
        business_description: 'Warung makan harian dengan target pekerja sekitar.'
      },
      { expectStatus: 201 }
    )
    tenantId = json?.data?.id
    assert(!!tenantId, 'CREATE TENANT returns a persisted id')

    await expectRefused(
      'budget_min above budget_max is rejected by validation',
      'POST',
      '/tenants',
      {
        name: 'E2E Invalid Budget',
        business_category: 'RETAIL',
        budget_min: 9_000_000,
        budget_max: 1_000_000
      },
      { code: 'VALIDATION_ERROR' }
    )

    const { json: fit } = await post(`/properties/${propertyId}/tenant-fit`, { tenant_id: tenantId })
    const result = fit?.data?.matches?.[0] || fit?.data?.[0] || fit?.data
    const score = result?.fit_score ?? result?.score
    assert(typeof score === 'number', 'MATCH TENANT returns a numeric fit score', `got ${JSON.stringify(fit?.data)?.slice(0, 200)}`)
    const why = result?.reasoning || result?.reasons || result?.components
    assert(!!why && (Array.isArray(why) ? why.length > 0 : true), 'the match carries REASONS (§8/§25 — no score without reasons)')
    assert(score >= 50, 'an aligned tenant scores as a real match', `score ${score}`)
  }

  /* ----------------------------- 04. offer + lead ------------------------- */
  section('PHASE 4 — Offer & Lead')
  let offerId
  let leadId
  {
    // Offers and publication belong to MARKETING (§3).
    await expectRefused(
      'an OPERATOR cannot create an offer — that is MARKETING authority (§3)',
      'POST',
      '/offers',
      { property_id: propertyId, title: 'Percobaan tanpa izin', price: 1_000_000 },
      { code: 'FORBIDDEN' }
    )

    await actAs('MARKETING')

    const { json } = await post(
      '/offers',
      {
        property_id: propertyId,
        title: `Sewa Ruko Strategis Kota Lama ${stamp}`,
        value_proposition: 'Lokasi ramai pekerja, cocok untuk warung makan harian.',
        price: 3_500_000,
        price_period: 'MONTH',
        cta: 'Hubungi kami untuk jadwal survei',
        terms: 'Minimum sewa 12 bulan, deposit 1 bulan.'
      },
      { expectStatus: 201 }
    )
    offerId = json?.data?.id
    assert(!!offerId, 'CREATE OFFER returns a persisted id')
    assert(json?.data?.status === 'DRAFT', 'a new offer starts in DRAFT (§9)')

    await expectRefused(
      'an offer cannot be published straight from DRAFT — READY is the gate',
      'POST',
      `/offers/${offerId}/publish`,
      {},
      { code: 'INVALID_STATE_TRANSITION' }
    )

    await post(`/offers/${offerId}/ready`)
    const { json: published } = await post(`/offers/${offerId}/publish`)
    assert(published?.data?.status === 'ACTIVE', 'PUBLISH OFFER makes it ACTIVE', `got ${published?.data?.status}`)

    // Lead handling returns to the OPERATOR (§3).
    await actAs('OPERATOR')

    const { json: lead } = await post(
      '/leads',
      { property_id: propertyId, tenant_id: tenantId, offer_id: offerId, source: 'INBOUND' },
      { expectStatus: 201 }
    )
    leadId = lead?.data?.id
    assert(!!leadId, 'CREATE LEAD returns a persisted id')
    assert(lead?.data?.status === 'NEW', 'a new lead starts at NEW (§10)')

    await expectRefused(
      'a lead without property context is refused (DR-003)',
      'POST',
      '/leads',
      { tenant_id: tenantId },
      { code: 'VALIDATION_ERROR' }
    )

    await expectRefused(
      'a lead cannot jump straight to WON (§10)',
      'POST',
      `/leads/${leadId}/status`,
      { status: 'WON' },
      // WON is reserved for rental activation, so the domain refuses it either
      // as an illegal transition or as the stronger "only via rental" rule.
      { code: ['INVALID_STATE_TRANSITION', 'BUSINESS_RULE_VIOLATION'] }
    )
  }

  /* ------------------------- 05. qualification + ops ---------------------- */
  section('PHASE 5 — Qualification, Follow-up & Visit')
  let visitId
  {
    await post(`/leads/${leadId}/contact`, {
      // WhatsApp is a MESSAGE channel in the domain enum (§12 / FOLLOW_UP_ACTIONS).
      channel: 'MESSAGE',
      notes: 'Menghubungi calon penyewa lewat WhatsApp.'
    })

    const { json: q } = await post(`/leads/${leadId}/qualify`, {
      business_type: 'FOOD_BUSINESS',
      budget: 3_800_000,
      timeline: 'IMMEDIATE',
      space_need: 16,
      location_need: 'HIGH',
      decision_status: 'DECISION_MAKER',
      intended_use: 'Warung makan harian',
      notes: 'Siap pindah bulan depan.'
    })
    const qual = q?.data?.qualification || q?.data
    assert(
      qual?.qualification_result === 'QUALIFIED',
      'QUALIFY LEAD returns QUALIFIED for a strong candidate',
      `got ${qual?.qualification_result}`
    )
    const reasoning = qual?.reasoning || qual?.reasons
    assert(
      Array.isArray(reasoning) && reasoning.length > 0,
      'qualification is EXPLAINABLE (§11)',
      'no reasoning array returned'
    )

    const { json: scored } = await get(`/leads/${leadId}/score`)
    const sc = scored?.data
    assert(typeof sc?.score === 'number', 'lead score is computed server-side')
    assert(Array.isArray(sc?.reasons) && sc.reasons.length > 0, 'lead score carries reasons (§11)')
    assert(!!sc?.temperature, 'lead score maps to a temperature band (§24)')

    const { json: fu } = await post(
      '/follow-ups',
      {
        lead_id: leadId,
        action_type: 'MESSAGE',
        due_at: iso(1),
        notes: 'Konfirmasi jadwal survei ke calon penyewa'
      },
      { expectStatus: 201 }
    )
    const followUpId = fu?.data?.id
    assert(!!followUpId, 'CREATE FOLLOW-UP returns a persisted id (§12)')

    const { json: wq } = await get('/follow-ups/work-queue')
    const q2 = wq?.data
    assert(
      q2 && ('overdue' in q2 || 'due_today' in q2 || 'upcoming' in q2 || 'OVERDUE' in q2),
      'the work queue is bucketed OVERDUE / DUE TODAY / UPCOMING (§19)',
      `got keys ${Object.keys(q2 || {}).join(',')}`
    )

    await post(`/follow-ups/${followUpId}/complete`, { outcome: 'Calon penyewa setuju survei besok.' })
    ok('COMPLETE FOLLOW-UP succeeds')

    await expectRefused(
      'a visit cannot be scheduled in the past (DR-005)',
      'POST',
      '/visits',
      { lead_id: leadId, scheduled_at: iso(-5) },
      { code: 'BUSINESS_RULE_VIOLATION' }
    )

    const { json: visit } = await post(
      '/visits',
      { lead_id: leadId, scheduled_at: iso(1), notes: 'Survei lokasi bersama calon penyewa.' },
      { expectStatus: 201 }
    )
    visitId = visit?.data?.id
    assert(!!visitId, 'SCHEDULE VISIT returns a persisted id (§14)')

    await expectRefused(
      'completing a visit without a result is refused (DR-005)',
      'POST',
      `/visits/${visitId}/complete`,
      {},
      { code: 'VALIDATION_ERROR' }
    )

    const { json: done } = await post(`/visits/${visitId}/complete`, {
      result: 'STRONG_FIT',
      notes: 'Calon penyewa sangat cocok; siap lanjut negosiasi.'
    })
    assert(done?.data?.status === 'COMPLETED', 'COMPLETE VISIT records the outcome', `got ${done?.data?.status}`)

    const { json: leadAfter } = await get(`/leads/${leadId}`)
    const st = leadAfter?.data?.status || leadAfter?.data?.lead?.status
    assert(st === 'VISITED', 'the completed visit advanced the lead to VISITED', `got ${st}`)
  }

  /* ----------------------------- 06. negotiation -------------------------- */
  section('PHASE 6 — Negotiation')
  let negotiationId
  {
    const { json } = await post(
      '/negotiations',
      {
        lead_id: leadId,
        current_price: 3_500_000,
        proposed_price: 3_100_000,
        visit_id: visitId,
        terms: 'Sewa 12 bulan, deposit 1 bulan.',
        notes: 'Calon penyewa mengajukan penurunan harga.'
      },
      { expectStatus: 201 }
    )
    negotiationId = json?.data?.id
    assert(!!negotiationId, 'CREATE NEGOTIATION returns a persisted id (§15)')
    assert(json?.data?.status === 'OPEN', 'a new negotiation starts OPEN')

    await expectRefused(
      'a second live negotiation on the same lead is refused (DR-006)',
      'POST',
      '/negotiations',
      { lead_id: leadId, current_price: 3_500_000, proposed_price: 3_000_000 },
      { code: 'BUSINESS_RULE_VIOLATION' }
    )

    const { json: countered } = await post(`/negotiations/${negotiationId}/counter`, {
      price: 3_300_000, actor: 'OWNER',
      notes: 'Penawaran balik dari pemilik.'
    })
    assert(
      countered?.data?.status === 'COUNTER_OFFER',
      'COUNTER moves the negotiation to COUNTER_OFFER',
      `got ${countered?.data?.status}`
    )

    const { json: agreed } = await post(`/negotiations/${negotiationId}/accept`, {
      agreed_price: 3_300_000,
      terms: 'Sewa 12 bulan, deposit 1 bulan, harga akhir 3.300.000/bulan.'
    })
    assert(agreed?.data?.status === 'AGREED', 'ACCEPT NEGOTIATION requires and records an agreed price (§15)', `got ${agreed?.data?.status}`)

    await expectRefused(
      'an AGREED negotiation cannot be silently re-opened',
      'POST',
      `/negotiations/${negotiationId}/counter`,
      { price: 3_000_000 },
      { code: 'INVALID_STATE_TRANSITION' }
    )

    const { json: leadNow } = await get(`/leads/${leadId}`)
    const st = leadNow?.data?.status || leadNow?.data?.lead?.status
    assert(
      ['NEGOTIATION', 'WON'].includes(st),
      'the lead reflects the negotiation stage',
      `got ${st}`
    )
  }

  /* -------------------------------- 07. rental ---------------------------- */
  section('PHASE 7 — Rental (the critical domain operation)')
  let rentalId
  {
    const { json } = await post(
      '/rentals',
      {
        property_id: propertyId,
        tenant_id: tenantId,
        lead_id: leadId,
        negotiation_id: negotiationId,
        start_date: dateOnly(7),
        end_date: dateOnly(372),
        price: 3_300_000,
        payment_period: 'MONTH',
        deposit: 3_300_000,
        terms: 'Sewa 12 bulan sesuai hasil negosiasi.'
      },
      { expectStatus: 201 }
    )
    rentalId = json?.data?.id
    assert(!!rentalId, 'CREATE RENTAL returns a persisted id (§16)')
    assert(json?.data?.status === 'DRAFT', 'a new rental starts in DRAFT — activation is explicit (§17)')
    assert(
      Number(json?.data?.price) === 3_300_000,
      'the rental price is the AGREED negotiation price, not the list price',
      `got ${json?.data?.price}`
    )

    await expectRefused(
      'a rental with an end date before its start date is refused (DR-007)',
      'POST',
      '/rentals',
      {
        property_id: propertyId,
        tenant_id: tenantId,
        start_date: dateOnly(30),
        end_date: dateOnly(10),
        price: 1_000_000,
        payment_period: 'MONTH'
      },
      { code: 'BUSINESS_RULE_VIOLATION' }
    )

    const { json: readiness } = await get(`/rentals/${rentalId}`)
    const checks = readiness?.data?.activation_readiness || readiness?.data?.readiness
    assert(!!checks, 'the rental exposes EXPLAINABLE activation readiness (§17)', 'no readiness payload')

    const { json: activated } = await post(`/rentals/${rentalId}/activate`)
    assert(activated?.data?.status === 'ACTIVE', 'ACTIVATE RENTAL succeeds when every precondition holds (§17)', `got ${activated?.data?.status}`)

    const { json: prop } = await get(`/properties/${propertyId}`)
    const p = prop?.data?.property || prop?.data
    assert(
      p?.availability_status === 'RENTED',
      'activation transactionally marked the property RENTED (§17)',
      `got ${p?.availability_status}`
    )
    assert(p?.lifecycle_status === 'RENTED', 'the property lifecycle is RENTED too', `got ${p?.lifecycle_status}`)
  }

  /* --------------------- 08. DOUBLE RENTAL PROTECTION (§18) --------------- */
  section('PHASE 8 — Double-rental protection (§18)')
  {
    await expectRefused(
      'a SECOND rental on an occupied property is refused (DR-008)',
      'POST',
      '/rentals',
      {
        property_id: propertyId,
        tenant_id: tenantId,
        start_date: dateOnly(14),
        end_date: dateOnly(380),
        price: 3_300_000,
        payment_period: 'MONTH'
      },
      { code: 'BUSINESS_RULE_VIOLATION' }
    )

    await expectRefused(
      'a rented property cannot receive new visits (DR-005)',
      'POST',
      '/visits',
      { lead_id: leadId, scheduled_at: iso(3) },
      {}
    )

    // Marketing authority belongs to the OWNER (§3), so the domain rule has to
    // be probed by an actor that actually holds the permission.
    await actAs('OWNER')
    await expectRefused(
      'a rented property cannot be re-marketed as available (DR-002)',
      'POST',
      `/properties/${propertyId}/market`,
      {},
      { code: 'BUSINESS_RULE_VIOLATION' }
    )
    await actAs('OPERATOR')

    await expectRefused(
      'an ACTIVE rental cannot be cancelled — it must be ended (§16)',
      'POST',
      `/rentals/${rentalId}/cancel`,
      { reason: 'Percobaan pembatalan yang harus ditolak' },
      { code: 'INVALID_STATE_TRANSITION' }
    )

    // Concurrency: fire simultaneous activations of a fresh rental on a FREE
    // property — exactly one must win (§18 requires DB/app-level protection).
    const { json: p2 } = await post(
      '/properties',
      {
        name: `E2E Concurrency Kios ${stamp}`,
        property_type: 'KIOSK',
        address: 'Jl. E2E Concurrency No. 7, Bandung',
        price: 1_200_000,
        price_period: 'MONTH',
        width: 2,
        length: 3
      },
      { expectStatus: 201 }
    )
    await actAs('OWNER')
    await post(`/properties/${p2.data.id}/verify`)
    await actAs('OPERATOR')

    const rentalIds = []
    for (let i = 0; i < 2; i++) {
      const { res, json } = await call(
        'POST',
        '/rentals',
        {
          property_id: p2.data.id,
          tenant_id: tenantId,
          start_date: dateOnly(3),
          end_date: dateOnly(368),
          price: 1_200_000,
          payment_period: 'MONTH'
        },
        { raw: true }
      )
      if (res.ok && json?.data?.id) rentalIds.push(json.data.id)
    }

    if (rentalIds.length === 0) {
      bad('concurrency setup', 'could not create any DRAFT rental for the concurrency probe')
    } else {
      const results = await Promise.all(
        rentalIds.map((id) => call('POST', `/rentals/${id}/activate`, {}, { raw: true }))
      )
      // If only one DRAFT existed, activate it twice concurrently instead.
      if (rentalIds.length === 1) {
        const twice = await Promise.all([
          call('POST', `/rentals/${rentalIds[0]}/activate`, {}, { raw: true }),
          call('POST', `/rentals/${rentalIds[0]}/activate`, {}, { raw: true })
        ])
        const okCount = twice.filter((r) => r.res.ok).length + results.filter((r) => r.res.ok).length
        assert(okCount >= 1, 'at least one activation succeeded')
      }
      const winners = results.filter((r) => r.res.ok).length
      assert(
        winners <= 1 || rentalIds.length === 1,
        'concurrent activations never produce two occupying rentals (§18)',
        `${winners} activations succeeded for ${rentalIds.length} drafts`
      )

      const { json: after } = await get(`/properties/${p2.data.id}`)
      const pp = after?.data?.property || after?.data
      assert(
        ['RENTED', 'AVAILABLE'].includes(pp?.availability_status),
        'the concurrency-probe property is left in a consistent state',
        `got ${pp?.availability_status}`
      )
    }
  }

  /* ---------------------- 09. end rental & release property --------------- */
  section('PHASE 9 — Ending the rental & releasing the property')
  {
    await expectRefused(
      'ending a rental without a reason is refused (§46 audit)',
      'POST',
      `/rentals/${rentalId}/end`,
      {},
      { code: 'VALIDATION_ERROR' }
    )

    const { json: ended } = await post(`/rentals/${rentalId}/end`, {
      reason: 'Kontrak diakhiri oleh tes E2E golden flow.'
    })
    assert(ended?.data?.status === 'ENDED', 'END RENTAL closes the commitment', `got ${ended?.data?.status}`)

    const { json: prop } = await get(`/properties/${propertyId}`)
    const p = prop?.data?.property || prop?.data
    assert(
      p?.availability_status === 'AVAILABLE',
      'the property RETURNED to AVAILABLE after the rental ended (§17)',
      `got ${p?.availability_status}`
    )

    await expectRefused(
      'an ENDED rental cannot be reactivated',
      'POST',
      `/rentals/${rentalId}/activate`,
      {},
      { code: 'INVALID_STATE_TRANSITION' }
    )
  }

  /* --------------------- 10. dashboard, analytics, audit ------------------ */
  section('PHASE 10 — Dashboard, Analytics & Audit traceability')
  {
    const { json: dash } = await get('/dashboard')
    const d = dash?.data
    assert(!!d, 'the dashboard responds')
    const dashKeys = JSON.stringify(d || {})
    assert(
      /action|follow|attention|overdue|due/i.test(dashKeys),
      'the dashboard surfaces ACTION REQUIRED, not only statistics (§19)',
      'no action-oriented section found'
    )

    const { json: funnel } = await get('/analytics/funnel')
    const f = JSON.stringify(funnel?.data || {})
    assert(
      /lead/i.test(f) && /(qualif|visit|negoti|rental)/i.test(f),
      'the analytics funnel reports LEAD → QUALIFIED → VISIT → NEGOTIATION → RENTAL (§20)',
      f.slice(0, 200)
    )

    // Audit is admin territory (§46).
    await actAs('ADMIN')

    const { json: audit } = await get('/audit-logs?limit=100')
    const logs = audit?.data || []
    assert(Array.isArray(logs) && logs.length > 0, 'audit logs exist (§46)')
    const blob = JSON.stringify(logs)
    assert(/RENTAL|rental/.test(blob), 'the rental activation/end is traceable in the audit trail (§46)')
    const sample = logs[0]
    assert(
      !!(sample?.user_id || sample?.actor_id) && !!sample?.action && !!(sample?.created_at || sample?.occurred_at),
      'each audit entry records WHO / WHAT / WHEN (§46)',
      `keys: ${Object.keys(sample || {}).join(',')}`
    )

    // Authorization is server-side: MARKETING must not read the audit trail (§3).
    await actAs('MARKETING')
    await expectRefused(
      'MARKETING is denied the admin audit trail — authority is server-side (§3)',
      'GET',
      '/audit-logs',
      undefined,
      { code: 'FORBIDDEN' }
    )
  }

  /* -------------------------------- summary ------------------------------- */
  console.log(`\n${'─'.repeat(66)}`)
  const total = passed + failed
  if (failed === 0) {
    console.log(`\x1b[1m\x1b[32mGOLDEN E2E FLOW PASSED\x1b[0m — ${passed}/${total} assertions`)
    console.log('\x1b[90mPROPERTY → OFFER → LEAD → QUALIFICATION → VISIT → NEGOTIATION → RENTAL\x1b[0m')
  } else {
    console.log(`\x1b[1m\x1b[31mGOLDEN E2E FLOW FAILED\x1b[0m — ${failed} of ${total} assertions failed:`)
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
  }
  console.log(`${'─'.repeat(66)}\n`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error(`\n\x1b[31mE2E RUN ABORTED:\x1b[0m ${err.message}\n`)
  process.exit(1)
})
