// ===== 담배2026 재고관리 SPA v2 =====
// 시트는 그대로 "단일"을 쓰고, UI에서만 "갑"으로 표시합니다.
//
// API 베이스 결정 우선순위:
// 1) window.__API_BASE__ (index.html에서 설정 가능 — Cloudflare Pages 용)
// 2) __PORT_5000__ 치환 토큰 (Perplexity publish_website)
// 3) 빈 문자열 (로컬/같은 도메인)
const RAW_API = "__PORT_5000__";
const API = (typeof window !== 'undefined' && window.__API_BASE__)
  ? String(window.__API_BASE__).replace(/\/$/, '')
  : (RAW_API.indexOf("__PORT_") === 0 ? "" : RAW_API);

// ----- 유틸 -----
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const fmtKRW = (n) => '₩' + (Number(n)||0).toLocaleString('ko-KR');
// 발주 화면 전용 단가 표시 — 0 한 자리 제거 (÷10)
const fmtKRWOrder = (n) => '₩' + Math.round((Number(n)||0)/10).toLocaleString('ko-KR');
const fmtNum = (n) => (Number(n)||0).toLocaleString('ko-KR');
const todayKR = () => {
  const d = new Date(Date.now() + 9*3600*1000);
  return d.toISOString().slice(0,10);
};
const monthKR = () => todayKR().slice(0,7);
// 단위 라벨: 시트의 "단일" → 화면 "갑"
const unitLabel = (u) => (u === '단일' ? '갑' : (u || ''));

function toast(msg, kind='ok') {
  const el = $('#toast'); const m = $('#toast-msg');
  m.textContent = msg;
  m.className = 'px-4 py-2.5 rounded-xl shadow-xl text-white text-sm ' +
    (kind === 'err' ? 'bg-rose-600' : kind === 'warn' ? 'bg-amber-600' : 'bg-slate-900');
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2400);
}

async function api(path, opts={}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

// ----- 상태 -----
const state = {
  products: [],
  stock: [],
  cart: [],
  ioCart: [],
  saleSelected: null,
  ioSelected: null,
  sales: [],   // 전체 판매 (대시보드/로그 공용)
  inout: [],   // 전체 입출고
  stockMode: 'list',
  orderQty: {},
  auditInput: {},
  auditConfirm: {},
};

// ===== 메인탭 전환 =====
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach(b => b.setAttribute('aria-selected', b===btn ? 'true' : 'false'));
    const tab = btn.dataset.tab;
    $$('section[data-panel]').forEach(s => s.classList.toggle('hidden', s.dataset.panel !== tab));
    if (tab === 'stock') renderStock();
    if (tab === 'dash')  loadDashboard();
    if (tab === 'inout') {
      // 진입 시 현재 활성 하위탭에 맞는 데이터 로드
      const active = $('.subtab-btn[aria-selected="true"]');
      if (active && active.dataset.subtab === 'log') loadLog();
    }
  });
});

// ===== 입출고 하위탭 =====
$$('.subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.subtab-btn').forEach(b => b.setAttribute('aria-selected', b===btn ? 'true' : 'false'));
    const sub = btn.dataset.subtab;
    $$('[data-subpanel]').forEach(s => s.classList.toggle('hidden', s.dataset.subpanel !== sub));
    if (sub === 'log') loadLog();
  });
});

// ===== 헤더 새로고침 =====
$('#btn-refresh').addEventListener('click', async () => {
  toast('새로고침…');
  await loadProducts(true);
  await loadStock(true);
  state.sales = []; state.inout = [];
  const active = $('.tab-btn[aria-selected="true"]').dataset.tab;
  if (active === 'stock') renderStock();
  if (active === 'dash')  loadDashboard();
  if (active === 'inout') {
    const sub = $('.subtab-btn[aria-selected="true"]')?.dataset.subtab;
    if (sub === 'log') loadLog();
  }
  toast('완료');
});

// ===== 설정 모달 =====
const settingsModal = $('#settings-modal');
function openSettings() {
  settingsModal.classList.remove('hidden');
  settingsModal.classList.add('flex');
  loadHealth();
}
function closeSettings() {
  settingsModal.classList.add('hidden');
  settingsModal.classList.remove('flex');
}
$('#btn-settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

// ===== 데이터 로딩 =====
async function loadProducts(force=false) {
  state.products = await api('/api/products' + (force?'?force=1':''));
  fillMakerOptions();
}
async function loadStock(force=false) {
  state.stock = await api('/api/stock');
}
async function loadHealth() {
  try {
    const h = await api('/api/health');
    $('#settings-health').textContent = JSON.stringify(h, null, 2);
    $('#health-dot').classList.remove('bg-slate-500','bg-emerald-500','bg-amber-500','bg-rose-500');
    $('#health-dot').classList.add(
      h.auth === 'service-account' ? 'bg-emerald-500' :
      h.auth === 'apikey(read-only)' ? 'bg-amber-500' : 'bg-rose-500'
    );
    $('#header-sub').textContent =
      h.auth === 'service-account' ? 'Google Sheets 연결됨' :
      h.auth === 'apikey(read-only)' ? '읽기 전용 (API Key)' : '인증 미설정';
    $('#ss-link').href = `https://docs.google.com/spreadsheets/d/${h.spreadsheetId}/edit`;
  } catch (e) {
    $('#settings-health').textContent = 'ERROR: ' + e.message;
    $('#health-dot').classList.add('bg-rose-500');
  }
}

// ===== 검색/추천 (판매 + 입출고 공용) =====
function searchProducts(q) {
  q = (q||'').trim().toLowerCase();
  if (!q) return [];
  return state.products.filter(p =>
    !p.discontinued && (
      (p.name||'').toLowerCase().includes(q) ||
      (p.maker||'').toLowerCase().includes(q) ||
      p.barcodeSingle === q || p.barcodeCarton === q ||
      p.id.toLowerCase().includes(q)
    )
  ).slice(0, 12);
}

function renderSuggest(boxEl, items, onPick) {
  if (!items.length) { boxEl.classList.add('hidden'); boxEl.innerHTML=''; return; }
  boxEl.innerHTML = items.map((p,i) => `
    <button data-idx="${i}" class="w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0">
      <div class="font-medium text-slate-900">${p.name} <span class="text-xs text-slate-400">${p.maker||''}</span></div>
      <div class="text-xs text-slate-500">${p.id}${p.maker?(' · '+p.maker):''}</div>
    </button>`).join('');
  boxEl.classList.remove('hidden');
  $$('button', boxEl).forEach(b => b.addEventListener('click', () => onPick(items[+b.dataset.idx])));
}

// ===== 판매입력 =====
function selectSale(p, unitHint) {
  state.saleSelected = p;
  $('#sale-suggest').classList.add('hidden');
  $('#sale-search').value = `${p.name} (${p.id})`;
  if (unitHint) $('#sale-unit').value = unitHint;
  $('#sale-selected').textContent = `선택: ${p.name}`;
  $('#sale-selected').classList.remove('hidden');
  $('#sale-qty').focus(); $('#sale-qty').select();
}
$('#sale-search').addEventListener('input', (e) => {
  const items = searchProducts(e.target.value);
  renderSuggest($('#sale-suggest'), items, (p) => selectSale(p));
});
$('#sale-search').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const v = e.target.value.trim();
    const exact = state.products.find(p => p.barcodeSingle === v || p.barcodeCarton === v);
    if (exact) {
      const unit = exact.barcodeSingle === v ? '단일' : '보루';
      selectSale(exact, unit);
      addToCart();
    } else {
      const items = searchProducts(v);
      if (items.length === 1) selectSale(items[0]);
    }
  }
});

