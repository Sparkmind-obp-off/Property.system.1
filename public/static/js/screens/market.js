/**
 * Market Intelligence — answers "who is most likely to rent this property?"
 * Traceability: PS-MASTER-001 §21 (market intelligence), §20 (analytics uses
 *               domain data), §27 (UI states) | PS-UX-010 §12
 *
 * This screen is READ-ONLY by contract: analytics must never carry duplicate
 * business logic (§54). Every number here is a projection of domain data, and
 * every conclusion is turned into a concrete next action (segment → tenants,
 * segment → offer) so the insight does not die on the page.
 */
import { api, session } from '../core/api.js'
import {
  badge,
  emptyState,
  errorState,
  esc,
  humanEnum,
  loadingState,
  moneyShort,
  num,
  truncate
} from '../core/dom.js'
import { screenEl, setHeader } from '../core/shell.js'

export async function marketScreen() {
  const el = screenEl()

  setHeader({
    title: 'Market Intelligence',
    subtitle: 'Aktivitas ekonomi area, kompetisi, dan segmen penyewa paling potensial',
    actions: `<button class="btn" data-action="refresh"><i class="fa-solid fa-rotate-right"></i>Muat ulang</button>`
  })
  document
    .querySelector('#page-actions [data-action="refresh"]')
    ?.addEventListener('click', () => marketScreen())

  el.innerHTML = loadingState('Menghitung sinyal pasar…')

  let data
  try {
    data = (await api.get('/market')).data
  } catch (err) {
    el.innerHTML = errorState(err)
    el.querySelector('[data-action="retry"]')?.addEventListener('click', () => marketScreen())
    return
  }

  const areas = data.areas || []
  const categories = data.business_categories || []
  const segments = data.segments || []
  const demand = data.demand_signals || []

  if (areas.length === 0 && segments.length === 0) {
    el.innerHTML = emptyState({
      icon: 'fa-map-location-dot',
      title: 'Belum ada data pasar',
      message:
        'Market intelligence dibangun dari area pasar, usaha sekitar, dan segmen penyewa. Tambahkan properti beserta area pasarnya untuk mulai membaca peluang.',
      action: { action: 'goto-prop', label: 'Buka Properti', icon: 'fa-building' }
    })
    el.querySelector('[data-action="goto-prop"]')?.addEventListener('click', () => {
      location.hash = '#/properties'
    })
    return
  }

  el.innerHTML = `
    <section class="stack">
      ${renderConclusion(segments, demand, areas)}
      ${renderAreas(areas)}
      ${renderSegments(segments)}
      <div class="split">
        ${renderDemand(demand)}
        ${renderCompetition(categories)}
      </div>
    </section>`

  bindActions(el)
}

/* --------------------------- Primary conclusion --------------------------- */

/**
 * The headline answer. Segments are ranked by realised commercial evidence
 * (leads/tenants) rather than by definition size, so the recommendation stays
 * grounded in what actually happened.
 */
