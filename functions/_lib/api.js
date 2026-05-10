// Tobacco2026 Cloudflare Worker — /api/* 백엔드
// 정적 자산은 Cloudflare Pages가 서빙. 이 Worker는 API 라우트만 처리.

import { valuesGet, valuesAppend, valuesUpdate, getAuthInfo } from './sheets.js';

const SHEET_MASTER = '앱_상품마스터';
const SHEET_SALES = '앱_판매기록';
const SHEET_INOUT = '앱_입출고';
const BORU = 10;

// ===== 유틸 =====
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });

const err = (msg, status = 500) => json({ error: msg }, status);

// 한국 시간(KST) 타임스탬프 'YYYY-MM-DD HH:MM:SS'
function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function spreadsheetId(env) {
  return env.SPREADSHEET_ID || '1Bfzg3V3GwprCaBUtZuHREWwdxnwR72nAxBBjQ_ZjrFw';
}

// ===== 캐시 (Worker 인스턴스 동안 유지) =====
let cache = { master: null, masterAt: 0 };
const CACHE_TTL = 60 * 1000;

async function getMaster(env, force = false) {
  if (!force && cache.master && Date.now() - cache.masterAt < CACHE_TTL) return cache.master;
  const sid = spreadsheetId(env);
  const res = await valuesGet(env, sid, `${SHEET_MASTER}!A2:L1000`);
  const rows = res.values || [];
  const master = rows.filter((r) => r[0]).map((r) => ({
    id: r[0], name: r[1], maker: r[2],
    barcodeSingle: r[3], barcodeCarton: r[4],
    priceSingle: parseInt(r[5]) || 0,
    priceCarton: parseInt(r[6]) || 0,
    safetyStockCarton: parseInt(r[7]) || 1,
    discontinued: r[8] === 'Y',
    note: r[9] || '',
    initialSingle: parseInt(r[10]) || 0,
    initialCarton: parseInt(r[11]) || 0,
  }));
  cache.master = master;
  cache.masterAt = Date.now();
  return master;
}

async function getSalesAll(env) {
  const res = await valuesGet(env, spreadsheetId(env), `${SHEET_SALES}!A2:I10000`);
  return (res.values || []).filter((r) => r[0]).map((r) => ({
    datetime: r[0], productId: r[1], name: r[2], unit: r[3],
    qty: parseInt(r[4]) || 0,
    unitPrice: parseInt(r[5]) || 0,
    amount: parseInt(r[6]) || 0,
    memo: r[7] || '', source: r[8] || '',
  }));
}

async function getInoutAll(env) {
  const res = await valuesGet(env, spreadsheetId(env), `${SHEET_INOUT}!A2:G10000`);
  return (res.values || []).filter((r) => r[0]).map((r) => ({
    datetime: r[0], productId: r[1], name: r[2], type: r[3],
    unit: r[4], qty: parseInt(r[5]) || 0, memo: r[6] || '',
  }));
}

async function getStockSummary(env) {
  const [master, sales, inout] = await Promise.all([getMaster(env), getSalesAll(env), getInoutAll(env)]);
  const map = {};
  for (const m of master) {
    map[m.id] = { ...m, stockUnits: m.initialCarton * BORU + m.initialSingle, sold: 0, in: 0, adj: 0 };
  }
  for (const s of sales) {
    if (!map[s.productId]) continue;
    const units = s.unit === '보루' ? s.qty * BORU : s.qty;
    map[s.productId].stockUnits -= units;
    map[s.productId].sold += units;
  }
  for (const i of inout) {
    if (!map[i.productId]) continue;
    const units = i.unit === '보루' ? i.qty * BORU : i.qty;
    if (i.type === '입고') { map[i.productId].stockUnits += units; map[i.productId].in += units; }
    else if (i.type === '반품' || i.type === '출고조정') { map[i.productId].stockUnits -= units; map[i.productId].adj -= units; }
    else if (i.type === '재고조정') { map[i.productId].stockUnits += units; map[i.productId].adj += units; }
  }
  return Object.values(map).map((p) => {
    const carton = Math.floor(p.stockUnits / BORU);
    const single = p.stockUnits - carton * BORU;
    const lowStock = carton < (p.safetyStockCarton || 1);
    return {
      id: p.id, name: p.name, maker: p.maker,
      barcodeSingle: p.barcodeSingle, barcodeCarton: p.barcodeCarton,
      priceSingle: p.priceSingle, priceCarton: p.priceCarton,
      safetyStockCarton: p.safetyStockCarton,
      discontinued: p.discontinued, note: p.note,
      stockSingle: single, stockCarton: carton, stockUnits: p.stockUnits,
      lowStock, sold: p.sold, inQty: p.in, adj: p.adj,
    };
  });
}