function addToCart() {
  const p = state.saleSelected;
  if (!p) { toast('상품을 선택하세요', 'warn'); return; }
  const unit = $('#sale-unit').value;
  const qty = parseInt($('#sale-qty').value) || 0;
  if (qty <= 0) { toast('수량을 입력하세요', 'warn'); return; }
  const unitPrice = unit === '보루' ? p.priceCarton : p.priceSingle;
  state.cart.push({
    productId: p.id, name: p.name, unit, qty,
    unitPrice, amount: unitPrice * qty,
  });
  renderCart();
  $('#sale-search').value = ''; $('#sale-selected').classList.add('hidden');
  state.saleSelected = null; $('#sale-qty').value = 1; $('#sale-unit').value = '단일';
  $('#sale-search').focus();
}
$('#sale-add').addEventListener('click', addToCart);

function renderCart() {
  const tb = $('#cart-body');
  if (!state.cart.length) {
    tb.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-400">담긴 상품이 없습니다</td></tr>';
    $('#cart-count').textContent = '(0)';
    return;
  }
  tb.innerHTML = state.cart.map((c, i) => `
    <tr class="border-t border-slate-100">
      <td class="px-3 py-2"><div class="font-medium">${c.name}</div><div class="text-xs text-slate-400">${c.productId}</div></td>
      <td class="px-3 py-2 text-center">${unitLabel(c.unit)}</td>
      <td class="px-3 py-2 text-center">${c.qty}</td>
      <td class="px-3 py-2 text-right"><button data-i="${i}" class="cart-del text-rose-500 hover:text-rose-700">삭제</button></td>
    </tr>`).join('');
  $$('.cart-del', tb).forEach(b => b.addEventListener('click', () => {
    state.cart.splice(+b.dataset.i, 1); renderCart();
  }));
  $('#cart-count').textContent = `(${state.cart.length})`;
}
$('#cart-clear').addEventListener('click', () => { state.cart = []; renderCart(); });
$('#cart-submit').addEventListener('click', async () => {
  if (!state.cart.length) return toast('담긴 상품이 없습니다', 'warn');
  const items = state.cart.map(c => ({ productId: c.productId, unit: c.unit, qty: c.qty }));
  try {
    const r = await api('/api/sales', { method:'POST', body: items });
    let msg = `${r.count}건 저장 완료`;
    if (r.autoConvert && r.autoConvert > 0) msg += ` · 보루→갑 자동환산 ${r.autoConvert}회`;
    toast(msg);
    state.cart = []; renderCart();
    state.sales = []; state.inout = [];  // 캐시 무효화
    await loadStock(true);
    // 등록 즉시 로그 재조회 (현재 탭 여부와 무관하게 최신화)
    await loadLog();
  } catch (e) { toast('저장 실패: ' + e.message, 'err'); }
});

// ===== 재고조회 =====
function filterStock(includeAllForAudit=false) {
  const q = ($('#stock-q').value||'').trim().toLowerCase();
  const maker = $('#stock-maker').value;
  const lowOnly = $('#stock-low').checked;
  const activeOnly = $('#stock-active').checked;
  let list = state.stock.slice();
  if (maker) list = list.filter(s => s.maker === maker);
  if (activeOnly) list = list.filter(s => !s.discontinued);
  if (!includeAllForAudit && lowOnly) list = list.filter(s => s.lowStock);
  if (q) list = list.filter(s =>
    (s.name||'').toLowerCase().includes(q) ||
    (s.maker||'').toLowerCase().includes(q) ||
    (s.barcodeSingle||'') === q || (s.barcodeCarton||'') === q ||
    s.id.toLowerCase().includes(q)
  );
  return list;
}