function renderConclusion(segments, demand, areas) {
  const demandBy = new Map(demand.map((d) => [d.category, d]))
  const ranked = segments
    .map((s) => {
      const d = demandBy.get(s.business_category) || {}
      const leads = Number(d.leads || 0)
      const tenants = Number(s.tenants || 0)
      const matches = Number(s.viable_matches || 0)
      const offers = Number(s.offers || 0)
      // Evidence weighting: proven pipeline > available tenants > viable matches.
      const score = leads * 4 + tenants * 3 + matches * 2 - offers
      return { ...s, leads, tenants, matches, offers, evidence: score, win_rate: Number(d.win_rate || 0) }
    })
    .sort((a, b) => b.evidence - a.evidence)

  const top = ranked[0]
  const gap = ranked.find((s) => s.tenants > 0 && s.offers === 0)
  const hotArea = [...areas].sort((a, b) => Number(b.leads || 0) - Number(a.leads || 0))[0]

  if (!top) return ''

  return `
    <div class="card">
      <div class="card-head">
        <h2><i class="fa-solid fa-lightbulb"></i> Kesimpulan Pasar</h2>
        <span class="badge brand">Rekomendasi</span>
      </div>
      <div class="card-body">
        <div class="match-box">
          <div class="strong" style="font-size:15px">
            Segmen paling potensial saat ini: <b>${esc(top.name)}</b>
          </div>
          <div class="reasons">
            <div class="reason pro"><i class="fa-solid fa-check"></i>
              ${num(top.leads)} lead nyata sudah masuk dari kategori ${esc(humanEnum(top.business_category))}.</div>
            <div class="reason pro"><i class="fa-solid fa-check"></i>
              ${num(top.tenants)} calon penyewa terdaftar cocok dengan definisi segmen ini.</div>
            ${
              top.matches > 0
                ? `<div class="reason pro"><i class="fa-solid fa-check"></i>
                    ${num(top.matches)} pasangan properti–penyewa dinilai layak (HIGH/MEDIUM fit).</div>`
                : `<div class="reason risk"><i class="fa-solid fa-triangle-exclamation"></i>
                    Belum ada matching layak tercatat — jalankan matching dari detail properti agar rekomendasi lebih kuat.</div>`
            }
            ${
              hotArea
                ? `<div class="reason pro"><i class="fa-solid fa-location-dot"></i>
                    Area dengan pipeline terbesar: <b>${esc(hotArea.name)}</b> (${num(hotArea.leads)} lead, ${num(hotArea.properties)} properti).</div>`
                : ''
            }
            ${
              gap
                ? `<div class="reason risk"><i class="fa-solid fa-circle-exclamation"></i>
                    Peluang tak tergarap: segmen <b>${esc(gap.name)}</b> punya ${num(gap.tenants)} calon penyewa
                    tetapi belum memiliki offer sama sekali.</div>`
                : ''
            }
            ${
              top.win_rate === 0
                ? `<div class="reason con"><i class="fa-solid fa-xmark"></i>
                    Belum ada lead segmen ini yang menjadi rental — fokus pada kualifikasi dan follow-up, bukan menambah lead baru.</div>`
                : `<div class="reason pro"><i class="fa-solid fa-trophy"></i>
                    Win rate segmen ini ${esc(top.win_rate)}%.</div>`
            }
          </div>
          <div class="row" style="flex-wrap:wrap;margin-top:10px">
            <button class="btn sm" data-segment-tenants="${esc(top.business_category)}">
              <i class="fa-solid fa-users"></i>Lihat calon penyewa segmen ini</button>
            ${
              gap && session.can('offer.create')
                ? `<button class="btn sm primary" data-goto-offers="1">
                    <i class="fa-solid fa-bullhorn"></i>Buat offer untuk segmen kosong</button>`
                : ''
            }
            <a class="btn sm" href="#/analytics"><i class="fa-solid fa-chart-line"></i>Lihat funnel konversi</a>
          </div>
        </div>
      </div>
    </div>`
}

/* -------------------------------- Areas ---------------------------------- */