// ===== 라우트 핸들러 =====

async function handleHealth(env) {
  const auth = getAuthInfo(env);
  return json({
    ok: true,
    spreadsheetId: spreadsheetId(env),
    auth: auth.kind === 'service-account' ? 'service-account' : (auth.kind === 'none' ? 'none' : `invalid: ${auth.error || ''}`),
    time: new Date().toISOString(),
    runtime: 'cloudflare-workers',
  });
}

async function handleProductsGet(env, url) {
  const force = url.searchParams.get('force') === '1';
  return json(await getMaster(env, force));
}

async function handleProductsPost(env, body) {
  const sid = spreadsheetId(env);
  const b = body || {};
  const name = (b.name || '').trim();
  if (!name) return err('상품명 필수', 400);
  const master = await getMaster(env, true);
  const nameKey = name.toLowerCase();
  if (master.find((m) => (m.name || '').toLowerCase() === nameKey)) {
    return err('같은 이름의 상품이 이미 있습니다: ' + name, 409);
  }
  let id = (b.id || '').trim();
  if (!id) {
    let maxN = 0;
    master.forEach((m) => { const mt = /^P(\d+)$/i.exec(m.id || ''); if (mt) maxN = Math.max(maxN, parseInt(mt[1])); });
    id = 'P' + String(maxN + 1).padStart(3, '0');
  } else if (master.find((m) => (m.id || '').toLowerCase() === id.toLowerCase())) {
    return err('같은 상품ID가 이미 있습니다: ' + id, 409);
  }
  const bcS = (b.barcodeSingle || '').trim();
  const bcC = (b.barcodeCarton || '').trim();
  if (bcS && master.find((m) => m.barcodeSingle === bcS || m.barcodeCarton === bcS)) {
    return err('낱개 바코드가 이미 사용 중: ' + bcS, 409);
  }
  if (bcC && master.find((m) => m.barcodeSingle === bcC || m.barcodeCarton === bcC)) {
    return err('보루 바코드가 이미 사용 중: ' + bcC, 409);
  }
  const row = [
    id, name, (b.maker || '').trim(),
    bcS, bcC,
    parseInt(b.priceSingle) || 0,
    parseInt(b.priceCarton) || 0,
    parseInt(b.safetyStockCarton) || 1,
    b.discontinued === true || b.discontinued === 'Y' ? 'Y' : '',
    (b.note || '').trim(),
    parseInt(b.initialSingle) || 0,
    parseInt(b.initialCarton) || 0,
  ];
  await valuesAppend(env, sid, `${SHEET_MASTER}!A:L`, [row]);
  cache.master = null;
  return json({ ok: true, id, name });
}

async function handleProductPatch(env, productId, body) {
  const sid = spreadsheetId(env);
  const id = (productId || '').trim();
  if (!id) return err('상품ID 필수', 400);
  const b = body || {};
  const masterRes = await valuesGet(env, sid, `${SHEET_MASTER}!A2:L1000`);
  const rows = masterRes.values || [];
  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) if ((rows[i][0] || '').trim() === id) { rowIndex = i; break; }
  if (rowIndex < 0) return err('상품을 찾을 수 없음: ' + id, 404);
  const cur = rows[rowIndex];
  const name = (b.name !== undefined ? String(b.name) : cur[1] || '').trim();
  if (!name) return err('상품명 필수', 400);
  const bcS = (b.barcodeSingle !== undefined ? String(b.barcodeSingle) : cur[3] || '').trim();
  const bcC = (b.barcodeCarton !== undefined ? String(b.barcodeCarton) : cur[4] || '').trim();
  for (let i = 0; i < rows.length; i++) {
    if (i === rowIndex) continue;
    const otherS = (rows[i][3] || '').trim();
    const otherC = (rows[i][4] || '').trim();
    if (bcS && (otherS === bcS || otherC === bcS)) return err('낱개 바코드 중복: ' + bcS, 409);
    if (bcC && (otherS === bcC || otherC === bcC)) return err('보루 바코드 중복: ' + bcC, 409);
  }
  const newRow = [
    id, name,
    (b.maker !== undefined ? String(b.maker) : cur[2] || '').trim(),
    bcS, bcC,
    b.priceSingle !== undefined ? (parseInt(b.priceSingle) || 0) : (parseInt(cur[5]) || 0),
    b.priceCarton !== undefined ? (parseInt(b.priceCarton) || 0) : (parseInt(cur[6]) || 0),
    b.safetyStockCarton !== undefined ? (parseInt(b.safetyStockCarton) || 0) : (parseInt(cur[7]) || 1),
    b.discontinued !== undefined ? (b.discontinued === true || b.discontinued === 'Y' ? 'Y' : '') : (cur[8] || ''),
    (b.note !== undefined ? String(b.note) : cur[9] || '').trim(),
    cur[10] !== undefined ? cur[10] : 0,
    cur[11] !== undefined ? cur[11] : 0,
  ];
  const sheetRow = rowIndex + 2;
  await valuesUpdate(env, sid, `${SHEET_MASTER}!A${sheetRow}:L${sheetRow}`, [newRow]);
  cache.master = null;
  return json({ ok: true, id, name });
}