function setStockMode(mode) {
  state.stockMode = mode;
  $$('.mode-btn').forEach(b => {
    const on = b.dataset.mode === mode;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $$('[data-show-mode]').forEach(el => {
    el.classList.toggle('hidden', el.dataset.showMode !== mode);
  });
  renderStock();
}

function renderStock() {
  const total  = state.stock.length;
  const low    = state.stock.filter(s => s.lowStock && !s.discontinued).length;
  const active = state.stock.filter(s => !s.discontinued).length;
  const totalCartons = state.stock.reduce((s,p) => s + (p.stockCarton||0), 0);
  $('#stock-summary').innerHTML =
    '<span>전체 <b>' + total + '</b></span>' +
    '<span>판매중 <b>' + active + '</b></span>' +
    '<span class="text-amber-700">부족 <b>' + low + '</b></span>' +
    '<span>총재고 <b>' + fmtNum(totalCartons) + '</b>보루</span>';

  if (state.stockMode === 'list')  return renderListMode();
  if (state.stockMode === 'order') return renderOrderMode();
  if (state.stockMode === 'audit') return renderAuditMode();
}

// --- 모드 1: 목록 (안전/단가 컬럼 제거, 갑/보루 강조) ---
function renderListMode() {
  const list = filterStock();
  list.sort((a,b) => (a.lowStock===b.lowStock) ? a.name.localeCompare(b.name,'ko') : (a.lowStock?-1:1));
  const tb = $('#stock-body');
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400">조건에 맞는 상품이 없습니다</td></tr>';
    return;
  }
  tb.innerHTML = list.map(s => {
    const rowCls = s.discontinued ? 'row-out' : (s.lowStock ? 'row-low' : '');
    const badge = s.discontinued
      ? '<span class="chip bg-slate-200 text-slate-600">단종</span>'
      : (s.lowStock
          ? '<span class="chip bg-amber-100 text-amber-800">부족</span>'
          : '<span class="chip bg-emerald-100 text-emerald-700">정상</span>');
    const cartonNum = '<span class="font-mono text-base font-semibold">' + fmtNum(s.stockCarton) + '</span>';
    const singleNum = '<span class="font-mono text-base">' + (s.stockSingle||0) + '</span>';
    const editBtn = '<button type="button" data-edit-row="' + s.id + '" title="상품 편집" ' +
      'class="inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 active:scale-95 transition">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>' +
      '</button>';
    return '<tr class="border-t border-slate-100 ' + rowCls + '">' +
      '<td class="px-3 py-2"><div class="font-medium">' + s.name + '</div>' +
      '<div class="text-xs text-slate-400">' + s.id + '</div></td>' +
      '<td class="px-3 py-2 text-slate-600">' + (s.maker||'') + '</td>' +
      '<td class="px-3 py-2 text-center col-pack">' + singleNum + '</td>' +
      '<td class="px-3 py-2 text-center col-carton">' + cartonNum + '</td>' +
      '<td class="px-3 py-2 text-center">' + badge + '</td>' +
      '<td class="px-3 py-2 text-center">' + editBtn + '</td>' +
    '</tr>';
  }).join('');
}

// --- 모드 2: 발주 ---
function recommendOrder(s, buffer) {
  const target = (s.safetyStockCarton||0) + (Number(buffer)||0);
  const need = target - (s.stockCarton||0);
  return need > 0 ? need : 0;
}

function renderOrderMode() {
  const buffer = Number($('#order-buffer').value||0);
  let list = filterStock(true).filter(s => !s.discontinued);
  list = list.filter(s => s.lowStock || recommendOrder(s, buffer) > 0);
  list.sort((a,b) => (a.maker||'').localeCompare(b.maker||'','ko') || a.name.localeCompare(b.name,'ko'));

  const groups = {};
  list.forEach(s => { const k = s.maker || '기타'; (groups[k] = groups[k] || []).push(s); });

  const wrap = $('#order-groups');
  if (!list.length) {
    wrap.innerHTML = '<div class="bg-white rounded-2xl border border-slate-200 p-12 text-center text-slate-400">현재 발주가 필요한 상품이 없습니다</div>';
  } else {
    wrap.innerHTML = Object.keys(groups).map(maker => {
      const rows = groups[maker].map(s => {
        const rec = recommendOrder(s, buffer);
        const val = state.orderQty[s.id] != null ? state.orderQty[s.id] : '';
        return '<tr class="border-t border-slate-100">' +
          '<td class="px-3 py-2"><div class="font-medium">' + s.name + '</div>' +
          '<div class="text-xs text-slate-400">' + s.id + '</div></td>' +
          '<td class="px-3 py-2 text-center text-slate-600">' + s.safetyStockCarton + '보루</td>' +
          '<td class="px-3 py-2 text-center font-mono ' + (s.lowStock?'text-amber-700 font-semibold':'text-slate-600') + '">' +
            (s.stockSingle||0) + '갑 ' + fmtNum(s.stockCarton) + '보루</td>' +
          '<td class="px-3 py-2 text-center"><span class="chip bg-sky-100 text-sky-800">' + rec + '</span></td>' +
          '<td class="px-3 py-2 text-center">' +
            '<input type="number" min="0" value="' + val + '" data-order-id="' + s.id + '" placeholder="0" ' +
            'class="qty-input w-20 px-2 py-1.5 rounded-lg border border-slate-300 text-center font-mono"></td>' +
          '<td class="px-3 py-2 text-right text-slate-500">' + fmtKRWOrder(s.priceCarton) + '</td>' +
        '</tr>';
      }).join('');
      const sum = groups[maker].reduce((a,s) => a + (Number(state.orderQty[s.id])||0), 0);
      return '<div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">' +
        '<div class="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">' +
          '<div class="font-semibold text-slate-700">' + maker + ' <span class="text-xs text-slate-400 font-normal">(' + groups[maker].length + '종)</span></div>' +
          '<div class="text-sm text-slate-600">소계 <b class="text-emerald-700">' + sum + '</b>보루</div>' +
        '</div>' +
        '<div class="overflow-x-auto"><table class="w-full text-sm">' +
          '<thead class="text-slate-500 bg-slate-50/50 text-xs"><tr>' +
            '<th class="text-left px-3 py-2">상품</th>' +
            '<th class="px-3 py-2">안전재고</th>' +
            '<th class="px-3 py-2">현재고</th>' +
            '<th class="px-3 py-2">권장</th>' +
            '<th class="px-3 py-2">발주(보루)</th>' +
            '<th class="px-3 py-2 text-right">단가</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '</div>';
    }).join('');
  }

  $('#order-count').textContent = list.length;
  $('#order-recommend').textContent = list.reduce((a,s) => a + recommendOrder(s, buffer), 0);
  const inputTotal = list.reduce((a,s) => a + (Number(state.orderQty[s.id])||0), 0);
  $('#order-input-total').textContent = inputTotal;
}

// --- 모드 3: 재고조사 ---
function calcAuditDiff(s) {
  const inp = state.auditInput[s.id];
  if (!inp || (inp.carton === '' && inp.single === '')) return null;
  const real = (Number(inp.carton)||0)*10 + (Number(inp.single)||0);
  const sys  = (Number(s.stockCarton)||0)*10 + (Number(s.stockSingle)||0);
  return real - sys;
}

function calcAuditStats() {
  let entered = 0, diffCount = 0, diffUnits = 0;
  state.stock.forEach(s => {
    if (!state.auditConfirm[s.id]) return;
    const d = calcAuditDiff(s);
    if (d !== null) {
      entered++;
      if (d !== 0) { diffCount++; diffUnits += Math.abs(d); }
    }
  });
  $('#audit-entered').textContent = entered;
  $('#audit-total').textContent = state.stock.length;
  $('#audit-diff').textContent = diffCount;
  $('#audit-diff-units').textContent = diffUnits;
}

function renderAuditMode() {
  const onlyDiff = $('#audit-only-diff').checked;
  const onlyConfirmed = $('#audit-only-confirmed').checked;
  let list = filterStock(true);
  list.sort((a,b) => (a.maker||'').localeCompare(b.maker||'','ko') || a.name.localeCompare(b.name,'ko'));
  calcAuditStats();
  if (onlyConfirmed) list = list.filter(s => state.auditConfirm[s.id]);
  if (onlyDiff) list = list.filter(s => { const d = calcAuditDiff(s); return d !== null && d !== 0; });
  const tb = $('#audit-body');
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-400">' +
      (onlyDiff ? '차이가 있는 상품이 없습니다' :
       onlyConfirmed ? '확정된 상품이 없습니다' : '조건에 맞는 상품이 없습니다') + '</td></tr>';
    return;
  }
  tb.innerHTML = list.map(s => {
    const inp = state.auditInput[s.id] || {carton:'', single:''};
    const confirmed = !!state.auditConfirm[s.id];
    const hasInput = (inp.carton !== '' && inp.carton != null) || (inp.single !== '' && inp.single != null);
    const d = calcAuditDiff(s);
    let diffHtml = '<span class="text-slate-300">-</span>';
    if (d !== null) {
      if (d === 0) diffHtml = '<span class="chip bg-emerald-100 text-emerald-700">일치</span>';
      else if (d > 0) diffHtml = '<span class="chip bg-sky-100 text-sky-800 font-mono">+' + d + '</span>';
      else diffHtml = '<span class="chip bg-rose-100 text-rose-800 font-mono">' + d + '</span>';
    }
    const rowCls = s.discontinued ? 'opacity-50' :
      (confirmed ? 'bg-emerald-50/30' : (hasInput ? 'bg-amber-50/30' : ''));
    const confirmCellHtml =
      '<label class="inline-flex items-center justify-center cursor-pointer">' +
        '<input type="checkbox" ' + (confirmed?'checked':'') + ' data-confirm-id="' + s.id + '" ' +
        'class="w-5 h-5 accent-emerald-600 cursor-pointer" ' + (hasInput?'':'disabled title="실재고 입력 후 확정 가능"') + ' />' +
      '</label>' +
      (hasInput ? '<button data-clear-id="' + s.id + '" title="이 행 입력값 지우기" ' +
        'class="ml-2 text-xs px-1.5 py-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50">✕</button>' : '');
    return '<tr class="border-t border-slate-100 ' + rowCls + '">' +
      '<td class="px-3 py-2"><div class="font-medium">' + s.name + '</div>' +
      '<div class="text-xs text-slate-400">' + s.id + '</div></td>' +
      '<td class="px-3 py-2 text-slate-600">' + (s.maker||'') + '</td>' +
      '<td class="px-3 py-2 text-center bg-sky-50/50 font-mono">' +
        (s.stockSingle||0) + ' / ' + fmtNum(s.stockCarton) + '</td>' +
      '<td class="px-3 py-2 text-center bg-emerald-50/40">' +
        '<input type="number" min="0" value="' + inp.single + '" data-audit-id="' + s.id + '" data-audit-kind="single" placeholder="갑" ' +
          'class="qty-input w-16 px-2 py-1 rounded-lg border border-slate-300 text-center font-mono mr-1"> / ' +
        '<input type="number" min="0" value="' + inp.carton + '" data-audit-id="' + s.id + '" data-audit-kind="carton" placeholder="보루" ' +
          'class="qty-input w-16 px-2 py-1 rounded-lg border border-slate-300 text-center font-mono ml-1">' +
      '</td>' +
      '<td class="px-3 py-2 text-center whitespace-nowrap">' + confirmCellHtml + '</td>' +
      '<td class="px-3 py-2 text-center">' + diffHtml + '</td>' +
    '</tr>';
  }).join('');
}