function renderAreas(areas) {
  if (areas.length === 0) return ''
  const maxLeads = Math.max(1, ...areas.map((a) => Number(a.leads || 0)))

  return `
    <div class="card">
      <div class="card-head"><h2>Area Pasar</h2><span class="badge">${num(areas.length)} area</span></div>
      <div class="card-body tight">
        ${areas
          .map(
            (a) => `<div class="list-item" style="display:block">
              <div class="row between">
                <div>
                  <div class="strong">${esc(a.name)}</div>
                  <div class="tiny dim">${esc(truncate(a.description || '—', 110))}</div>
                </div>
                <div class="row tight nowrap">
                  <span class="chip"><i class="fa-solid fa-building"></i> ${num(a.properties)} properti</span>
                  <span class="chip ${Number(a.leads) > 0 ? 'brand' : ''}"><i class="fa-solid fa-filter-circle-dollar"></i> ${num(a.leads)} lead</span>
                  <span class="chip"><i class="fa-solid fa-store"></i> ${num(a.nearby_businesses)} usaha</span>
                </div>
              </div>
              <div class="bar-row" style="margin-top:8px">
                <span class="tiny dim">Intensitas pipeline</span>
                <span class="bar-track"><span class="bar-fill ${Number(a.leads) >= maxLeads ? 'ok' : ''}"
                  style="width:${Math.round((Number(a.leads || 0) / maxLeads) * 100)}%"></span></span>
                <span class="tiny right">${num(a.leads)}</span>
              </div>
              ${
                a.market_notes
                  ? `<div class="inline-info" style="margin-top:8px"><i class="fa-solid fa-circle-info"></i> ${esc(a.market_notes)}</div>`
                  : ''
              }
              ${
                Number(a.nearby_businesses) === 0
                  ? `<div class="inline-warn" style="margin-top:8px"><i class="fa-solid fa-circle-exclamation"></i>
                      Belum ada data usaha sekitar untuk area ini, sehingga analisis kompetisi masih buta.</div>`
                  : ''
              }
            </div>`
          )
          .join('')}
      </div>
    </div>`
}

/* ------------------------------- Segments -------------------------------- */