async function handleProductLookup(env, url) {
  const q = (url.searchParams.get('barcode') || '').trim();
  if (!q) return err('barcode required', 400);
  const master = await getMaster(env);
  const found = master.find((p) => p.barcodeSingle === q || p.barcodeCarton === q);
  if (!found) return err('not found: ' + q, 404);
  const unit = found.barcodeSingle === q ? '단일' : '보루';
  return json({ ...found, matchedUnit: unit });
}

async function handleStockGet(env) {
  return json(await getStockSummary(env));
}

async function appendSales(env, items) {
  const sid = spreadsheetId(env);
  const master = await getMaster(env);
  const masterMap = Object.fromEntries(master.map((m) => [m.id, m]));
  const ts = kstNow();
  const rows = [];
  for (const it of items) {
    const m = masterMap[it.productId];
    if (!m) throw new Error(`상품ID 없음: ${it.productId}`);
    const unit = it.unit === '보루' ? '보루' : '단일';
    const qty = parseInt(it.qty) || 0;
    if (qty <= 0) throw new Error('수량은 1 이상');
    const unitPrice = unit === '보루' ? m.priceCarton : m.priceSingle;
    const amount = unitPrice * qty;
    rows.push([
      it.datetime || ts,
      m.id, m.name, unit, qty, unitPrice, amount,
      it.memo || '', it.source || 'web',
    ]);
  }
  await valuesAppend(env, sid, `${SHEET_SALES}!A:I`, rows);

  // 갑 자동 보충
  let autoConvertCount = 0;
  try {
    const stock = await getStockSummary(env);
    const affectedIds = new Set(items.map((it) => it.productId));
    const autoRows = [];
    for (const s of stock) {
      if (!affectedIds.has(s.id)) continue;
      let single = s.stockSingle;
      let carton = s.stockCarton;
      let safety = 0;
      while (single <= 0 && carton > 0 && safety < 100) {
        autoRows.push([ts, s.id, s.name, '재고조정', '보루', -1, '[자동환산] 갑 부족분 자동변환']);
        autoRows.push([ts, s.id, s.name, '재고조정', '단일', 10, '[자동환산] 보루 1개 풀어 갑 +10']);
        carton -= 1; single += 10;
        safety++; autoConvertCount++;
      }
    }
    if (autoRows.length) await valuesAppend(env, sid, `${SHEET_INOUT}!A:G`, autoRows);
  } catch (autoErr) {
    console.error('자동 환산 처리 오류:', autoErr.message);
  }

  return { ok: true, count: rows.length, autoConvert: autoConvertCount };
}

async function handleSalesPost(env, body) {
  try {
    const items = Array.isArray(body) ? body : [body];
    const result = await appendSales(env, items);
    return json(result);
  } catch (e) {
    return err(e.message, e.message.startsWith('상품ID') || e.message.startsWith('수량') ? 400 : 500);
  }
}

async function handleInoutPost(env, body) {
  const sid = spreadsheetId(env);
  const items = Array.isArray(body) ? body : [body];
  const master = await getMaster(env);
  const masterMap = Object.fromEntries(master.map((m) => [m.id, m]));
  const ts = kstNow();
  const rows = [];
  for (const it of items) {
    const m = masterMap[it.productId];
    if (!m) return err(`상품ID 없음: ${it.productId}`, 400);
    const type = it.type || '입고';
    const unit = it.unit === '보루' ? '보루' : '단일';
    const qty = parseInt(it.qty) || 0;
    rows.push([it.datetime || ts, m.id, m.name, type, unit, qty, it.memo || '']);
  }
  await valuesAppend(env, sid, `${SHEET_INOUT}!A:G`, rows);
  return json({ ok: true, count: rows.length });
}