$$('.mode-btn').forEach(b => b.addEventListener('click', () => setStockMode(b.dataset.mode)));
['#stock-q','#stock-maker','#stock-low','#stock-active','#order-buffer','#audit-only-diff','#audit-only-confirmed'].forEach(s => {
  $(s).addEventListener('input', () => renderStock());
});
$('#stock-maker').addEventListener('change', () => renderStock());

// 발주/재고조사 입력 위임
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.orderId != null) {
    const id = t.dataset.orderId;
    const v = t.value === '' ? '' : Math.max(0, Math.floor(Number(t.value)||0));
    if (v === '' || v === 0) delete state.orderQty[id]; else state.orderQty[id] = v;
    const buffer = Number($('#order-buffer').value||0);
    let list = filterStock(true).filter(s => !s.discontinued);
    list = list.filter(s => s.lowStock || recommendOrder(s, buffer) > 0);
    const inputTotal = list.reduce((a,s) => a + (Number(state.orderQty[s.id])||0), 0);
    $('#order-input-total').textContent = inputTotal;
  }
  if (t.dataset && t.dataset.auditId != null) {
    const id = t.dataset.auditId;
    const kind = t.dataset.auditKind;
    state.auditInput[id] = state.auditInput[id] || {carton:'', single:''};
    state.auditInput[id][kind] = t.value === '' ? '' : Math.max(0, Math.floor(Number(t.value)||0));
    if (state.auditConfirm[id]) state.auditConfirm[id] = false;
    const tr = t.closest('tr');
    const s = state.stock.find(x => x.id === id);
    if (tr && s) {
      const inp = state.auditInput[id];
      const hasInput = (inp.carton !== '' && inp.carton != null) || (inp.single !== '' && inp.single != null);
      tr.classList.remove('bg-emerald-50/30', 'bg-amber-50/30');
      if (!s.discontinued && hasInput) tr.classList.add('bg-amber-50/30');
      const cb = tr.querySelector('input[data-confirm-id]');
      if (cb) {
        cb.checked = false;
        cb.disabled = !hasInput;
        if (hasInput) cb.removeAttribute('title'); else cb.title = '실재고 입력 후 확정 가능';
      }
      const cells = tr.querySelectorAll('td');
      const last = cells[cells.length - 1];
      const d = calcAuditDiff(s);
      if (last) {
        if (d === null) last.innerHTML = '<span class="text-slate-300">-</span>';
        else if (d === 0) last.innerHTML = '<span class="chip bg-emerald-100 text-emerald-700">일치</span>';
        else if (d > 0) last.innerHTML = '<span class="chip bg-sky-100 text-sky-800 font-mono">+' + d + '</span>';
        else last.innerHTML = '<span class="chip bg-rose-100 text-rose-800 font-mono">' + d + '</span>';
      }
      const lbl = tr.querySelector('input[data-confirm-id]')?.parentElement;
      if (lbl) {
        const x = lbl.parentElement.querySelector('button[data-clear-id]');
        if (hasInput && !x) {
          const btn = document.createElement('button');
          btn.dataset.clearId = id;
          btn.title = '이 행 입력값 지우기';
          btn.className = 'ml-2 text-xs px-1.5 py-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50';
          btn.textContent = '✕';
          lbl.parentElement.appendChild(btn);
        } else if (!hasInput && x) { x.remove(); }
      }
    }
    calcAuditStats();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.confirmId != null) {
    const id = t.dataset.confirmId;
    const inp = state.auditInput[id];
    const hasInput = inp && ((inp.carton !== '' && inp.carton != null) || (inp.single !== '' && inp.single != null));
    if (!hasInput) { t.checked = false; return toast('실재고를 먼저 입력해주세요', 'warn'); }
    state.auditConfirm[id] = t.checked;
    const tr = t.closest('tr');
    if (tr) {
      tr.classList.remove('bg-emerald-50/30', 'bg-amber-50/30');
      tr.classList.add(t.checked ? 'bg-emerald-50/30' : 'bg-amber-50/30');
    }
    calcAuditStats();
  }
});
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.clearId != null) {
    const id = t.dataset.clearId;
    delete state.auditInput[id];
    delete state.auditConfirm[id];
    renderAuditMode();
    toast('해당 행 입력을 지웠습니다');
  }
});

// 발주 버튼들
$('#order-fill-recommend').addEventListener('click', () => {
  const buffer = Number($('#order-buffer').value||0);
  state.stock.forEach(s => { if (s.discontinued) return; const rec = recommendOrder(s, buffer); if (rec > 0) state.orderQty[s.id] = rec; });
  renderStock();
  toast('권장 발주량으로 채웠습니다');
});
$('#order-clear').addEventListener('click', () => { state.orderQty = {}; renderStock(); });
$('#order-export').addEventListener('click', () => {
  const items = state.stock.filter(s => Number(state.orderQty[s.id])>0);
  if (!items.length) return toast('발주 수량을 입력하세요','warn');
  items.sort((a,b) => (a.maker||'').localeCompare(b.maker||'','ko') || a.name.localeCompare(b.name,'ko'));
  const rows = [['제조사','상품명','상품ID','발주(보루)','단가(보루)','금액']];
  let total = 0;
  items.forEach(s => {
    const q = Number(state.orderQty[s.id])||0;
    const unit = Math.round((Number(s.priceCarton)||0)/10); // 0 하나 제거
    const amt = q*unit;
    total += amt;
    rows.push([s.maker||'', s.name, s.id, q, unit, amt]);
  });
  rows.push(['','','합계','','', total]);
  const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '발주서_' + todayKR() + '.csv';
  a.click(); URL.revokeObjectURL(url);
  toast('발주서 CSV 저장됨');
});
$('#order-print').addEventListener('click', () => {
  const items = state.stock.filter(s => Number(state.orderQty[s.id])>0);
  if (!items.length) return toast('발주 수량을 입력하세요','warn');
  items.sort((a,b) => (a.maker||'').localeCompare(b.maker||'','ko') || a.name.localeCompare(b.name,'ko'));
  const groups = {};
  items.forEach(s => { (groups[s.maker||'기타'] = groups[s.maker||'기타']||[]).push(s); });
  let total = 0, totalCt = 0;
  let html = '<html><head><meta charset="utf-8"><title>발주서</title>' +
    '<style>body{font-family:system-ui,sans-serif;padding:24px;color:#111}' +
    'h1{margin:0 0 4px}h2{margin:18px 0 6px;font-size:14px;background:#f1f5f9;padding:6px 8px;border-radius:6px}' +
    'table{width:100%;border-collapse:collapse;font-size:12px}' +
    'th,td{border-bottom:1px solid #e2e8f0;padding:6px 8px;text-align:left}' +
    'th{background:#f8fafc;font-weight:600}.r{text-align:right}.c{text-align:center}' +
    'tfoot td{font-weight:700;background:#f8fafc}</style></head><body>' +
    '<h1>담배 발주서</h1><div style="color:#64748b;font-size:12px">작성일 ' + todayKR() + '</div>';
  Object.keys(groups).forEach(m => {
    let sub = 0, subCt = 0;
    html += '<h2>' + m + '</h2><table><thead><tr><th>상품명</th><th class="c">발주(보루)</th><th class="r">단가</th><th class="r">금액</th></tr></thead><tbody>';
    groups[m].forEach(s => {
      const q = Number(state.orderQty[s.id])||0;
      const unitPrice = Math.round((Number(s.priceCarton)||0)/10); // 0 하나 제거
      const amt = q*unitPrice;
      sub += amt; subCt += q; total += amt; totalCt += q;
      html += '<tr><td>' + s.name + '</td><td class="c">' + q + '</td><td class="r">' + fmtKRW(unitPrice) + '</td><td class="r">' + fmtKRW(amt) + '</td></tr>';
    });
    html += '</tbody><tfoot><tr><td>소계</td><td class="c">' + subCt + '</td><td></td><td class="r">' + fmtKRW(sub) + '</td></tr></tfoot></table>';
  });
  html += '<h2 style="background:#fde68a">합계: ' + totalCt + '보루 / ' + fmtKRW(total) + '</h2></body></html>';
  const w = window.open('', '_blank');
  w.document.write(html); w.document.close();
  setTimeout(() => { w.print(); }, 250);
});