function renderSegments(segments) {
  if (segments.length === 0) {
    return `<div class="card"><div class="card-head"><h2>Segmen Penyewa</h2></div>
      ${emptyState({
        icon: 'fa-layer-group',
        title: 'Belum ada segmen penyewa',
        message: 'Segmen menentukan siapa yang dituju setiap offer. Definisikan segmen agar pencarian penyewa terarah.',
        action: { action: 'goto-segments', label: 'Kelola Segmen', icon: 'fa-layer-group' }
      })}</div>`
  }

  return `
    <div class="card">
      <div class="card-head">
        <h2>Segmen Penyewa</h2>
        <span class="badge">${num(segments.length)} segmen</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Segmen</th><th>Kategori usaha</th><th>Kebutuhan ruang</th>
              <th>Rentang budget</th><th class="right">Calon penyewa</th>
              <th class="right">Match layak</th><th class="right">Offer</th><th class="right">Aksi</th>
            </tr>
          </thead>
          <tbody>
            ${segments
              .map(
                (s) => `<tr>
                  <td><div class="cell-main">${esc(s.name)}</div><div class="cell-sub">${badge(s.status)}</div></td>
                  <td>${esc(humanEnum(s.business_category))}</td>
                  <td class="nowrap">${num(s.minimum_space)}–${num(s.maximum_space)} m²</td>
                  <td class="nowrap">${esc(moneyShort(s.budget_min))} – ${esc(moneyShort(s.budget_max))}</td>
                  <td class="right">${num(s.tenants)}</td>
                  <td class="right">${Number(s.viable_matches) > 0 ? num(s.viable_matches) : '<span class="dim">0</span>'}</td>
                  <td class="right">
                    ${
                      Number(s.offers) > 0
                        ? num(s.offers)
                        : `<span class="badge warn">tidak ada</span>`
                    }
                  </td>
                  <td class="right nowrap">
                    <button class="btn sm" data-segment-tenants="${esc(s.business_category)}" title="Calon penyewa segmen ini">
                      <i class="fa-solid fa-users"></i></button>
                  </td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="card-foot">
        <span class="tiny dim">Segmen tanpa offer adalah permintaan yang belum dijawab penawaran.</span>
        <a class="btn sm" href="#/segments"><i class="fa-solid fa-layer-group"></i>Kelola segmen</a>
      </div>
    </div>`
}

/* ---------------------------- Demand signals ----------------------------- */

function renderDemand(demand) {
  if (demand.length === 0) {
    return `<div class="card"><div class="card-head"><h2>Sinyal Permintaan</h2></div>
      <div class="card-body"><div class="dim small">Belum ada calon penyewa terdaftar, sehingga permintaan per kategori belum terbaca.</div></div>
    </div>`
  }
  const max = Math.max(1, ...demand.map((d) => Number(d.leads || 0)))

  return `
    <div class="card">
      <div class="card-head"><h2>Sinyal Permintaan</h2><span class="badge">per kategori usaha</span></div>
      <div class="card-body">
        ${demand
          .map(
            (d) => `<div class="bar-row">
              <span>${esc(humanEnum(d.category))}</span>
              <span class="bar-track">
                <span class="bar-fill ${Number(d.won) > 0 ? 'ok' : Number(d.leads) === 0 ? 'warn' : ''}"
                  style="width:${Math.round((Number(d.leads || 0) / max) * 100)}%"></span>
              </span>
              <span class="right tiny">${num(d.leads)} lead</span>
            </div>
            <div class="tiny dim" style="margin:-2px 0 6px">
              ${num(d.tenants)} calon penyewa · ${num(d.won)} menjadi rental · win rate ${esc(d.win_rate)}%
            </div>`
          )
          .join('')}
      </div>
      <div class="card-foot">
        <span class="tiny dim">Permintaan tinggi dengan win rate 0% menandakan masalah eksekusi, bukan masalah pasar.</span>
      </div>
    </div>`
}

/* ----------------------------- Competition ------------------------------- */

function renderCompetition(categories) {
  if (categories.length === 0) {
    return `<div class="card">
      <div class="card-head"><h2>Kompetisi Sekitar</h2></div>
      ${emptyState({
        icon: 'fa-store',
        title: 'Belum ada data usaha sekitar',
        message:
          'Data usaha di sekitar properti dipakai untuk menilai kompetisi dan kejenuhan kategori. Tanpa data ini, penilaian peluang hanya bertumpu pada asumsi.',
        action: { action: 'goto-prop', label: 'Buka Properti', icon: 'fa-building' }
      })}
    </div>`
  }
  const max = Math.max(1, ...categories.map((c) => Number(c.businesses || 0)))

  return `
    <div class="card">
      <div class="card-head"><h2>Kompetisi Sekitar</h2><span class="badge">${num(categories.length)} kategori</span></div>
      <div class="card-body">
        ${categories
          .map(
            (c) => `<div class="bar-row">
              <span>${esc(humanEnum(c.category))}</span>
              <span class="bar-track">
                <span class="bar-fill ${Number(c.businesses) >= max ? 'danger' : ''}"
                  style="width:${Math.round((Number(c.businesses || 0) / max) * 100)}%"></span>
              </span>
              <span class="right tiny">${num(c.businesses)}</span>
            </div>
            ${
              c.avg_distance !== null && c.avg_distance !== undefined
                ? `<div class="tiny dim" style="margin:-2px 0 6px">rata-rata ${num(c.avg_distance)} m dari properti</div>`
                : ''
            }`
          )
          .join('')}
      </div>
      <div class="card-foot">
        <span class="tiny dim">Kategori padat = kompetisi tinggi. Kategori kosong dengan permintaan nyata = peluang.</span>
      </div>
    </div>`
}

/* -------------------------------- Actions -------------------------------- */

function bindActions(el) {
  el.querySelectorAll('[data-segment-tenants]').forEach((b) =>
    b.addEventListener('click', () => {
      location.hash = `#/tenants?business_category=${encodeURIComponent(b.dataset.segmentTenants)}`
    })
  )
  el.querySelector('[data-goto-offers]')?.addEventListener('click', () => {
    location.hash = '#/offers'
  })
  el.querySelector('[data-action="goto-segments"]')?.addEventListener('click', () => {
    location.hash = '#/segments'
  })
  el.querySelectorAll('[data-action="goto-prop"]').forEach((b) =>
    b.addEventListener('click', () => {
      location.hash = '#/properties'
    })
  )
}