async function handleSalesGet(env, url) {
  const all = await getSalesAll(env);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const productId = url.searchParams.get('productId');
  let out = all;
  if (from) out = out.filter((s) => s.datetime >= from);
  if (to) out = out.filter((s) => s.datetime <= to + ' 23:59:59');
  if (productId) out = out.filter((s) => s.productId === productId);
  return json(out);
}

async function handleInoutGet(env) {
  return json(await getInoutAll(env));
}

async function handleDashboard(env) {
  const sales = await getSalesAll(env);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayKr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const weekKey = fmt(weekAgo);
  const monthKey = fmt(monthStart);

  let dToday = 0, dWeek = 0, dMonth = 0;
  let cToday = 0, cWeek = 0, cMonth = 0;
  const productAgg = {};
  for (const s of sales) {
    const day = (s.datetime || '').slice(0, 10);
    if (day === todayKr) { dToday += s.amount; cToday += s.qty; }
    if (day >= weekKey) { dWeek += s.amount; cWeek += s.qty; }
    if (day >= monthKey) { dMonth += s.amount; cMonth += s.qty; }
    if (!productAgg[s.productId]) productAgg[s.productId] = { id: s.productId, name: s.name, qtyUnits: 0, amount: 0 };
    productAgg[s.productId].qtyUnits += (s.unit === '보루' ? s.qty * 10 : s.qty);
    productAgg[s.productId].amount += s.amount;
  }
  const top = Object.values(productAgg).sort((a, b) => b.qtyUnits - a.qtyUnits).slice(0, 10);

  const dailyMap = {};
  for (let i = 13; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); dailyMap[fmt(d)] = { date: fmt(d), amount: 0, qty: 0 }; }
  for (const s of sales) { const day = (s.datetime || '').slice(0, 10); if (dailyMap[day]) { dailyMap[day].amount += s.amount; dailyMap[day].qty += s.qty; } }

  return json({
    today: { amount: dToday, qty: cToday },
    week: { amount: dWeek, qty: cWeek },
    month: { amount: dMonth, qty: cMonth },
    topProducts: top,
    daily: Object.values(dailyMap),
  });
}

async function handleBulkCsv(env, body) {
  try {
    const { csv, source } = body || {};
    if (!csv) return err('csv required', 400);
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].split(',').map((s) => s.trim());
    const idx = (k) => header.findIndex((h) => h === k);
    const iDate = idx('일시') >= 0 ? idx('일시') : idx('일자');
    const iBarcode = idx('바코드');
    const iUnit = idx('단위');
    const iQty = idx('수량');
    const iMemo = idx('메모');
    if (iBarcode < 0 || iQty < 0) return err('헤더에 바코드, 수량 필수', 400);
    const master = await getMaster(env);
    const byBarcode = {};
    for (const m of master) {
      if (m.barcodeSingle) byBarcode[m.barcodeSingle] = { m, unit: '단일' };
      if (m.barcodeCarton) byBarcode[m.barcodeCarton] = { m, unit: '보루' };
    }
    const items = []; const errors = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((s) => s.trim());
      const barcode = cols[iBarcode];
      const found = byBarcode[barcode];
      if (!found) { errors.push({ line: i + 1, barcode, error: '상품 없음' }); continue; }
      const unit = (iUnit >= 0 && cols[iUnit]) ? cols[iUnit] : found.unit;
      const qty = parseInt(cols[iQty]) || 0;
      if (qty <= 0) { errors.push({ line: i + 1, error: '수량 0' }); continue; }
      items.push({
        datetime: iDate >= 0 ? cols[iDate] : undefined,
        productId: found.m.id, unit, qty,
        memo: iMemo >= 0 ? cols[iMemo] : '',
        source: source || 'csv',
      });
    }
    if (items.length === 0) return json({ ok: true, count: 0, errors });
    const result = await appendSales(env, items);
    return json({ ...result, errors });
  } catch (e) { return err(e.message, 500); }
}