// 재고조사 버튼들
$('#audit-clear').addEventListener('click', () => {
  if (!confirm('입력값과 확정 상태를 모두 지울까요?')) return;
  state.auditInput = {}; state.auditConfirm = {}; renderStock();
});
$('#audit-apply').addEventListener('click', async () => {
  const ops = []; let confirmedCount = 0;
  state.stock.forEach(s => {
    if (!state.auditConfirm[s.id]) return;
    confirmedCount++;
    const d = calcAuditDiff(s);
    if (d !== null && d !== 0) {
      ops.push({ productId: s.id, type: '조정', unit: '단일', qty: d, memo: '재고조사 차이 자동조정 ' + todayKR() });
    }
  });
  if (!confirmedCount) return toast('확정한 상품이 없습니다. 실재고를 입력하고 확정 체크박스를 켜주세요.', 'warn');
  if (!ops.length) return toast('확정한 ' + confirmedCount + '건 모두 시스템과 일치합니다 (저장할 차이 없음)', 'ok');
  if (!confirm('확정한 ' + confirmedCount + '건 중 차이 있는 ' + ops.length + '건을 시트에 재고조정으로 저장합니다. 진행할까요?')) return;
  try {
    toast('저장 중…');
    let okCount = 0;
    for (const op of ops) { await api('/api/inout', { method: 'POST', body: op }); okCount++; }
    toast(okCount + '건 저장 완료');
    state.auditInput = {}; state.auditConfirm = {};
    state.sales = []; state.inout = [];
    await loadStock(true); renderStock();
  } catch (e) { toast(e.message, 'err'); }
});

// ===== 입출고 (구분/단위/수량) =====
function selectIO(p) {
  state.ioSelected = p;
  $('#io-suggest').classList.add('hidden');
  $('#io-search').value = `${p.name} (${p.id})`;
  $('#io-selected').textContent = `선택: ${p.name}`;
  $('#io-selected').classList.remove('hidden');
  $('#io-qty').focus(); $('#io-qty').select();
}
$('#io-search').addEventListener('input', (e) => {
  const items = searchProducts(e.target.value);
  renderSuggest($('#io-suggest'), items, selectIO);
});
$('#io-add').addEventListener('click', () => {
  const p = state.ioSelected;
  if (!p) return toast('상품을 선택하세요', 'warn');
  const type = $('#io-type').value;
  const unit = $('#io-unit').value;
  const qty = parseInt($('#io-qty').value) || 0;
  const memo = $('#io-memo').value || '';
  if (qty <= 0) return toast('수량을 입력하세요', 'warn');
  state.ioCart.push({ productId: p.id, name: p.name, type, unit, qty, memo });
  renderIOCart();
  $('#io-search').value=''; $('#io-selected').classList.add('hidden');
  state.ioSelected = null; $('#io-qty').value=1;
  $('#io-search').focus();
});
function renderIOCart() {
  const tb = $('#iocart-body');
  if (!state.ioCart.length) {
    tb.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-slate-400">담긴 항목이 없습니다</td></tr>';
    $('#iocart-count').textContent = '(0)'; return;
  }
  tb.innerHTML = state.ioCart.map((c,i) => `
    <tr class="border-t border-slate-100">
      <td class="px-3 py-2"><div class="font-medium">${c.name}</div><div class="text-xs text-slate-400">${c.productId}</div></td>
      <td class="px-3 py-2 text-center">${c.type}</td>
      <td class="px-3 py-2 text-center">${unitLabel(c.unit)}</td>
      <td class="px-3 py-2 text-center">${c.qty}</td>
      <td class="px-3 py-2 text-right"><button data-i="${i}" class="io-del text-rose-500 hover:text-rose-700">삭제</button></td>
    </tr>`).join('');
  $$('.io-del', tb).forEach(b => b.addEventListener('click', () => { state.ioCart.splice(+b.dataset.i,1); renderIOCart(); }));
  $('#iocart-count').textContent = `(${state.ioCart.length})`;
}
$('#iocart-clear').addEventListener('click', () => { state.ioCart=[]; renderIOCart(); });
$('#iocart-submit').addEventListener('click', async () => {
  if (!state.ioCart.length) return toast('담긴 항목이 없습니다', 'warn');
  const items = state.ioCart.map(c => ({ productId: c.productId, type: c.type, unit: c.unit, qty: c.qty, memo: c.memo }));
  try {
    const r = await api('/api/inout', { method:'POST', body: items });
    toast(`${r.count}건 저장 완료`);
    state.ioCart = []; renderIOCart();
    state.sales = []; state.inout = [];
    await loadStock(true);
    await loadLog();
  } catch (e) { toast('저장 실패: '+e.message, 'err'); }
});

// ===== 최근 기록 (로그) =====
async function loadLog() {
  try {
    const [sales, inout] = await Promise.all([
      api('/api/sales'),
      api('/api/inout'),
    ]);
    state.sales = sales; state.inout = inout;
    renderLog();
  } catch (e) { toast(e.message, 'err'); }
}
function renderLog() {
  const kind = $('#log-kind').value;
  const q = ($('#log-q').value||'').trim().toLowerCase();
  let rows = [];
  if (kind === 'all' || kind === 'sale') {
    rows = rows.concat(state.sales.map(s => ({
      datetime: s.datetime, kind: 'sale', productId: s.productId, name: s.name,
      unit: s.unit, qty: s.qty, amount: s.amount, memo: s.memo,
    })));
  }
  if (kind === 'all' || kind === 'io') {
    rows = rows.concat(state.inout.map(s => ({
      datetime: s.datetime, kind: 'io', productId: s.productId, name: s.name,
      unit: s.unit, qty: s.qty, type: s.type, memo: s.memo,
    })));
  }
  if (q) rows = rows.filter(r =>
    (r.name||'').toLowerCase().includes(q) ||
    (r.productId||'').toLowerCase().includes(q)
  );
  // 최신순 정렬 (맨 위가 최근) — 문자열 + 타임스탬프 이중 비교로 안전
  const parseTs = (s) => { const t = Date.parse((s||'').replace(' ', 'T')); return isNaN(t) ? 0 : t; };
  rows.sort((a,b) => parseTs(b.datetime) - parseTs(a.datetime) || (b.datetime||'').localeCompare(a.datetime||''));
  rows = rows.slice(0, 50);
  $('#log-count').textContent = `(${rows.length})`;
  const tb = $('#log-body');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-slate-400">없음</td></tr>'; return; }
  tb.innerHTML = rows.map((r, i) => {
    const kindBadge = r.kind === 'sale'
      ? '<span class="chip bg-emerald-100 text-emerald-700">판매</span>'
      : `<span class="chip bg-sky-100 text-sky-800">${r.type||'입출고'}</span>`;
    const right = r.memo || '';
    const negative = (Number(r.qty)||0) < 0;
    const isCancel = (r.memo||'').includes('[취소]') || (r.memo||'').includes('[환산]') || (r.memo||'').includes('[취소됨]');
    const cancelBtn = isCancel
      ? '<span class="text-xs text-slate-300">완료</span>'
      : `<button data-cancel-i="${i}" class="text-xs px-2 py-1 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100" title="이 항목을 취소(반대 기록 추가)">✕ 취소</button>`;
    return `<tr class="border-t border-slate-100 ${negative?'opacity-70':''}">
      <td class="px-3 py-2 text-slate-500 font-mono text-xs">${r.datetime||''}</td>
      <td class="px-3 py-2">${kindBadge}</td>
      <td class="px-3 py-2"><div class="font-medium">${r.name||''}</div><div class="text-xs text-slate-400">${r.productId||''}</div></td>
      <td class="px-3 py-2 text-center">${unitLabel(r.unit)}</td>
      <td class="px-3 py-2 text-center font-mono ${negative?'text-rose-600':''}">${r.qty}</td>
      <td class="px-3 py-2 text-right text-slate-600">${right}</td>
      <td class="px-3 py-2 text-center">${cancelBtn}</td>
    </tr>`;
  }).join('');
  // 취소 버튼 핸들러 (중복 클릭 방지)
  $$('button[data-cancel-i]', tb).forEach(b => {
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      const idx = +b.dataset.cancelI;
      const r = rows[idx];
      if (!r) return;
      if (!confirm(`이 ${r.kind==='sale'?'판매':'입출고'} 기록을 취소하시겠습니까?\n\n${r.name} · ${unitLabel(r.unit)} ${r.qty}개\n\n※ 원본은 보존되고, 반대 기록이 추가됩니다.`)) return;
      // 즉시 비활성화 — 응답 오기 전 추가 클릭 차단
      b.disabled = true;
      b.textContent = '처리중…';
      b.classList.remove('hover:bg-rose-100');
      b.classList.add('opacity-50', 'cursor-not-allowed');
      try {
        await api('/api/cancel', { method: 'POST', body: {
          kind: r.kind, productId: r.productId, datetime: r.datetime,
          unit: r.unit, qty: r.qty, type: r.type, memo: r.memo,
        }});
        toast('취소 처리됨');
        state.sales = []; state.inout = [];
        await loadStock(true); await loadLog();
      } catch (e) {
        toast('취소 실패: '+e.message, 'err');
        // 실패 시 다시 활성화
        b.disabled = false;
        b.textContent = '✕ 취소';
        b.classList.add('hover:bg-rose-100');
        b.classList.remove('opacity-50', 'cursor-not-allowed');
      }
    });
  });
}
$('#log-kind').addEventListener('change', renderLog);
$('#log-q').addEventListener('input', renderLog);
$('#log-refresh').addEventListener('click', loadLog);

// ===== 대시보드 (월별 + 상품별 7일 스파크라인) =====
async function ensureSales() {
  if (!state.sales.length) state.sales = await api('/api/sales');
}
async function loadDashboard() {
  try {
    if (!$('#dash-month').value) $('#dash-month').value = monthKR();
    await ensureSales();
    renderDashboard();
  } catch (e) { toast(e.message, 'err'); }
}

function getLast7Days() {
  // KST 기준 최근 7일 (오늘 포함, 오래된 순)
  const days = [];
  const today = new Date(Date.now() + 9*3600*1000);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
    days.push(d.toISOString().slice(0,10));
  }
  return days;
}