async function handleCancel(env, body) {
  try {
    const sid = spreadsheetId(env);
    const b = body || {};
    const kind = b.kind;
    const productId = b.productId;
    if (!productId || !kind) return err('kind, productId 필수', 400);
    const master = await getMaster(env);
    const m = master.find((x) => x.id === productId);
    if (!m) return err('상품ID 없음: ' + productId, 404);
    const ts = kstNow();
    const unit = b.unit === '보루' ? '보루' : '단일';
    const qty = parseInt(b.qty) || 0;
    const origDatetime = b.datetime || '';
    const ref = origDatetime ? `[취소] 원본 ${origDatetime}` : '[취소]';

    if (kind === 'sale') {
      // 1) 원본 행 찾아서 메모(H열)에 [취소됨] 마킹 — 두번 누르기 방지
      const sheetRange = `${SHEET_SALES}!A2:I10000`;
      const cur = await valuesGet(env, sid, sheetRange);
      const rows = cur.values || [];
      let foundIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r[0] === origDatetime && r[1] === productId &&
            r[3] === unit && (parseInt(r[4]) || 0) === qty &&
            !(r[7] || '').includes('[취소됨]')) {
          foundIdx = i; break;
        }
      }
      if (foundIdx >= 0) {
        const r = rows[foundIdx];
        const newMemo = '[취소됨] ' + (r[7] || '');
        const targetRow = foundIdx + 2; // A2 시작이라 +2
        await valuesUpdate(env, sid, `${SHEET_SALES}!H${targetRow}`, [[newMemo]]);
      }
      // 2) 반대 행 추가 (재고/매출 환원용)
      const unitPrice = unit === '보루' ? m.priceCarton : m.priceSingle;
      const row = [ts, m.id, m.name, unit, -qty, unitPrice, -unitPrice * qty, ref, 'cancel'];
      await valuesAppend(env, sid, `${SHEET_SALES}!A:I`, [row]);

    } else if (kind === 'io') {
      // 1) 원본 행 마킹 (입출고는 G열이 메모)
      const sheetRange = `${SHEET_INOUT}!A2:G10000`;
      const cur = await valuesGet(env, sid, sheetRange);
      const rows = cur.values || [];
      const origType = b.type || '';
      let foundIdx = -1;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r[0] === origDatetime && r[1] === productId &&
            r[3] === origType && r[4] === unit && (parseInt(r[5]) || 0) === qty &&
            !(r[6] || '').includes('[취소됨]')) {
          foundIdx = i; break;
        }
      }
      if (foundIdx >= 0) {
        const r = rows[foundIdx];
        const newMemo = '[취소됨] ' + (r[6] || '');
        const targetRow = foundIdx + 2;
        await valuesUpdate(env, sid, `${SHEET_INOUT}!G${targetRow}`, [[newMemo]]);
      }
      // 2) 반대 행 추가
      const type = b.type || '입고';
      const row = [ts, m.id, m.name, type, unit, -qty, ref + (b.memo ? (' · ' + b.memo) : '')];
      await valuesAppend(env, sid, `${SHEET_INOUT}!A:G`, [row]);

    } else {
      return err('kind는 sale 또는 io', 400);
    }
    return json({ ok: true });
  } catch (e) { return err(e.message, 500); }
}

// ===== 메인 fetch 핸들러 =====

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    let body = null;
    if (method === 'POST' || method === 'PATCH') {
      try { body = await request.json(); } catch { body = null; }
    }

    try {
      // /api/products/lookup
      if (method === 'GET' && path === '/api/products/lookup') return await handleProductLookup(env, url);

      // /api/products/:id (PATCH)
      const pm = /^\/api\/products\/([^/]+)$/.exec(path);
      if (pm && method === 'PATCH') return await handleProductPatch(env, decodeURIComponent(pm[1]), body);

      if (path === '/api/health' && method === 'GET') return await handleHealth(env);
      if (path === '/api/products' && method === 'GET') return await handleProductsGet(env, url);
      if (path === '/api/products' && method === 'POST') return await handleProductsPost(env, body);
      if (path === '/api/stock' && method === 'GET') return await handleStockGet(env);
      if (path === '/api/sales' && method === 'GET') return await handleSalesGet(env, url);
      if (path === '/api/sales' && method === 'POST') return await handleSalesPost(env, body);
      if (path === '/api/sales/bulk-csv' && method === 'POST') return await handleBulkCsv(env, body);
      if (path === '/api/inout' && method === 'GET') return await handleInoutGet(env);
      if (path === '/api/inout' && method === 'POST') return await handleInoutPost(env, body);
      if (path === '/api/dashboard' && method === 'GET') return await handleDashboard(env);
      if (path === '/api/cancel' && method === 'POST') return await handleCancel(env, body);

      return err('Not Found: ' + path, 404);
    } catch (e) {
      return err(e.message || String(e), 500);
    }
  },
};