function renderDashboard() {
  const month = $('#dash-month').value || monthKR();
  const q = ($('#dash-q').value||'').trim().toLowerCase();
  const maker = $('#dash-maker').value;
  const activeOnly = $('#dash-active').checked;
  const days = getLast7Days();
  const today = days[6];
  const weekStart = days[0];

  // 상품별 집계: 7일 일별 + 월합
  const byProd = {};
  state.products.forEach(p => {
    byProd[p.id] = { id: p.id, name: p.name, maker: p.maker, discontinued: p.discontinued,
      daily: Object.fromEntries(days.map(d => [d, 0])), week7: 0, monthQty: 0 };
  });
  let monthQty = 0, weekQty = 0, todayQty = 0;
  state.sales.forEach(s => {
    const day = (s.datetime||'').slice(0,10);
    const units = (s.unit === '보루' ? s.qty * 10 : s.qty);
    if (day && day.startsWith(month)) monthQty += units;
    if (day >= weekStart) weekQty += units;
    if (day === today) todayQty += units;
    const r = byProd[s.productId]; if (!r) return;
    if (day && day.startsWith(month)) r.monthQty += units;
    if (r.daily[day] !== undefined) { r.daily[day] += units; r.week7 += units; }
  });

  // KPI (금액 → 갑수 표시)
  const fmtQty = (n) => (Number(n)||0).toLocaleString('ko-KR') + '갑';
  $('#dash-kpi-month').textContent = fmtQty(monthQty);
  $('#dash-kpi-week').textContent = fmtQty(weekQty);
  $('#dash-kpi-today').textContent = fmtQty(todayQty);
  const lowCount = state.stock.filter(s => s.lowStock && !s.discontinued).length;
  $('#dash-kpi-low').textContent = lowCount;

  // 행 데이터: products + 현재고 합치기
  const stockMap = Object.fromEntries(state.stock.map(s => [s.id, s]));
  let list = state.products.slice();
  if (activeOnly) list = list.filter(p => !p.discontinued);
  if (maker) list = list.filter(p => p.maker === maker);
  if (q) list = list.filter(p =>
    (p.name||'').toLowerCase().includes(q) ||
    (p.maker||'').toLowerCase().includes(q));

  // 정렬: 7일 판매량 내림차순
  list.sort((a,b) => (byProd[b.id]?.week7||0) - (byProd[a.id]?.week7||0) || (a.name||'').localeCompare(b.name||'','ko'));

  const tb = $('#dash-body');
  if (!list.length) { tb.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400">조건에 맞는 상품이 없습니다</td></tr>'; return; }

  // 스파크라인 최대값 계산 (전체 행 공통)
  let dailyMax = 1;
  list.forEach(p => { const r = byProd[p.id]; if (!r) return; days.forEach(d => { if (r.daily[d] > dailyMax) dailyMax = r.daily[d]; }); });

  tb.innerHTML = list.map(p => {
    const r = byProd[p.id] || { daily: {}, week7: 0, monthQty: 0 };
    const s = stockMap[p.id] || { stockSingle:0, stockCarton:0, lowStock:false, discontinued:p.discontinued };
    const sparkBars = days.map((d,i) => {
      const v = r.daily[d] || 0;
      const h = Math.max(2, Math.round((v / dailyMax) * 22));
      const isToday = (i === 6);
      return `<span class="${isToday?'today':''}" style="height:${h}px" title="${d}: ${v}갑"></span>`;
    }).join('');
    const carton = s.stockCarton||0;
    const single = s.stockSingle||0;
    const lowCls = s.lowStock ? 'text-amber-700 font-semibold' : '';
    const opacity = p.discontinued ? 'opacity-50' : '';
    return `<tr class="border-t border-slate-100 ${opacity}">
      <td class="px-3 py-2"><div class="font-medium">${p.name}</div><div class="text-xs text-slate-400">${p.id}</div></td>
      <td class="px-3 py-2 text-slate-600">${p.maker||''}</td>
      <td class="px-3 py-2 text-center"><div class="spark mx-auto">${sparkBars}</div></td>
      <td class="px-3 py-2 text-center font-mono ${r.week7>0?'text-emerald-700 font-semibold':'text-slate-400'}">${r.week7}</td>
      <td class="px-3 py-2 text-center font-mono ${r.monthQty>0?'text-sky-700 font-semibold':'text-slate-400'}">${r.monthQty}</td>
      <td class="px-3 py-2 text-center col-pack font-mono ${lowCls}">${single}</td>
      <td class="px-3 py-2 text-center col-carton font-mono ${lowCls}">${carton}</td>
    </tr>`;
  }).join('');
}
['#dash-month','#dash-q','#dash-maker','#dash-active'].forEach(s => {
  $(s).addEventListener('input', renderDashboard);
  $(s).addEventListener('change', renderDashboard);
});

// ===== CSV 업로드 =====
function csvTemplate() {
  return '일시,바코드,단위,수량,메모\n' +
         `${todayKR()} 09:00:00,8801116001234,단일,3,예시\n` +
         `${todayKR()} 09:05:00,8801116001241,보루,1,\n`;
}
$('#csv-template').addEventListener('click', (e) => {
  const blob = new Blob(['\ufeff'+csvTemplate()], { type:'text/csv;charset=utf-8' });
  e.target.href = URL.createObjectURL(blob);
});
$('#csv-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  $('#csv-text').value = await f.text();
});
$('#csv-preview').addEventListener('click', () => {
  const csv = $('#csv-text').value.trim();
  if (!csv) return toast('CSV가 비어 있습니다', 'warn');
  const lines = csv.split(/\r?\n/);
  const header = lines[0].split(',');
  const sample = lines.slice(1, 6);
  $('#csv-result').innerHTML = `
    <div class="p-3 bg-slate-50 rounded-xl border border-slate-200">
      <div class="text-slate-600 mb-1">헤더: <code>${header.join(' | ')}</code></div>
      <div class="text-slate-500">총 ${lines.length-1}행 · 미리보기 5행:</div>
      <pre class="text-xs mt-1 whitespace-pre-wrap">${sample.join('\n')}</pre>
    </div>`;
});
$('#csv-upload').addEventListener('click', async () => {
  const csv = $('#csv-text').value.trim();
  if (!csv) return toast('CSV가 비어 있습니다', 'warn');
  try {
    const r = await api('/api/sales/bulk-csv', { method:'POST', body: { csv, source: 'csv' } });
    const errs = (r.errors||[]);
    $('#csv-result').innerHTML = `
      <div class="p-3 rounded-xl ${errs.length?'bg-amber-50 border-amber-200':'bg-emerald-50 border-emerald-200'} border">
        <div class="font-semibold">${r.count||0}건 업로드 완료</div>
        ${errs.length ? `<div class="mt-2 text-sm text-amber-800">오류 ${errs.length}건:<pre class="text-xs mt-1 whitespace-pre-wrap">${errs.slice(0,20).map(e=>`L${e.line}: ${e.error} ${e.barcode||''}`).join('\n')}</pre></div>` : ''}
      </div>`;
    toast(`${r.count||0}건 업로드`);
    state.sales = []; state.inout = [];
    await loadStock(true);
  } catch (e) {
    $('#csv-result').innerHTML = `<div class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700">실패: ${e.message}</div>`;
  }
});

// ===== 바코드 스캐너 =====
let scannerControls = null;
$('#btn-scan').addEventListener('click', async () => {
  $('#scanner-modal').classList.remove('hidden');
  $('#scanner-modal').classList.add('flex');
  try {
    const reader = new ZXingBrowser.BrowserMultiFormatReader();
    const devices = await ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
    const back = devices.find(d => /back|rear|environment/i.test(d.label)) || devices[0];
    scannerControls = await reader.decodeFromVideoDevice(back?.deviceId, $('#scanner-video'), (result, err, controls) => {
      if (result) {
        const code = result.getText();
        controls.stop(); scannerControls = null;
        $('#scanner-modal').classList.add('hidden'); $('#scanner-modal').classList.remove('flex');
        const exact = state.products.find(p => p.barcodeSingle === code || p.barcodeCarton === code);
        if (exact) {
          const unit = exact.barcodeSingle === code ? '단일' : '보루';
          $('#sale-unit').value = unit;
          selectSale(exact, unit);
          toast(`스캔: ${exact.name}`);
        } else {
          $('#sale-search').value = code;
          toast('상품을 찾지 못했습니다: ' + code, 'warn');
        }
      }
    });
  } catch (e) { toast('카메라 오류: '+e.message, 'err'); }
});
$('#scanner-close').addEventListener('click', () => {
  if (scannerControls) { scannerControls.stop(); scannerControls = null; }
  $('#scanner-modal').classList.add('hidden'); $('#scanner-modal').classList.remove('flex');
});

// 외부 클릭 시 추천 닫기
document.addEventListener('click', (e) => {
  if (!e.target.closest('#sale-search') && !e.target.closest('#sale-suggest')) $('#sale-suggest').classList.add('hidden');
  if (!e.target.closest('#io-search') && !e.target.closest('#io-suggest')) $('#io-suggest').classList.add('hidden');
});

// ===== 신규 담배 등록 + 제조사 옵션 =====
function fillMakerOptions() {
  const makers = Array.from(new Set(state.products.map(p => (p.maker||'').trim()).filter(Boolean))).sort();
  const dl = $('#maker-list');
  if (dl) dl.innerHTML = makers.map(m => '<option value="' + m + '">').join('');
  ['#stock-maker','#dash-maker'].forEach(sel => {
    const el = $(sel); if (!el) return;
    const cur = el.value;
    el.innerHTML = '<option value="">전체</option>' + makers.map(m => '<option value="' + m + '">' + m + '</option>').join('');
    if (cur) el.value = cur;
  });
}

const newProductBtn = $('#new-submit');
if (newProductBtn) newProductBtn.addEventListener('click', async () => {
  const body = {
    id: $('#new-id').value.trim(),
    name: $('#new-name').value.trim(),
    maker: $('#new-maker').value.trim(),
    barcodeSingle: $('#new-barcode-single').value.trim(),
    barcodeCarton: $('#new-barcode-carton').value.trim(),
    priceSingle: Number($('#new-price-single').value)||0,
    priceCarton: Number($('#new-price-carton').value)||0,
    safetyStockCarton: Number($('#new-safety').value)||1,
    initialSingle: Number($('#new-init-single').value)||0,
    initialCarton: Number($('#new-init-carton').value)||0,
    note: $('#new-note').value.trim(),
  };
  if (!body.name) {
    $('#new-result').innerHTML = '<div class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700">상품명을 입력하세요</div>';
    return;
  }
  try {
    newProductBtn.disabled = true; newProductBtn.textContent = '등록 중…';
    const r = await api('/api/products', { method: 'POST', body });
    $('#new-result').innerHTML = '<div class="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800"><b>' + r.name + '</b> (ID: ' + r.id + ') 등록 완료</div>';
    toast('신규 담배 등록 완료: ' + r.name);
    ['new-id','new-name','new-barcode-single','new-barcode-carton','new-price-single','new-price-carton','new-note'].forEach(id => $('#'+id).value = '');
    $('#new-init-single').value = '0'; $('#new-init-carton').value = '0'; $('#new-safety').value = '1';
    await loadProducts(true); await loadStock(true);
  } catch (e) {
    $('#new-result').innerHTML = '<div class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700">실패: ' + e.message + '</div>';
  } finally {
    newProductBtn.disabled = false; newProductBtn.textContent = '신규 담배 등록';
  }
});

// ===== 상품 편집 모달 =====
const editModal = $('#edit-modal');
const editListView = $('#edit-list-view');
const editFormView = $('#edit-form-view');
const editFormActions = $('#edit-form-actions');
const editModalTitle = $('#edit-modal-title');

function openEditModal() {
  if (!editModal) return;
  editModal.classList.remove('hidden'); editModal.classList.add('flex');
  showEditListView(); renderEditList('');
  setTimeout(() => { const s = $('#edit-search'); if (s) { s.value = ''; s.focus(); } }, 30);
}
function closeEditModal() {
  if (!editModal) return;
  editModal.classList.add('hidden'); editModal.classList.remove('flex');
}
function showEditListView() {
  editListView.classList.remove('hidden');
  editFormView.classList.add('hidden');
  editFormActions.classList.add('hidden');
  editModalTitle.textContent = '상품 편집 — 수정할 상품을 선택하세요';
}
function showEditFormView(name) {
  editListView.classList.add('hidden');
  editFormView.classList.remove('hidden');
  editFormActions.classList.remove('hidden');
  editModalTitle.textContent = '상품 편집 — ' + (name || '');
}
function renderEditList(q) {
  const list = $('#edit-list');
  if (!list) return;
  const query = (q||'').trim().toLowerCase();
  let items = state.products.slice();
  if (query) {
    items = items.filter(p =>
      (p.name||'').toLowerCase().includes(query) ||
      (p.maker||'').toLowerCase().includes(query) ||
      (p.barcodeSingle||'').includes(query) ||
      (p.barcodeCarton||'').includes(query) ||
      (p.id||'').toLowerCase().includes(query)
    );
  }
  items.sort((a,b) => (a.name||'').localeCompare(b.name||'', 'ko'));
  if (!items.length) {
    list.innerHTML = '<div class="p-6 text-center text-slate-400 text-sm">검색 결과가 없습니다</div>';
    return;
  }
  list.innerHTML = items.map(p => {
    const tags = [];
    if (p.discontinued) tags.push('<span class="text-xs px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">단종</span>');
    return '<button type="button" data-edit-id="' + p.id + '" class="w-full text-left px-4 py-3 hover:bg-slate-50 flex items-center gap-3">' +
      '<div class="flex-1 min-w-0">' +
        '<div class="font-medium text-slate-900 truncate">' + (p.name||'') + ' ' + tags.join(' ') + '</div>' +
        '<div class="text-xs text-slate-500 mt-0.5">' +
          (p.maker ? p.maker + ' · ' : '') + 'ID ' + (p.id||'') +
          (p.priceCarton ? ' · 보루 ₩' + Number(p.priceCarton).toLocaleString() : '') +
          ' · 안전 ' + (p.safetyStockCarton||1) + '보루' +
        '</div>' +
      '</div>' +
      '<span class="text-slate-300">›</span>' +
    '</button>';
  }).join('');
}

let editingId = null;
function loadEditForm(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  $('#edit-id').value = p.id || '';
  $('#edit-name').value = p.name || '';
  $('#edit-maker').value = p.maker || '';
  $('#edit-safety').value = p.safetyStockCarton != null ? p.safetyStockCarton : 1;
  $('#edit-discontinued').checked = !!p.discontinued;
  $('#edit-bc-single').value = p.barcodeSingle || '';
  $('#edit-bc-carton').value = p.barcodeCarton || '';
  $('#edit-price-single').value = p.priceSingle || 0;
  $('#edit-price-carton').value = p.priceCarton || 0;
  $('#edit-note').value = p.note || '';
  $('#edit-result').innerHTML = '';
  showEditFormView(p.name);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit-row]');
  if (!btn) return;
  const id = btn.getAttribute('data-edit-row');
  if (!id || !editModal) return;
  editModal.classList.remove('hidden'); editModal.classList.add('flex');
  loadEditForm(id);
});

$('#edit-close')?.addEventListener('click', closeEditModal);
$('#edit-cancel')?.addEventListener('click', () => { showEditListView(); editingId = null; });
$('#edit-back')?.addEventListener('click', () => { showEditListView(); editingId = null; });
editModal?.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });
$('#edit-search')?.addEventListener('input', (e) => renderEditList(e.target.value));
$('#edit-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit-id]');
  if (!btn) return;
  loadEditForm(btn.getAttribute('data-edit-id'));
});
$('#edit-save')?.addEventListener('click', async () => {
  if (!editingId) return;
  const body = {
    name: $('#edit-name').value.trim(),
    maker: $('#edit-maker').value.trim(),
    safetyStockCarton: Number($('#edit-safety').value) || 0,
    discontinued: $('#edit-discontinued').checked,
    barcodeSingle: $('#edit-bc-single').value.trim(),
    barcodeCarton: $('#edit-bc-carton').value.trim(),
    priceSingle: Number($('#edit-price-single').value) || 0,
    priceCarton: Number($('#edit-price-carton').value) || 0,
    note: $('#edit-note').value.trim(),
  };
  if (!body.name) {
    $('#edit-result').innerHTML = '<div class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700">상품명은 비워둘 수 없습니다</div>';
    return;
  }
  const saveBtn = $('#edit-save');
  try {
    saveBtn.disabled = true; saveBtn.textContent = '저장 중…';
    const r = await api('/api/products/' + encodeURIComponent(editingId), { method: 'PATCH', body });
    toast('저장됨: ' + r.name);
    await loadProducts(true); await loadStock(true);
    editingId = null; closeEditModal();
  } catch (e) {
    $('#edit-result').innerHTML = '<div class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700">실패: ' + e.message + '</div>';
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = '저장';
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (editModal && !editModal.classList.contains('hidden')) closeEditModal();
    if (settingsModal && !settingsModal.classList.contains('hidden')) closeSettings();
  }
});

// ===== 초기 로드 =====
(async function init() {
  try {
    await loadHealth();
    await loadProducts();
    await loadStock();
    setStockMode('list');
    // 초기 탭은 대시보드 (HTML 기본 aria-selected)
    const initialTab = $('.tab-btn[aria-selected="true"]')?.dataset.tab;
    if (initialTab === 'dash') loadDashboard();
  } catch (e) {
    toast('초기화 오류: '+e.message, 'err');
  }
})();
