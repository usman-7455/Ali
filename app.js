/**
 * HieraCost — app.js (v1.5)
 * Deterministic Hierarchical Cost & Inventory Management System
 *
 * FIXED in v1.5 (anomalies only — no logic changes beyond corrections):
 *   ✅ FIX 1: calculate_profit — initial_cost is ISOLATED, weight ratio only applied to total_cost.
 *             initial_cost and processing_cost breakdowns stored as-is (no weight ratio distortion).
 *   ✅ FIX 2: calculate_profit lot case — removed the spurious pairs.unshift() that added
 *             lot-level total_cost on top of item costs, causing double-counting.
 *   ✅ FIX 3: addItem / addSubitem — zero lot initial_cost no longer blocks adding items.
 *             Budget check only fires when lot.initial_cost > 0.
 *   ✅ FIX 4: addItem / addSubitem — zero lot total_weight no longer blocks adding items.
 *             Weight check only fires when lot.total_weight > 0.
 *   ✅ FIX 5: sellEntity — lot.sold_weight only updated by item-level sales, not subitem-level,
 *             preventing double-counting at lot level.
 */
'use strict';

// ============================================================
// DATA STORE
// ============================================================
let DB = {
  trucks: {},
  customers: {},
  mills: {},
  nextId: {
    truck: 1, lot: 1, item: 1, subitem: 1,
    customer: 1, mill: 1
  }
};

function loadDB() {
  try {
    const saved = localStorage.getItem('hieracost_db');
    if (saved) {
      const parsed = JSON.parse(saved);
      DB = migrateWeightFields(parsed);
    }
  } catch (e) { /* ignore */ }
}

function migrateWeightFields(db) {
  for (const truck of Object.values(db.trucks || {})) {
    for (const lot of Object.values(truck.lots || {})) {
      if (lot.weight !== undefined && lot.total_weight === undefined) {
        lot.total_weight = lot.weight;
        lot.sold_weight = 0;
        delete lot.weight;
      }
      for (const item of Object.values(lot.items || {})) {
        if (item.weight !== undefined && item.total_weight === undefined) {
          item.total_weight = item.weight;
          item.sold_weight = 0;
          delete item.weight;
        }
        if (item.sale && !item.sale.total_price) {
          const totalPaid = (item.sale.payments || []).reduce((s, p) => s + (p.amount_paid || 0), 0);
          item.sale.total_price = totalPaid;
        }
        for (const sub of Object.values(item.subitems || {})) {
          if (sub.weight !== undefined && sub.total_weight === undefined) {
            sub.total_weight = sub.weight;
            sub.sold_weight = 0;
            delete sub.weight;
          }
          if (sub.sale && !sub.sale.total_price) {
            const totalPaid = (sub.sale.payments || []).reduce((s, p) => s + (p.amount_paid || 0), 0);
            sub.sale.total_price = totalPaid;
          }
        }
      }
    }
  }
  return db;
}

function saveDB() {
  try {
    localStorage.setItem('hieracost_db', JSON.stringify(DB));
  } catch (e) { /* ignore */ }
}

// ============================================================
// ID GENERATORS
// ============================================================
function genId(type) {
  const id = `${type}_${DB.nextId[type]++}`;
  saveDB();
  return id;
}

// ============================================================
// ENTITY FACTORIES
// ============================================================
function makeTruck(name, description = '') {
  return {
    id: genId('truck'),
    name,
    description,
    lots: {}
  };
}

function makeLot(name, initial_cost = 0, mill_id = null, total_weight = 0) {
  return {
    id: genId('lot'),
    name,
    initial_cost,
    mill_id,
    total_weight: Number(total_weight) || 0,
    sold_weight: 0,
    processing_records: [],
    items: {}
  };
}

function makeItem(name, initial_cost = 0, total_weight = null) {
  return {
    id: genId('item'),
    name,
    initial_cost,
    total_weight: total_weight !== null && total_weight !== '' ? Number(total_weight) : null,
    sold_weight: 0,
    processing_records: [],
    subitems: {},
    sale: null,
    depleted: false
  };
}

function makeSubitem(name, initial_cost = 0, total_weight = null) {
  return {
    id: genId('subitem'),
    name,
    initial_cost,
    total_weight: total_weight !== null && total_weight !== '' ? Number(total_weight) : null,
    sold_weight: 0,
    processing_records: [],
    sale: null,
    depleted: false
  };
}

function makeProcessingRecord(type, worker, labour_fee) {
  return { type, worker, labour_fee: Number(labour_fee) };
}

function makeCustomer(name, phone = '') {
  return { id: genId('customer'), name, phone };
}

function makeMill(name) {
  return { id: genId('mill'), name };
}

// ============================================================
// COST USAGE CALCULATION
// ============================================================
function getCurrentLotInitialUsage(lot) {
  let sum = 0;
  for (const item of Object.values(lot.items || {})) {
    sum += Number(item.initial_cost) || 0;
    for (const sub of Object.values(item.subitems || {})) {
      sum += Number(sub.initial_cost) || 0;
    }
  }
  return sum;
}

// ============================================================
// WEIGHT USAGE CALCULATION
// ============================================================
function getRemainingWeight(entity) {
  if (!entity || entity.total_weight == null) return null;
  return Math.max(0, entity.total_weight - (entity.sold_weight || 0));
}

function getCurrentLotWeightUsage(lot) {
  let used = 0;
  for (const item of Object.values(lot.items || {})) {
    if (item.depleted) continue;
    const subitems = Object.values(item.subitems || {});
    const activeSubs = subitems.filter(s => !s.depleted);
    if (activeSubs.length > 0) {
      for (const sub of activeSubs) {
        used += getRemainingWeight(sub) || 0;
      }
    } else if (!item.depleted && item.total_weight != null) {
      used += getRemainingWeight(item) || 0;
    }
  }
  return used;
}

// ============================================================
// CORE COST CALCULATIONS
// ============================================================
function calculate_subitem(subitem) {
  const processing_cost = subitem.processing_records.reduce(
    (sum, rec) => sum + rec.labour_fee, 0
  );
  const total_cost = subitem.initial_cost + processing_cost;
  return { processing_cost, total_cost, initial_cost: subitem.initial_cost };
}

function calculate_item(item) {
  const own_processing = item.processing_records.reduce(
    (sum, rec) => sum + rec.labour_fee, 0
  );
  let child_processing = 0;
  const subitems = Object.values(item.subitems || {});
  if (subitems.length > 0) {
    for (const sub of subitems) {
      const { processing_cost } = calculate_subitem(sub);
      child_processing += processing_cost;
    }
  }
  const processing_cost = own_processing + child_processing;
  const total_cost = item.initial_cost + processing_cost;
  return { processing_cost, total_cost, initial_cost: item.initial_cost };
}

function calculate_lot(lot) {
  const own_processing = lot.processing_records.reduce(
    (sum, rec) => sum + rec.labour_fee, 0
  );
  let child_processing = 0;
  for (const item of Object.values(lot.items || {})) {
    const { processing_cost } = calculate_item(item);
    child_processing += processing_cost;
  }
  const processing_cost = own_processing + child_processing;
  const total_cost = lot.initial_cost + processing_cost;
  return { processing_cost, total_cost, initial_cost: lot.initial_cost };
}

function calculate_truck(truck) {
  let total_cost = 0;
  for (const lot of Object.values(truck.lots || {})) {
    const { total_cost: lot_tc } = calculate_lot(lot);
    total_cost += lot_tc;
  }
  return { total_cost };
}

// ============================================================
// VALIDATION
// ============================================================
function validate_lot(lot) {
  const items = Object.values(lot.items || {});
  if (items.length === 0) return null;
  let allNonZero = true;
  let expected_sum = 0;
  for (const item of items) {
    if (item.initial_cost === 0) { allNonZero = false; break; }
    expected_sum += item.initial_cost;
    for (const sub of Object.values(item.subitems || {})) {
      if (sub.initial_cost === 0) { allNonZero = false; break; }
      expected_sum += sub.initial_cost;
    }
    if (!allNonZero) break;
  }
  if (!allNonZero) return null;
  if (expected_sum !== lot.initial_cost) {
    return `WARNING: Sum of item/subitem initial costs (${fmt(expected_sum)}) ≠ lot initial cost (${fmt(lot.initial_cost)}).`;
  }
  return null;
}

// ============================================================
// PROFIT CALCULATION
//
// FIX 1: initial_cost is ISOLATED per spec — weight ratio must NOT be
//         applied to initial_cost or processing_cost independently.
//         Weight ratio is only applied to total_cost for the proportional
//         cost basis. Breakdown figures are stored raw for display only.
//
// FIX 2: lot case — the old code pushed a spurious pairs.unshift() entry
//         containing lot.total_cost with empty payments. This inflated
//         total_cost by double-counting lot.initial_cost + lot processing
//         on top of item-level costs that already include those via
//         calculate_lot's upward propagation. Removed entirely.
// ============================================================
function calculate_profit(entityType, entityId, include_pending = true) {
  const pairs = [];

  if (entityType === 'truck') {
    const truck = DB.trucks[entityId];
    if (!truck) return null;
    for (const lot of Object.values(truck.lots)) {
      for (const item of Object.values(lot.items)) {
        if (item.sale?.payments?.length) {
          const { total_cost, initial_cost, processing_cost } = calculate_item(item);
          // FIX 1: weight ratio on total_cost only; initial_cost stays isolated
          const weightRatio = item.total_weight ? item.sold_weight / item.total_weight : 1;
          pairs.push({
            total_cost: total_cost * weightRatio,
            initial_cost: initial_cost,
            processing_cost: processing_cost,
            total_price: item.sale.total_price || 0,
            payments: item.sale.payments,
            include_pending
          });
        }
        for (const sub of Object.values(item.subitems)) {
          if (sub.sale?.payments?.length) {
            const { total_cost, initial_cost, processing_cost } = calculate_subitem(sub);
            const weightRatio = sub.total_weight ? sub.sold_weight / sub.total_weight : 1;
            pairs.push({
              total_cost: total_cost * weightRatio,
              initial_cost: initial_cost,
              processing_cost: processing_cost,
              total_price: sub.sale.total_price || 0,
              payments: sub.sale.payments,
              include_pending
            });
          }
        }
      }
    }

  } else if (entityType === 'lot') {
    const { lot } = findLot(entityId);
    if (!lot) return null;
    // FIX 2: Do NOT push a lot-level pair with pairs.unshift().
    //         Item costs already aggregate everything upward from calculate_lot.
    //         Adding lot.total_cost on top would double-count lot.initial_cost
    //         and lot-level processing records.
    for (const item of Object.values(lot.items)) {
      if (item.sale?.payments?.length) {
        const { total_cost, initial_cost, processing_cost } = calculate_item(item);
        const weightRatio = item.total_weight ? item.sold_weight / item.total_weight : 1;
        pairs.push({
          total_cost: total_cost * weightRatio,
          initial_cost: initial_cost,
          processing_cost: processing_cost,
          total_price: item.sale.total_price || 0,
          payments: item.sale.payments,
          include_pending
        });
      }
      for (const sub of Object.values(item.subitems)) {
        if (sub.sale?.payments?.length) {
          const { total_cost, initial_cost, processing_cost } = calculate_subitem(sub);
          const weightRatio = sub.total_weight ? sub.sold_weight / sub.total_weight : 1;
          pairs.push({
            total_cost: total_cost * weightRatio,
            initial_cost: initial_cost,
            processing_cost: processing_cost,
            total_price: sub.sale.total_price || 0,
            payments: sub.sale.payments,
            include_pending
          });
        }
      }
    }

  } else if (entityType === 'item') {
    const { item } = findItem(entityId);
    if (!item) return null;
    const { total_cost, initial_cost, processing_cost } = calculate_item(item);
    const weightRatio = item.total_weight ? item.sold_weight / item.total_weight : 1;
    pairs.push({
      total_cost: total_cost * weightRatio,
      initial_cost: initial_cost,
      processing_cost: processing_cost,
      total_price: item.sale?.total_price || 0,
      payments: item.sale ? item.sale.payments : [],
      include_pending
    });

  } else if (entityType === 'customer') {
    const customer = DB.customers[entityId];
    if (!customer) return null;
    for (const truck of Object.values(DB.trucks)) {
      for (const lot of Object.values(truck.lots)) {
        for (const item of Object.values(lot.items)) {
          if (item.sale && item.sale.customer_id === entityId && item.sale.payments?.length) {
            const { total_cost, initial_cost, processing_cost } = calculate_item(item);
            const weightRatio = item.total_weight ? item.sold_weight / item.total_weight : 1;
            pairs.push({
              total_cost: total_cost * weightRatio,
              initial_cost: initial_cost,
              processing_cost: processing_cost,
              total_price: item.sale.total_price || 0,
              payments: item.sale.payments,
              include_pending
            });
          }
          for (const sub of Object.values(item.subitems)) {
            if (sub.sale && sub.sale.customer_id === entityId && sub.sale.payments?.length) {
              const { total_cost, initial_cost, processing_cost } = calculate_subitem(sub);
              const weightRatio = sub.total_weight ? sub.sold_weight / sub.total_weight : 1;
              pairs.push({
                total_cost: total_cost * weightRatio,
                initial_cost: initial_cost,
                processing_cost: processing_cost,
                total_price: sub.sale.total_price || 0,
                payments: sub.sale.payments,
                include_pending
              });
            }
          }
        }
      }
    }

  } else if (entityType === 'mill') {
    const mill = DB.mills[entityId];
    if (!mill) return null;
    for (const truck of Object.values(DB.trucks)) {
      for (const lot of Object.values(truck.lots)) {
        if (lot.mill_id === entityId) {
          for (const item of Object.values(lot.items)) {
            if (item.sale?.payments?.length) {
              const { total_cost, initial_cost, processing_cost } = calculate_item(item);
              const weightRatio = item.total_weight ? item.sold_weight / item.total_weight : 1;
              pairs.push({
                total_cost: total_cost * weightRatio,
                initial_cost: initial_cost,
                processing_cost: processing_cost,
                total_price: item.sale.total_price || 0,
                payments: item.sale.payments,
                include_pending
              });
            }
            for (const sub of Object.values(item.subitems)) {
              if (sub.sale?.payments?.length) {
                const { total_cost, initial_cost, processing_cost } = calculate_subitem(sub);
                const weightRatio = sub.total_weight ? sub.sold_weight / sub.total_weight : 1;
                pairs.push({
                  total_cost: total_cost * weightRatio,
                  initial_cost: initial_cost,
                  processing_cost: processing_cost,
                  total_price: sub.sale.total_price || 0,
                  payments: sub.sale.payments,
                  include_pending
                });
              }
            }
          }
        }
      }
    }
  }

  let total_cost = 0;
  let total_initial_cost = 0;
  let total_processing_cost = 0;
  let total_received = 0;
  let total_pending = 0;

  for (const p of pairs) {
    total_cost += p.total_cost;
    total_initial_cost += p.initial_cost || 0;
    total_processing_cost += p.processing_cost || 0;

    if (p.include_pending) {
      total_received += p.total_price || 0;
      const paid = (p.payments || []).reduce((s, pmt) => s + (pmt.amount_paid || 0), 0);
      total_pending += (p.total_price || 0) - paid;
    } else {
      const paid = (p.payments || []).reduce((s, pmt) => s + (pmt.amount_paid || 0), 0);
      total_received += paid;
      total_pending += 0;
    }
  }

  const profit = total_received - total_cost;
  return {
    total_cost,
    total_initial_cost,
    total_processing_cost,
    total_received,
    total_pending,
    profit,
    include_pending,
    pair_count: pairs.length
  };
}

// ============================================================
// HELPER FINDERS
// ============================================================
function findLot(lotId) {
  for (const truck of Object.values(DB.trucks)) {
    for (const lot of Object.values(truck.lots)) {
      if (lot.id === lotId) return { truck, lot };
    }
  }
  return {};
}

function findItem(itemId) {
  for (const truck of Object.values(DB.trucks)) {
    for (const lot of Object.values(truck.lots)) {
      for (const item of Object.values(lot.items)) {
        if (item.id === itemId) return { truck, lot, item };
      }
    }
  }
  return {};
}

function findSubitem(subitemId) {
  for (const truck of Object.values(DB.trucks)) {
    for (const lot of Object.values(truck.lots)) {
      for (const item of Object.values(lot.items)) {
        for (const sub of Object.values(item.subitems)) {
          if (sub.id === subitemId) return { truck, lot, item, sub };
        }
      }
    }
  }
  return {};
}

function getOrCreateMill(name) {
  const trimmed = name.trim();
  const existing = Object.values(DB.mills).find(
    m => m.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (existing) return existing;
  const mill = makeMill(trimmed);
  DB.mills[mill.id] = mill;
  saveDB();
  return mill;
}

// ============================================================
// FORMATTERS
// ============================================================
function fmt(num) {
  return '$' + Number(num || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

function fmtWeight(kg) {
  if (kg == null) return '—';
  return Number(kg).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }) + ' kg';
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

// ============================================================
// DEBOUNCE UTILITY
// ============================================================
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function toast(msg, type = 'info') {
  const tc = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  tc.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ============================================================
// MODAL SYSTEM
// ============================================================
let modalResolve = null;
let profitEntitiesCache = []; // Cache for searchable profit entities
function openModal(title, bodyHTML, confirmText = 'Confirm') {
  return new Promise(resolve => {
    modalResolve = resolve;
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHTML;
    document.getElementById('modalConfirm').textContent = confirmText;
    document.getElementById('modalOverlay').classList.remove('hidden');
  });
}
function closeModal(result = null) {
  document.getElementById('modalOverlay').classList.add('hidden');
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}
function getModalValues() {
  const fields = document.querySelectorAll('#modalBody [data-field]');
  const result = {};
  fields.forEach(f => {
    result[f.dataset.field] = f.value;
  });
  return result;
}

// ============================================================
// NAVIGATION STATE
// ============================================================
let currentView = 'dashboard';
let currentTruckId = null;
let currentLotId = null;
let currentItemId = null;

function navigate(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${view}`)?.classList.add('active');
  document.querySelector(`[data-view="${view}"]`)?.classList.add('active');
  document.getElementById('pageTitle').textContent = view.charAt(0).toUpperCase() + view.slice(1);
  document.getElementById('breadcrumb').textContent = '';
  renderCurrentView();
}

function renderCurrentView() {
  switch (currentView) {
    case 'dashboard': renderDashboard(); break;
    case 'trucks': renderTrucks(); break;
    case 'customers': renderCustomers(); break;
    case 'mills': renderMills(); break;
    case 'sales': renderSales(); break;
    case 'profit': renderProfit(); break;
  }
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  const trucks = Object.values(DB.trucks);
  const customers = Object.values(DB.customers);
  const mills = Object.values(DB.mills);
  let totalCost = 0, totalSales = 0, totalPaid = 0, lotCount = 0, itemCount = 0;
  for (const truck of trucks) {
    const { total_cost } = calculate_truck(truck);
    totalCost += total_cost;
    for (const lot of Object.values(truck.lots)) {
      lotCount++;
      for (const item of Object.values(lot.items)) {
        if (!item.depleted) itemCount++;
        if (item.sale?.payments?.length) {
          totalSales++;
          totalPaid += item.sale.payments.reduce((s, p) => s + (p.amount_paid || 0), 0);
        }
        for (const sub of Object.values(item.subitems)) {
          if (sub.sale?.payments?.length) {
            totalSales++;
            totalPaid += sub.sale.payments.reduce((s, p) => s + (p.amount_paid || 0), 0);
          }
        }
      }
    }
  }
  const statsEl = document.getElementById('dashboardStats');
  statsEl.innerHTML = `
<div class="stat-card">
  <div class="stat-label">Trucks</div>
  <div class="stat-value">${trucks.length}</div>
  <div class="stat-sub">${lotCount} lots · ${itemCount} active items</div>
</div>
<div class="stat-card">
  <div class="stat-label">Total Cost</div>
  <div class="stat-value" style="font-size:18px">${fmt(totalCost)}</div>
  <div class="stat-sub">across all entities</div>
</div>
<div class="stat-card">
  <div class="stat-label">Total Received</div>
  <div class="stat-value" style="font-size:18px;color:var(--green)">${fmt(totalPaid)}</div>
  <div class="stat-sub">${totalSales} sales</div>
</div>
<div class="stat-card">
  <div class="stat-label">Customers</div>
  <div class="stat-value">${customers.length}</div>
  <div class="stat-sub">${mills.length} mills registered</div>
</div>
`;
  const rt = document.getElementById('recentTrucks');
  rt.innerHTML = `<div class="dash-card-title">Recent Trucks</div>`;
  if (trucks.length === 0) {
    rt.innerHTML += `<div class="text-muted" style="font-size:12px;padding:8px 0">No trucks yet.</div>`;
  } else {
    trucks.slice(-5).reverse().forEach(truck => {
      const { total_cost } = calculate_truck(truck);
      rt.innerHTML += `
<div class="dash-row">
  <span class="dash-row-label">${truck.name}</span>
  <span class="dash-row-val">${fmt(total_cost)}</span>
</div>`;
    });
  }
  const rs = document.getElementById('recentSales');
  rs.innerHTML = `<div class="dash-card-title">Recent Sales</div>`;
  const sales = [];
  for (const truck of trucks) {
    for (const lot of Object.values(truck.lots)) {
      for (const item of Object.values(lot.items)) {
        if (item.sale?.payments?.length) {
          const cust = DB.customers[item.sale.customer_id];
          sales.push({ name: item.name, customer: cust?.name || '?', weight: item.sold_weight, payments: item.sale.payments });
        }
      }
    }
  }
  if (sales.length === 0) {
    rs.innerHTML += `<div class="text-muted" style="font-size:12px;padding:8px 0">No sales yet.</div>`;
  } else {
    sales.slice(-5).reverse().forEach(s => {
      const total = s.payments.reduce((x, p) => x + (p.amount_paid || 0), 0);
      rs.innerHTML += `
<div class="dash-row">
  <span class="dash-row-label">${s.name} → ${s.customer}${s.weight ? ` (${fmtWeight(s.weight)})` : ''}</span>
  <span class="dash-row-val">${fmt(total)}</span>
</div>`;
    });
  }
}

// ============================================================
// TRUCKS VIEW
// ============================================================
function renderTrucks() {
  hidePanels();
  const list = document.getElementById('truckList');
  const trucks = Object.values(DB.trucks);
  if (trucks.length === 0) {
    list.innerHTML = emptyState('◈', 'No trucks yet. Add one to get started.');
    return;
  }
  list.innerHTML = '';
  trucks.forEach(truck => {
    const { total_cost } = calculate_truck(truck);
    const lotCount = Object.keys(truck.lots).length;
    const card = document.createElement('div');
    card.className = 'entity-card';
    card.innerHTML = `
<div class="entity-card-left">
  <div class="entity-card-name">${truck.name}</div>
  <div class="entity-card-meta">${lotCount} lot${lotCount !== 1 ? 's' : ''} · ${truck.description || 'No description'}</div>
</div>
<div class="entity-card-right">
  <span class="cost-badge">${fmt(total_cost)}</span>
  <button class="btn btn-danger btn-sm" data-del-truck="${truck.id}">Delete</button>
</div>
`;
    card.addEventListener('click', e => {
      if (e.target.dataset.delTruck) return;
      openTruckDetail(truck.id);
    });
    card.querySelector(`[data-del-truck]`)?.addEventListener('click', e => {
      e.stopPropagation();
      confirmDelete('truck', truck.id, truck.name);
    });
    list.appendChild(card);
  });
}

function hidePanels() {
  document.getElementById('truckDetail').classList.add('hidden');
  document.getElementById('lotDetail').classList.add('hidden');
  document.getElementById('itemDetail').classList.add('hidden');
  document.getElementById('truckList').classList.remove('hidden');
}

function openTruckDetail(truckId) {
  currentTruckId = truckId;
  const truck = DB.trucks[truckId];
  document.getElementById('truckList').classList.add('hidden');
  document.getElementById('lotDetail').classList.add('hidden');
  document.getElementById('itemDetail').classList.add('hidden');
  const panel = document.getElementById('truckDetail');
  panel.classList.remove('hidden');
  document.getElementById('truckDetailTitle').textContent = truck.name;
  document.getElementById('breadcrumb').textContent = truck.name;
  renderLotList(truck);
}

function renderLotList(truck) {
  const list = document.getElementById('lotList');
  const lots = Object.values(truck.lots);
  if (lots.length === 0) {
    list.innerHTML = emptyState('⬡', 'No lots. Add one above.');
    return;
  }
  list.innerHTML = '';
  lots.forEach(lot => {
    const { total_cost, processing_cost } = calculate_lot(lot);
    const mill = lot.mill_id ? DB.mills[lot.mill_id] : null;
    const warning = validate_lot(lot);
    const remaining = getRemainingWeight(lot);
    const card = document.createElement('div');
    card.className = 'entity-card';
    card.innerHTML = `
<div class="entity-card-left">
  <div class="entity-card-name">${lot.name}</div>
  <div class="entity-card-meta">
    ${mill ? '⬡ ' + mill.name : 'No mill'} ·
    Initial: ${fmt(lot.initial_cost)} ·
    Processing: ${fmt(processing_cost)} ·
    ${lot.total_weight ? fmtWeight(lot.total_weight) + ' cap' : ''}
    ${remaining != null ? ' · ' + fmtWeight(remaining) + ' left' : ''}
    ${Object.keys(lot.items).length} items
    ${warning ? ' · <span style="color:var(--yellow)">⚠ Cost mismatch</span>' : ''}
  </div>
</div>
<div class="entity-card-right">
  <span class="cost-badge">${fmt(total_cost)}</span>
  <button class="btn btn-danger btn-sm" data-del-lot="${lot.id}">Delete</button>
</div>
`;
    card.addEventListener('click', e => {
      if (e.target.dataset.delLot) return;
      openLotDetail(lot.id);
    });
    card.querySelector(`[data-del-lot]`)?.addEventListener('click', e => {
      e.stopPropagation();
      confirmDelete('lot', lot.id, lot.name);
    });
    list.appendChild(card);
  });
}

function openLotDetail(lotId) {
  currentLotId = lotId;
  const { truck, lot } = findLot(lotId);
  const { total_cost, processing_cost } = calculate_lot(lot);
  const mill = lot.mill_id ? DB.mills[lot.mill_id] : null;
  document.getElementById('truckDetail').classList.add('hidden');
  document.getElementById('itemDetail').classList.add('hidden');
  const panel = document.getElementById('lotDetail');
  panel.classList.remove('hidden');
  document.getElementById('lotDetailTitle').textContent = lot.name;
  document.getElementById('breadcrumb').textContent = `${truck.name} / ${lot.name}`;
  document.getElementById('lotCostBadge').innerHTML = `Total: <strong>${fmt(total_cost)}</strong>`;
  const warning = validate_lot(lot);
  const remaining = getRemainingWeight(lot);
  const sold = lot.sold_weight || 0;
  document.getElementById('lotInfoGrid').innerHTML = `
${warning ? `<div class="warning-banner" style="grid-column:1/-1">
  <span class="warning-icon">⚠</span><span>${warning}</span>
</div>` : ''}
<div class="info-block"><div class="info-block-label">Initial Cost</div><div class="info-block-value">${fmt(lot.initial_cost)}</div></div>
<div class="info-block"><div class="info-block-label">Processing Cost</div><div class="info-block-value">${fmt(processing_cost)}</div></div>
<div class="info-block"><div class="info-block-label">Total Cost</div><div class="info-block-value accent">${fmt(total_cost)}</div></div>
<div class="info-block"><div class="info-block-label">Weight Capacity</div><div class="info-block-value" style="font-size:14px">${fmtWeight(lot.total_weight)}</div></div>
<div class="info-block"><div class="info-block-label">Sold Weight</div><div class="info-block-value" style="font-size:14px;color:var(--purple)">${fmtWeight(sold)}</div></div>
<div class="info-block"><div class="info-block-label">Remaining</div><div class="info-block-value" style="font-size:14px;color:${remaining <= 0 ? 'var(--red)' : 'var(--green)'}">${fmtWeight(remaining)}</div></div>
<div class="info-block"><div class="info-block-label">Mill</div><div class="info-block-value" style="font-size:14px">${mill ? mill.name : '—'}</div></div>
`;
  renderProcessingList('lotProcessingList', lot.processing_records, () => {
    const { processing_cost: pc, total_cost: tc } = calculate_lot(lot);
    document.getElementById('lotCostBadge').innerHTML = `Total: <strong>${fmt(tc)}</strong>`;
    renderLotInfoGrid(lot);
  });
  renderItemList(lot);
}

function renderLotInfoGrid(lot) {
  const { total_cost, processing_cost } = calculate_lot(lot);
  const mill = lot.mill_id ? DB.mills[lot.mill_id] : null;
  const warning = validate_lot(lot);
  const remaining = getRemainingWeight(lot);
  const sold = lot.sold_weight || 0;
  document.getElementById('lotInfoGrid').innerHTML = `
${warning ? `<div class="warning-banner" style="grid-column:1/-1">
  <span class="warning-icon">⚠</span><span>${warning}</span>
</div>` : ''}
<div class="info-block"><div class="info-block-label">Initial Cost</div><div class="info-block-value">${fmt(lot.initial_cost)}</div></div>
<div class="info-block"><div class="info-block-label">Processing Cost</div><div class="info-block-value">${fmt(processing_cost)}</div></div>
<div class="info-block"><div class="info-block-label">Total Cost</div><div class="info-block-value accent">${fmt(total_cost)}</div></div>
<div class="info-block"><div class="info-block-label">Weight Capacity</div><div class="info-block-value" style="font-size:14px">${fmtWeight(lot.total_weight)}</div></div>
<div class="info-block"><div class="info-block-label">Sold Weight</div><div class="info-block-value" style="font-size:14px;color:var(--purple)">${fmtWeight(sold)}</div></div>
<div class="info-block"><div class="info-block-label">Remaining</div><div class="info-block-value" style="font-size:14px;color:${remaining <= 0 ? 'var(--red)' : 'var(--green)'}">${fmtWeight(remaining)}</div></div>
<div class="info-block"><div class="info-block-label">Mill</div><div class="info-block-value" style="font-size:14px">${mill ? mill.name : '—'}</div></div>
`;
}

function renderProcessingList(containerId, records, onUpdate) {
  const container = document.getElementById(containerId);
  if (!records || records.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `<div class="processing-section-title">Processing Records</div>`;
  records.forEach((rec, idx) => {
    const el = document.createElement('div');
    el.className = 'processing-record';
    el.innerHTML = `
<div class="processing-record-info">
  <span class="processing-record-type">${rec.type}</span>
  <span class="processing-record-worker">by ${rec.worker}</span>
</div>
<div style="display:flex;align-items:center;gap:10px">
  <span class="processing-record-fee">${fmt(rec.labour_fee)}</span>
  <button class="btn btn-danger btn-sm" data-idx="${idx}">✕</button>
</div>
`;
    el.querySelector('[data-idx]').addEventListener('click', () => {
      records.splice(idx, 1);
      saveDB();
      renderProcessingList(containerId, records, onUpdate);
      if (onUpdate) onUpdate();
      toast('Processing record removed', 'info');
    });
    container.appendChild(el);
  });
}

function renderItemList(lot) {
  const list = document.getElementById('itemList');
  const items = Object.values(lot.items);
  if (items.length === 0) {
    list.innerHTML = emptyState('◇', 'No items. Add one above.');
    return;
  }
  list.innerHTML = '';
  items.forEach(item => {
    if (item.depleted) return;
    const { total_cost, processing_cost } = calculate_item(item);
    const subCount = Object.keys(item.subitems).length;
    const sold = !!item.sale?.payments?.length;
    const remaining = getRemainingWeight(item);
    const card = document.createElement('div');
    card.className = 'entity-card' + (remaining <= 0 ? ' depleted' : '');
    card.innerHTML = `
<div class="entity-card-left">
  <div class="entity-card-name">${item.name}${remaining <= 0 ? '<span class="depleted-badge">DEPLETED</span>' : ''}</div>
  <div class="entity-card-meta">
    ${subCount} subitem${subCount !== 1 ? 's' : ''} ·
    ${item.total_weight != null ? fmtWeight(item.total_weight) + ' total' : ''}
    ${remaining != null ? ' · ' + fmtWeight(remaining) + ' left' : ''}
    Processing: ${fmt(processing_cost)}
    ${sold ? ' · <span style="color:var(--green)">● SOLD</span>' : ''}
  </div>
</div>
<div class="entity-card-right">
  <span class="cost-badge">${fmt(total_cost)}</span>
  ${remaining > 0 ? `<button class="btn btn-accent btn-sm" data-sell-item="${item.id}">Sell</button>` : ''}
  <button class="btn btn-ghost btn-sm" data-deplete-item="${item.id}">Deplete</button>
  <button class="btn btn-danger btn-sm" data-del-item="${item.id}">Delete</button>
</div>
`;
    card.querySelector(`[data-sell-item]`)?.addEventListener('click', () => sellEntity('item', item.id));
    card.querySelector(`[data-deplete-item]`)?.addEventListener('click', () => markDepleted('item', item.id));
    card.querySelector(`[data-del-item]`)?.addEventListener('click', e => {
      e.stopPropagation();
      confirmDelete('item', item.id, item.name);
    });
    card.addEventListener('click', e => {
      if (e.target.dataset.sellItem || e.target.dataset.depleteItem || e.target.dataset.delItem) return;
      openItemDetail(item.id);
    });
    list.appendChild(card);
  });
}

function openItemDetail(itemId) {
  currentItemId = itemId;
  const { truck, lot, item } = findItem(itemId);
  document.getElementById('lotDetail').classList.add('hidden');
  const panel = document.getElementById('itemDetail');
  panel.classList.remove('hidden');
  document.getElementById('itemDetailTitle').textContent = item.name;
  document.getElementById('breadcrumb').textContent = `${truck.name} / ${lot.name} / ${item.name}`;
  refreshItemDetail(item);
}

function refreshItemDetail(item) {
  const { total_cost, processing_cost, initial_cost } = calculate_item(item);
  document.getElementById('itemCostBadge').innerHTML = `Total: <strong>${fmt(total_cost)}</strong>`;
  const remaining = getRemainingWeight(item);
  document.getElementById('itemInfoGrid').innerHTML = `
<div class="info-block"><div class="info-block-label">Initial Cost</div><div class="info-block-value">${fmt(initial_cost)}</div></div>
<div class="info-block"><div class="info-block-label">Processing Cost</div><div class="info-block-value">${fmt(processing_cost)}</div></div>
<div class="info-block"><div class="info-block-label">Total Cost</div><div class="info-block-value accent">${fmt(total_cost)}</div></div>
<div class="info-block"><div class="info-block-label">Total Weight</div><div class="info-block-value" style="font-size:14px">${fmtWeight(item.total_weight)}</div></div>
<div class="info-block"><div class="info-block-label">Sold Weight</div><div class="info-block-value" style="font-size:14px;color:var(--purple)">${fmtWeight(item.sold_weight || 0)}</div></div>
<div class="info-block"><div class="info-block-label">Remaining</div><div class="info-block-value" style="font-size:14px;color:${remaining <= 0 ? 'var(--red)' : 'var(--green)'}">${fmtWeight(remaining)}</div></div>
`;
  renderProcessingList('itemProcessingList', item.processing_records, () => {
    refreshItemDetail(item);
  });
  renderSubitemList(item);
  renderItemSaleInfo(item);
}

function renderSubitemList(item) {
  const list = document.getElementById('subitemList');
  const subitems = Object.values(item.subitems);
  const activeSubs = subitems.filter(s => !s.depleted);
  if (activeSubs.length === 0) {
    list.innerHTML = emptyState('·', 'No subitems. Add one above.');
    return;
  }
  list.innerHTML = '';
  activeSubs.forEach(sub => {
    const { total_cost, processing_cost } = calculate_subitem(sub);
    const sold = !!sub.sale?.payments?.length;
    const remaining = getRemainingWeight(sub);
    const card = document.createElement('div');
    card.className = 'entity-card' + (remaining <= 0 ? ' depleted' : '');
    card.innerHTML = `
<div class="entity-card-left">
  <div class="entity-card-name">${sub.name}${remaining <= 0 ? '<span class="depleted-badge">DEPLETED</span>' : ''}</div>
  <div class="entity-card-meta">
    Initial: ${fmt(sub.initial_cost)} · Processing: ${fmt(processing_cost)}
    ${sub.total_weight != null ? fmtWeight(sub.total_weight) + ' total' : ''}
    ${remaining != null ? ' · ' + fmtWeight(remaining) + ' left' : ''}
    ${sold ? ' · <span style="color:var(--green)">● SOLD</span>' : ''}
  </div>
</div>
<div class="entity-card-right">
  <span class="cost-badge">${fmt(total_cost)}</span>
  ${remaining > 0 ? `<button class="btn btn-accent btn-sm" data-sell-sub="${sub.id}">Sell</button>` : ''}
  <button class="btn btn-ghost btn-sm" data-deplete-sub="${sub.id}">Deplete</button>
  <button class="btn btn-ghost btn-sm" data-proc-sub="${sub.id}">+Proc</button>
  <button class="btn btn-ghost btn-sm" data-pay-sub="${sub.id}">+Pay</button>
  <button class="btn btn-danger btn-sm" data-del-sub="${sub.id}">✕</button>
</div>
`;
    card.querySelector(`[data-sell-sub]`)?.addEventListener('click', () => sellEntity('subitem', sub.id, item));
    card.querySelector(`[data-deplete-sub]`)?.addEventListener('click', () => markDepleted('subitem', sub.id));
    card.querySelector(`[data-proc-sub]`)?.addEventListener('click', () => addProcessingTo('subitem', sub.id, item));
    card.querySelector(`[data-pay-sub]`)?.addEventListener('click', () => addPaymentTo('subitem', sub.id, item));
    card.querySelector(`[data-del-sub]`)?.addEventListener('click', () => {
      delete item.subitems[sub.id];
      saveDB();
      refreshItemDetail(item);
      toast('Subitem deleted', 'info');
    });
    list.appendChild(card);
  });
}

function renderItemSaleInfo(item) {
  const container = document.getElementById('itemSaleInfo');
  if (!item.sale?.payments?.length) { container.innerHTML = ''; return; }
  const cust = DB.customers[item.sale.customer_id];
  const payments = item.sale.payments || [];
  const totalPaid = payments.reduce((s, p) => s + (p.amount_paid || 0), 0);
  const totalPrice = item.sale.total_price || totalPaid;
  const balance = totalPrice - totalPaid;
  container.innerHTML = `
<div class="sale-card">
  <div class="sale-header">
    <div class="sale-title">Sale Information</div>
    <div>
      <span class="tag tag-green">SOLD</span>
      ${balance > 0 ? `<span class="tag tag-yellow mt8">Pending: ${fmt(balance)}</span>` : ''}
      <button class="btn btn-ghost btn-sm mt8" id="addPaymentItemBtn">+ Add Payment</button>
    </div>
  </div>
  <div style="font-size:13px;color:var(--text-sec);margin-bottom:14px">
    Customer: <strong style="color:var(--text-pri)">${cust ? cust.name : 'Unknown'}</strong>
    ${cust ? ` · ${cust.phone}` : ''}
  </div>
  <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
    Total Weight Sold: <strong>${fmtWeight(item.sold_weight || 0)}</strong> / ${fmtWeight(item.total_weight)}
    ${item.total_weight ? `(${Math.round((item.sold_weight / item.total_weight) * 100)}%)` : ''}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
    <div class="info-block" style="padding:12px">
      <div class="info-block-label">Total Selling Price</div>
      <div class="info-block-value accent">${fmt(totalPrice)}</div>
    </div>
    <div class="info-block" style="padding:12px">
      <div class="info-block-label">Total Paid</div>
      <div class="info-block-value" style="color:var(--green)">${fmt(totalPaid)}</div>
    </div>
  </div>
  <div class="payments-list">
    ${payments.map((p, i) => `
<div class="payment-row">
  <span class="payment-amount">${fmt(p.amount_paid || 0)}</span>
  <span class="payment-meta">${p.method || 'Cash'} · ${fmtDate(p.date)}</span>
  <button class="btn btn-danger btn-sm" data-del-pay="${i}">✕</button>
</div>
`).join('')}
  </div>
  <div class="balance-row">
    <span class="balance-label">Remaining Balance</span>
    <span class="balance-value ${balance <= 0 ? 'positive' : 'negative'}">${balance <= 0 ? 'Paid in Full' : fmt(balance)}</span>
  </div>
</div>
`;
  container.querySelectorAll('[data-del-pay]').forEach(btn => {
    btn.addEventListener('click', () => {
      item.sale.payments.splice(Number(btn.dataset.delPay), 1);
      saveDB();
      renderItemSaleInfo(item);
    });
  });
  container.querySelector('#addPaymentItemBtn')?.addEventListener('click', () => {
    addPaymentTo('item', item.id);
  });
}

function markDepleted(type, id) {
  let entity;
  if (type === 'item') {
    const { item } = findItem(id);
    entity = item;
  } else if (type === 'subitem') {
    const { sub } = findSubitem(id);
    entity = sub;
  }
  if (!entity) return;
  entity.depleted = true;
  saveDB();
  toast(`${entity.name} marked as depleted`, 'info');
  if (type === 'item') {
    const { lot } = findItem(id);
    renderItemList(lot);
  } else {
    const { item } = findSubitem(id);
    refreshItemDetail(item);
  }
}

// ============================================================
// CUSTOMERS VIEW
// ============================================================
function renderCustomers() {
  const list = document.getElementById('customerList');
  const customers = Object.values(DB.customers);
  if (customers.length === 0) {
    list.innerHTML = emptyState('◉', 'No customers yet.');
    return;
  }
  list.innerHTML = '';
  customers.forEach(c => {
    let totalPending = 0;
    for (const truck of Object.values(DB.trucks)) {
      for (const lot of Object.values(truck.lots)) {
        for (const item of Object.values(lot.items)) {
          if (item.sale && item.sale.customer_id === c.id) {
            const totalPaid = (item.sale.payments || []).reduce((s, p) => s + (p.amount_paid || 0), 0);
            const totalPrice = item.sale.total_price || totalPaid;
            totalPending += Math.max(0, totalPrice - totalPaid);
          }
          for (const sub of Object.values(item.subitems)) {
            if (sub.sale && sub.sale.customer_id === c.id) {
              const totalPaid = (sub.sale.payments || []).reduce((s, p) => s + (p.amount_paid || 0), 0);
              const totalPrice = sub.sale.total_price || totalPaid;
              totalPending += Math.max(0, totalPrice - totalPaid);
            }
          }
        }
      }
    }
    const card = document.createElement('div');
    card.className = 'entity-card';
    card.innerHTML = `
<div class="entity-card-left">
  <div class="entity-card-name">${c.name}</div>
  <div class="entity-card-meta">📞 ${c.phone || '—'}${totalPending > 0 ? ` · <span style="color:var(--yellow)">Pending: ${fmt(totalPending)}</span>` : ''}</div>
</div>
<div class="entity-card-right">
  <button class="btn btn-danger btn-sm" data-del-cust="${c.id}">Delete</button>
</div>
`;
    card.querySelector('[data-del-cust]')?.addEventListener('click', () => confirmDelete('customer', c.id, c.name));
    list.appendChild(card);
  });
}

// ============================================================
// MILLS VIEW
// ============================================================
function renderMills() {
  const list = document.getElementById('millList');
  const mills = Object.values(DB.mills);
  if (mills.length === 0) {
    list.innerHTML = emptyState('◎', 'No mills yet.');
    return;
  }
  list.innerHTML = '';
  mills.forEach(m => {
    let lotCount = 0;
    for (const truck of Object.values(DB.trucks)) {
      for (const lot of Object.values(truck.lots)) {
        if (lot.mill_id === m.id) lotCount++;
      }
    }
    const card = document.createElement('div');
    card.className = 'entity-card';
    card.innerHTML = `
<div class="entity-card-left">
  <div class="entity-card-name">${m.name}</div>
  <div class="entity-card-meta">${lotCount} lot${lotCount !== 1 ? 's' : ''} linked</div>
</div>
<div class="entity-card-right">
  <span class="tag tag-blue">Mill</span>
  <button class="btn btn-danger btn-sm" data-del-mill="${m.id}">Delete</button>
</div>
`;
    card.querySelector('[data-del-mill]')?.addEventListener('click', () => confirmDelete('mill', m.id, m.name));
    list.appendChild(card);
  });
}

// ============================================================
// SALES VIEW
// ============================================================
function renderSales() {
  const list = document.getElementById('salesList');
  const sales = [];
  for (const truck of Object.values(DB.trucks)) {
    for (const lot of Object.values(truck.lots)) {
      for (const item of Object.values(lot.items)) {
        if (item.sale?.payments?.length) {
          const totalPaid = item.sale.payments.reduce((s, p) => s + (p.amount_paid || 0), 0);
          const totalPrice = item.sale.total_price || totalPaid;
          const { total_cost } = calculate_item(item);
          const weightRatio = item.total_weight ? item.sold_weight / item.total_weight : 1;
          sales.push({ name: item.name, type: 'Item', sale: item.sale, total_cost: total_cost * weightRatio, paid: totalPaid, total_price: totalPrice, truck: truck.name, lot: lot.name, weight_sold: item.sold_weight });
        }
        for (const sub of Object.values(item.subitems)) {
          if (sub.sale?.payments?.length) {
            const totalPaid = sub.sale.payments.reduce((s, p) => s + (p.amount_paid || 0), 0);
            const totalPrice = sub.sale.total_price || totalPaid;
            const { total_cost } = calculate_subitem(sub);
            const weightRatio = sub.total_weight ? sub.sold_weight / sub.total_weight : 1;
            sales.push({ name: sub.name, type: 'Subitem', sale: sub.sale, total_cost: total_cost * weightRatio, paid: totalPaid, total_price: totalPrice, truck: truck.name, lot: lot.name, item: item.name, weight_sold: sub.sold_weight });
          }
        }
      }
    }
  }
  if (sales.length === 0) {
    list.innerHTML = emptyState('◆', 'No sales recorded yet.');
    return;
  }
  list.innerHTML = '';
  sales.forEach(s => {
    const cust = DB.customers[s.sale.customer_id];
    const balance = s.total_price - s.paid;
    const card = document.createElement('div');
    card.className = 'entity-card';
    card.innerHTML = `
<div class="entity-card-left">
  <div class="entity-card-name">${s.name} <span class="tag tag-blue">${s.type}</span></div>
  <div class="entity-card-meta">
    ${s.truck} / ${s.lot}${s.item ? ' / ' + s.item : ''} ·
    Customer: ${cust ? cust.name : '?'} ·
    Weight: ${fmtWeight(s.weight_sold)} ·
    Price: ${fmt(s.total_price)} · Paid: ${fmt(s.paid)}
    ${balance > 0 ? ` · <span style="color:var(--yellow)">Pending: ${fmt(balance)}</span>` : ''}
  </div>
</div>
<div class="entity-card-right">
  <span class="cost-badge" style="${balance <= 0 ? 'color:var(--green)' : 'color:var(--red)'}">${balance <= 0 ? 'Paid' : fmt(balance)}</span>
</div>
`;
    list.appendChild(card);
  });
}

// ============================================================
// PROFIT VIEW
// ============================================================
function renderProfit() {
  updateProfitEntityOptions();
}

/*function updateProfitEntityOptions() {
  const type = document.getElementById('profitEntityType').value;
  const sel = document.getElementById('profitEntityId');
  sel.innerHTML = '';
  let entities = [];
  if (type === 'truck') entities = Object.values(DB.trucks);
  else if (type === 'lot') {
    for (const t of Object.values(DB.trucks))
      for (const l of Object.values(t.lots))
        entities.push({ ...l, displayName: `${t.name} / ${l.name}` });
  }
  else if (type === 'item') {
    for (const t of Object.values(DB.trucks))
      for (const l of Object.values(t.lots))
        for (const i of Object.values(l.items))
          if (!i.depleted) entities.push({ ...i, displayName: `${t.name} / ${l.name} / ${i.name}` });
  }
  else if (type === 'customer') entities = Object.values(DB.customers);
  else if (type === 'mill') entities = Object.values(DB.mills);
  if (entities.length === 0) {
    sel.innerHTML = '<option value="">— None available —</option>';
    return;
  }
  entities.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.displayName || e.name;
    sel.appendChild(opt);
  });
}*/
// ============================================================
// PROFIT ENTITY OPTIONS (SEARCHABLE)
// ============================================================
function updateProfitEntityOptions() {
  const type = document.getElementById('profitEntityType').value;
  const searchInput = document.getElementById('profitEntitySearch');
  const suggestionsBox = document.getElementById('profitEntitySuggestions');
  const hiddenSelect = document.getElementById('profitEntityId');

  // Build entity list with metadata for search
  let entities = [];
  if (type === 'truck') {
    entities = Object.values(DB.trucks).map(e => ({
      id: e.id,
      name: e.name,
      meta: e.description || ''
    }));
  } else if (type === 'lot') {
    for (const t of Object.values(DB.trucks)) {
      for (const l of Object.values(t.lots)) {
        const mill = l.mill_id ? DB.mills[l.mill_id] : null;
        entities.push({
          id: l.id,
          name: l.name,
          meta: `${t.name} · ${mill ? mill.name : 'No mill'}`
        });
      }
    }
  } else if (type === 'item') {
    for (const t of Object.values(DB.trucks)) {
      for (const l of Object.values(t.lots)) {
        for (const i of Object.values(l.items)) {
          if (!i.depleted) {
            entities.push({
              id: i.id,
              name: i.name,
              meta: `${t.name} / ${l.name}`
            });
          }
        }
      }
    }
  } else if (type === 'customer') {
    entities = Object.values(DB.customers).map(e => ({
      id: e.id,
      name: e.name,
      meta: e.phone || ''
    }));
  } else if (type === 'mill') {
    entities = Object.values(DB.mills).map(e => {
      const lotCount = Object.values(DB.trucks)
        .flatMap(t => Object.values(t.lots))
        .filter(l => l.mill_id === e.id).length;
      return {
        id: e.id,
        name: e.name,
        meta: `${lotCount} lot${lotCount !== 1 ? 's' : ''} linked`
      };
    });
  }
  function renderProfitSuggestions(entities) {
    const suggestionsBox = document.getElementById('profitEntitySuggestions');
    const searchInput = document.getElementById('profitEntitySearch');
    const hiddenSelect = document.getElementById('profitEntityId');

    if (entities.length === 0) {
      suggestionsBox.innerHTML = '<div class="no-results">No matches found</div>';
      suggestionsBox.classList.add('visible');
      return;
    }

    suggestionsBox.innerHTML = entities.map(ent => `
    <div class="suggestion-item" data-id="${ent.id}" data-name="${ent.name}">
      <span class="suggestion-name">${ent.name}</span>
      ${ent.meta ? `<span class="suggestion-meta">${ent.meta}</span>` : ''}
    </div>
  `).join('');

    suggestionsBox.classList.add('visible');

    // Click handler for suggestions
    suggestionsBox.querySelectorAll('.suggestion-item').forEach(div => {
      div.onclick = () => {
        const id = div.dataset.id;
        const name = div.dataset.name;
        hiddenSelect.value = id;
        searchInput.value = name;
        suggestionsBox.classList.remove('visible');
        // Optional: auto-trigger profit calculation on selection
        // renderProfitResult();
      };
    });
  }

  // Hide suggestions when clicking outside
  document.addEventListener('click', (e) => {
    const searchInput = document.getElementById('profitEntitySearch');
    const suggestionsBox = document.getElementById('profitEntitySuggestions');
    if (searchInput && suggestionsBox &&
      !searchInput.contains(e.target) &&
      !suggestionsBox.contains(e.target)) {
      suggestionsBox.classList.remove('visible');
    }
  });
  // Cache entities for filtering
  profitEntitiesCache = entities;

  // Populate hidden select (used by calculate_profit)
  hiddenSelect.innerHTML = '';
  if (entities.length === 0) {
    hiddenSelect.innerHTML = '<option value="">— None available —</option>';
    searchInput.value = '';
    searchInput.placeholder = '— None available —';
    searchInput.disabled = true;
    suggestionsBox.classList.remove('visible');
    suggestionsBox.innerHTML = '';
    return;
  }

  entities.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.name;
    hiddenSelect.appendChild(opt);
  });

  // Setup search input
  searchInput.disabled = false;
  searchInput.value = '';
  searchInput.placeholder = `Search ${type}...`;

  // Show all entities initially (limited)
  renderProfitSuggestions(entities.slice(0, 10));

  // Attach debounced search listener
  searchInput.oninput = null; // Remove old listeners
  searchInput.oninput = debounce((e) => {
    const query = e.target.value.toLowerCase().trim();
    const filtered = entities.filter(ent =>
      ent.name.toLowerCase().includes(query) ||
      (ent.meta && ent.meta.toLowerCase().includes(query))
    );
    renderProfitSuggestions(filtered.slice(0, 10));
  }, 150);
}

function renderProfitResult() {
  const type = document.getElementById('profitEntityType').value;
  const id = document.getElementById('profitEntityId').value;
  const includePending = document.getElementById('profitIncludePending').value === 'true';
  if (!id) { toast('Select an entity first', 'warning'); return; }
  const result = calculate_profit(type, id, includePending);
  if (!result) { toast('Could not calculate profit', 'error'); return; }
  const profitEl = document.getElementById('profitResult');
  profitEl.classList.remove('hidden');
  const profitClass = result.profit >= 0 ? 'profit-positive' : 'profit-negative';
  profitEl.innerHTML = `
<div class="profit-result-title">
  Profit Report — ${type.toUpperCase()} —
  ${includePending ? 'Including Pending Payments' : 'Excluding Pending Payments'}
</div>
<div class="profit-grid">
  <div class="profit-metric">
    <div class="profit-metric-label">Initial Cost</div>
    <div class="profit-metric-value profit-neutral">${fmt(result.total_initial_cost || 0)}</div>
  </div>
  <div class="profit-metric">
    <div class="profit-metric-label">Processing Cost</div>
    <div class="profit-metric-value profit-neutral">${fmt(result.total_processing_cost || 0)}</div>
  </div>
  <div class="profit-metric">
    <div class="profit-metric-label">Total Cost</div>
    <div class="profit-metric-value profit-neutral">${fmt(result.total_cost)}</div>
  </div>
  <div class="profit-metric">
    <div class="profit-metric-label">Total Received</div>
    <div class="profit-metric-value profit-positive">${fmt(result.total_received)}</div>
  </div>
  ${includePending && result.total_pending > 0 ? `
  <div class="profit-metric">
    <div class="profit-metric-label">Pending Payments</div>
    <div class="profit-metric-value" style="color:var(--yellow)">${fmt(result.total_pending)}</div>
  </div>
  ` : ''}
  <div class="profit-metric">
    <div class="profit-metric-label">Net Profit</div>
    <div class="profit-metric-value ${profitClass}">${fmt(result.profit)}</div>
  </div>
</div>
<div style="margin-top:20px;padding:16px;background:var(--bg-raised);border-radius:var(--radius);font-size:12px;color:var(--text-sec)">
  <strong>Note:</strong> Total Cost = Initial Cost + Processing Cost.
  ${includePending ? 'Profit includes pending (unpaid) amounts.' : 'Profit only includes received payments.'}
</div>
`;
}

// ============================================================
// SELL ENTITY
//
// FIX 5: lot.sold_weight is updated ONLY for item-level sales.
//         Subitem sales must NOT touch lot.sold_weight — that would
//         double-count at the lot level since the parent item already
//         tracks the same physical weight.
// ============================================================
async function sellEntity(type, id, parentItem = null) {
  let entity = type === 'item' ? findItem(id).item : findSubitem(id).sub;
  if (!entity || entity.depleted) { toast('Item is depleted or not found', 'error'); return; }
  const remaining = getRemainingWeight(entity);
  if (remaining <= 0) { toast('No remaining weight to sell', 'warning'); return; }
  const custOptions = Object.values(DB.customers)
    .map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  if (Object.keys(DB.customers).length === 0) {
    toast('No customers available. Add a customer first.', 'warning');
    return;
  }
  const { total_cost } = type === 'item' ? calculate_item(entity) : calculate_subitem(entity);
  const costPricePerKg = entity.total_weight ? total_cost / entity.total_weight : 0;
  const modalHTML = `
<div class="form-group">
  <label>Customer</label>
  <select class="input" id="sell_customer_id" data-field="customer_id">${custOptions}</select>
</div>
<div class="form-group">
  <label>Weight to Sell (kg)</label>
  <input type="number" class="input" id="sell_weight_sold" data-field="weight_sold" placeholder="0.00" min="0.01" step="0.01" max="${remaining}" value="" />
  <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Remaining: ${fmtWeight(remaining)}</div>
</div>
<div class="form-group">
  <label>Price per kg (on which bought) — Cost Basis</label>
  <input type="text" class="input" disabled value="${costPricePerKg ? fmt(costPricePerKg) + '/kg' : 'N/A'}" />
  <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Your cost for reference</div>
</div>
<div class="form-grid">
  <div class="form-group">
    <label>Total Selling Price ($)</label>
    <input type="number" class="input" id="sell_total_price" data-field="total_price" placeholder="0.00" min="0" step="0.01" value="" />
  </div>
  <div class="form-group">
    <label>Price per kg (on which you are selling) ($)</label>
    <input type="number" class="input" id="sell_price_per_kg" data-field="price_per_kg" placeholder="0.00" min="0" step="0.01" value="" />
  </div>
</div>
<div class="form-group">
  <label>Initial Payment Amount ($)</label>
  <input type="number" class="input" id="sell_initial_payment" data-field="initial_payment" placeholder="0.00" min="0" step="0.01" value="" />
  <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Leave blank or enter partial amount for later payments</div>
</div>
<div class="form-group">
  <label>Payment Method</label>
  <select class="input" data-field="method">
    <option>Cash</option><option>Bank Transfer</option><option>Cheque</option><option>Other</option>
  </select>
</div>
<div class="form-group">
  <label>Date</label>
  <input type="date" class="input" data-field="date" value="${new Date().toISOString().slice(0, 10)}" />
</div>
`;
  const result = await openModal('Sell ' + entity.name, modalHTML, 'Record Sale');
  if (!result) return;
  const v = getModalValues();
  if (!v.customer_id || !v.weight_sold) { toast('Customer and weight required', 'warning'); return; }
  const weightSold = Number(v.weight_sold);
  if (weightSold > remaining) { toast(`Cannot sell more than remaining: ${fmtWeight(remaining)}`, 'error'); return; }
  let totalPrice = v.total_price ? Number(v.total_price) : 0;
  let pricePerKg = v.price_per_kg ? Number(v.price_per_kg) : 0;
  if (totalPrice === 0 && pricePerKg > 0) {
    totalPrice = pricePerKg * weightSold;
  } else if (pricePerKg === 0 && totalPrice > 0) {
    pricePerKg = totalPrice / weightSold;
  }
  if (totalPrice === 0) {
    toast('Please enter either Total Selling Price or Price per kg', 'warning');
    return;
  }
  let initialPayment = v.initial_payment ? Number(v.initial_payment) : totalPrice;
  if (!entity.sale) {
    entity.sale = {
      customer_id: v.customer_id,
      payments: [],
      total_price: totalPrice,
      sales: []
    };
  } else if (!entity.sale.sales) {
    entity.sale.sales = [];
    entity.sale.total_price = totalPrice;
  }
  entity.sale.sales.push({
    weight_sold: weightSold,
    total_price: totalPrice,
    price_per_kg: pricePerKg,
    cost_price_per_kg: costPricePerKg,
    date: v.date,
    method: v.method
  });
  entity.sold_weight = (entity.sold_weight || 0) + weightSold;
  if (initialPayment > 0) {
    entity.sale.payments.push({
      amount_paid: initialPayment,
      date: v.date,
      method: v.method,
      note: 'Initial payment'
    });
  }

  // FIX 5: Only update lot.sold_weight for item-level sales.
  //         Subitem sales must NOT update lot.sold_weight — doing so would
  //         double-count the same physical weight already tracked by the item.
  if (type === 'item') {
    const { lot } = findItem(id);
    if (lot) {
      lot.sold_weight = (lot.sold_weight || 0) + weightSold;
    }
  }
  // type === 'subitem': intentionally do NOT touch lot.sold_weight

  saveDB();
  const balance = totalPrice - initialPayment;
  toast(`${entity.name}: ${fmtWeight(weightSold)} sold for ${fmt(totalPrice)}! ${balance > 0 ? `(${fmt(balance)} pending)` : 'Paid in full'}`, 'success');
  if (type === 'item') refreshItemDetail(entity);
  else if (parentItem) refreshItemDetail(parentItem);
}

// ============================================================
// ADD PAYMENT
// ============================================================
async function addPaymentTo(type, id, parentItem = null) {
  let sale;
  let entity;
  if (type === 'item') {
    const { item } = findItem(id);
    sale = item?.sale;
    entity = item;
    parentItem = item;
  } else if (type === 'subitem') {
    const { sub } = findSubitem(id);
    sale = sub?.sale;
    entity = sub;
  }
  if (!sale || !sale.total_price) { toast('No sale found. Sell the item first.', 'warning'); return; }
  const totalPaid = (sale.payments || []).reduce((s, p) => s + (p.amount_paid || 0), 0);
  const remaining = (sale.total_price || 0) - totalPaid;
  if (remaining <= 0) {
    toast('This sale is already paid in full!', 'warning');
    return;
  }
  const result = await openModal('Add Payment', `
<div class="form-group">
  <label>Amount Paid</label>
  <input type="number" class="input" data-field="amount" placeholder="0.00" min="0" step="0.01" max="${remaining}" />
  <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Remaining balance: ${fmt(remaining)}</div>
</div>
<div class="form-group">
  <label>Method</label>
  <select class="input" data-field="method">
    <option>Cash</option><option>Bank Transfer</option><option>Cheque</option><option>Other</option>
  </select>
</div>
<div class="form-group">
  <label>Date</label>
  <input type="date" class="input" data-field="date" value="${new Date().toISOString().slice(0, 10)}" />
</div>
<div class="form-group">
  <label>Note (optional)</label>
  <input type="text" class="input" data-field="note" placeholder="e.g. Second installment" />
</div>
`, 'Add Payment');
  if (!result) return;
  const v = getModalValues();
  if (!v.amount || Number(v.amount) <= 0) { toast('Amount required', 'warning'); return; }
  const paymentAmount = Number(v.amount);
  if (paymentAmount > remaining) {
    toast(`Payment exceeds remaining balance: ${fmt(remaining)}`, 'error');
    return;
  }
  sale.payments.push({
    amount_paid: paymentAmount,
    date: v.date,
    method: v.method,
    note: v.note || 'Additional payment'
  });
  saveDB();
  const newRemaining = remaining - paymentAmount;
  toast(`Payment of ${fmt(paymentAmount)} recorded! ${newRemaining > 0 ? `${fmt(newRemaining)} remaining` : 'Paid in full!'}`, 'success');
  if (parentItem) refreshItemDetail(parentItem);
}

// ============================================================
// ADD PROCESSING
// ============================================================
async function addProcessingTo(type, id, parentItem = null) {
  let records;
  if (type === 'item') {
    const { item } = findItem(id);
    records = item?.processing_records;
  } else if (type === 'subitem') {
    const { sub } = findSubitem(id);
    records = sub?.processing_records;
  } else if (type === 'lot') {
    const { lot } = findLot(id);
    records = lot?.processing_records;
  }
  if (!records) return;
  const result = await openModal('Add Processing Record', `
<div class="form-group">
  <label>Type</label>
  <input type="text" class="input" data-field="type" placeholder="e.g. Cutting, Grinding..." />
</div>
<div class="form-group">
  <label>Worker</label>
  <input type="text" class="input" data-field="worker" placeholder="Worker name" />
</div>
<div class="form-group">
  <label>Labour Fee</label>
  <input type="number" class="input" data-field="fee" placeholder="0.00" min="0" step="0.01" />
</div>
`, 'Add Record');
  if (!result) return;
  const v = getModalValues();
  if (!v.type || !v.worker || !v.fee) { toast('All fields required', 'warning'); return; }
  records.push(makeProcessingRecord(v.type, v.worker, Number(v.fee)));
  saveDB();
  toast('Processing record added', 'success');
  if (type === 'lot') {
    const { lot } = findLot(id);
    renderProcessingList('lotProcessingList', records, () => renderLotInfoGrid(lot));
    renderLotInfoGrid(lot);
  } else if (type === 'item') {
    const { item } = findItem(id);
    refreshItemDetail(item);
  } else if (type === 'subitem' && parentItem) {
    refreshItemDetail(parentItem);
  }
}

// ============================================================
// DELETE CONFIRMATION
// ============================================================
async function confirmDelete(type, id, name) {
  const result = await openModal(
    'Confirm Delete',
    `<div style="color:var(--text-sec);font-size:13px">
Are you sure you want to <strong style="color:var(--red)">permanently delete</strong> <strong style="color:var(--text-pri)">${name}</strong>?
<br><br>
<span style="color:var(--yellow)">⚠ This will remove ALL sale history and processing records.</span>
<br><br>
💡 Tip: Use "Deplete" instead to mark as sold-out while keeping history.
</div>`,
    'Permanently Delete'
  );
  if (!result) return;
  if (type === 'truck') {
    delete DB.trucks[id];
    saveDB();
    toast(`Truck "${name}" deleted`, 'info');
    renderTrucks();
  } else if (type === 'lot') {
    const { truck } = findLot(id);
    delete truck.lots[id];
    saveDB();
    toast(`Lot "${name}" deleted`, 'info');
    renderLotList(truck);
  } else if (type === 'item') {
    const { lot, item } = findItem(id);
    if (item.sale?.payments?.length) {
      const confirmHard = await openModal(
        'Delete with Sales?',
        `<div style="color:var(--text-sec);font-size:13px">
This item has <strong>${item.sale.payments.length} payment record(s)</strong>.
<br><br>
Delete permanently (lose history) or mark as depleted (keep history)?
</div>`,
        'Delete Permanently'
      );
      if (!confirmHard) {
        markDepleted('item', id);
        return;
      }
    }
    delete lot.items[id];
    saveDB();
    toast(`Item "${name}" deleted`, 'info');
    renderItemList(lot);
  } else if (type === 'customer') {
    delete DB.customers[id];
    saveDB();
    toast(`Customer "${name}" deleted`, 'info');
    renderCustomers();
  } else if (type === 'mill') {
    delete DB.mills[id];
    saveDB();
    toast(`Mill "${name}" deleted`, 'info');
    renderMills();
  }
}

// ============================================================
// ADD FORMS
//
// FIX 3: Budget check only fires when lot.initial_cost > 0.
//         Zero = no budget cap set, so items can be added freely.
// FIX 4: Weight check only fires when lot.total_weight > 0.
//         Zero = no weight cap set, so items can be added freely.
// ============================================================
async function addTruck() {
  const result = await openModal('Add Truck', `
<div class="form-group">
  <label>Truck Name</label>
  <input type="text" class="input" data-field="name" placeholder="e.g. Truck Alpha" />
</div>
<div class="form-group">
  <label>Description</label>
  <input type="text" class="input" data-field="description" placeholder="Optional description" />
</div>
`, 'Add Truck');
  if (!result) return;
  const v = getModalValues();
  if (!v.name) { toast('Name required', 'warning'); return; }
  const truck = makeTruck(v.name, v.description);
  DB.trucks[truck.id] = truck;
  saveDB();
  toast(`Truck "${truck.name}" added`, 'success');
  renderTrucks();
}

async function addLot() {
  const truck = DB.trucks[currentTruckId];
  if (!truck) return;
  const result = await openModal('Add Lot', `
<div class="form-group">
  <label>Lot Name</label>
  <input type="text" class="input" data-field="name" placeholder="Lot name" />
</div>
<div class="form-group">
  <label>Initial Cost ($)</label>
  <input type="number" class="input" data-field="initial_cost" placeholder="0.00" min="0" step="0.01" value="0" />
</div>
<div class="form-group">
  <label>Mill (type to create new)</label>
  <input type="text" class="input" data-field="mill_name" list="mill-datalist" placeholder="Mill name" />
  <datalist id="mill-datalist">
    ${Object.values(DB.mills).map(m => `<option value="${m.name}">`).join('')}
  </datalist>
</div>
<div class="form-group">
  <label>Total Weight Capacity (kg)</label>
  <input type="number" class="input" data-field="total_weight" placeholder="0" min="0" step="0.01" value="0" />
</div>
`, 'Add Lot');
  if (!result) return;
  const v = getModalValues();
  if (!v.name) { toast('Name required', 'warning'); return; }
  let mill_id = null;
  if (v.mill_name && v.mill_name.trim()) {
    const mill = getOrCreateMill(v.mill_name);
    mill_id = mill.id;
  }
  const lot = makeLot(v.name, Number(v.initial_cost) || 0, mill_id, Number(v.total_weight) || 0);
  truck.lots[lot.id] = lot;
  saveDB();
  toast(`Lot "${lot.name}" added`, 'success');
  renderLotList(truck);
}

async function addItem() {
  const { lot } = findLot(currentLotId);
  if (!lot) return;
  const result = await openModal('Add Item', `
<div class="form-group">
  <label>Item Name</label>
  <input type="text" class="input" data-field="name" placeholder="Item name" />
</div>
<div class="form-group">
  <label>Initial Cost ($)</label>
  <input type="number" class="input" data-field="initial_cost" placeholder="0.00" min="0" step="0.01" value="0" />
</div>
<div class="form-group">
  <label>Total Weight (kg, optional)</label>
  <input type="number" class="input" data-field="total_weight" placeholder="Optional" min="0" step="0.01" />
</div>
`, 'Add Item');
  if (!result) return;
  const v = getModalValues();
  if (!v.name) { toast('Name required', 'warning'); return; }

  const newCost = Number(v.initial_cost) || 0;

  // FIX 3: Only enforce budget if lot has a non-zero initial_cost cap
  if (lot.initial_cost > 0 && newCost > 0) {
    const used = getCurrentLotInitialUsage(lot);
    const remaining = lot.initial_cost - used;
    if (newCost > remaining) {
      toast(`Initial cost exceeds lot limit. Remaining: ${fmt(remaining)}`, 'error');
      return;
    }
  }

  const newWeight = v.total_weight !== '' && v.total_weight !== null ? Number(v.total_weight) : null;

  // FIX 4: Only enforce weight cap if lot has a non-zero total_weight cap
  if (lot.total_weight > 0 && newWeight !== null && newWeight > 0) {
    const usedWeight = getCurrentLotWeightUsage(lot);
    const remainingWeight = lot.total_weight - usedWeight;
    if (newWeight > remainingWeight) {
      toast(`Weight exceeds lot limit. Remaining: ${fmtWeight(remainingWeight)}`, 'error');
      return;
    }
  }

  const item = makeItem(v.name, newCost, newWeight);
  lot.items[item.id] = item;
  saveDB();
  toast(`Item "${item.name}" added`, 'success');
  renderItemList(lot);
}

async function addSubitem() {
  const { item } = findItem(currentItemId);
  if (!item) return;
  const { lot } = findLot(currentLotId);
  if (!lot) return;
  const result = await openModal('Add Subitem', `
<div class="form-group">
  <label>Subitem Name</label>
  <input type="text" class="input" data-field="name" placeholder="Subitem name" />
</div>
<div class="form-group">
  <label>Initial Cost ($)</label>
  <input type="number" class="input" data-field="initial_cost" placeholder="0.00" min="0" step="0.01" value="0" />
</div>
<div class="form-group">
  <label>Total Weight (kg, optional)</label>
  <input type="number" class="input" data-field="total_weight" placeholder="Optional" min="0" step="0.01" />
</div>
`, 'Add Subitem');
  if (!result) return;
  const v = getModalValues();
  if (!v.name) { toast('Name required', 'warning'); return; }

  const newCost = Number(v.initial_cost) || 0;

  // FIX 3: Only enforce budget if lot has a non-zero initial_cost cap
  if (lot.initial_cost > 0 && newCost > 0) {
    const used = getCurrentLotInitialUsage(lot);
    const remaining = lot.initial_cost - used;
    if (newCost > remaining) {
      toast(`Initial cost exceeds lot limit. Remaining: ${fmt(remaining)}`, 'error');
      return;
    }
  }

  const newWeight = v.total_weight !== '' && v.total_weight !== null ? Number(v.total_weight) : null;

  // FIX 4: Only enforce weight cap if lot has a non-zero total_weight cap
  if (lot.total_weight > 0 && newWeight !== null && newWeight > 0) {
    const usedWeight = getCurrentLotWeightUsage(lot);
    const remainingWeight = lot.total_weight - usedWeight;
    if (newWeight > remainingWeight) {
      toast(`Weight exceeds lot limit. Remaining: ${fmtWeight(remainingWeight)}`, 'error');
      return;
    }
  }

  const sub = makeSubitem(v.name, newCost, newWeight);
  item.subitems[sub.id] = sub;
  saveDB();
  toast(`Subitem "${sub.name}" added`, 'success');
  refreshItemDetail(item);
}

async function addCustomer() {
  const result = await openModal('Add Customer', `
<div class="form-group">
  <label>Name</label>
  <input type="text" class="input" data-field="name" placeholder="Customer name" />
</div>
<div class="form-group">
  <label>Phone</label>
  <input type="text" class="input" data-field="phone" placeholder="Phone number" />
</div>
`, 'Add Customer');
  if (!result) return;
  const v = getModalValues();
  if (!v.name) { toast('Name required', 'warning'); return; }
  const c = makeCustomer(v.name, v.phone);
  DB.customers[c.id] = c;
  saveDB();
  toast(`Customer "${c.name}" added`, 'success');
  renderCustomers();
}

async function addMill() {
  const result = await openModal('Add Mill', `
<div class="form-group">
  <label>Mill Name</label>
  <input type="text" class="input" data-field="name" placeholder="Mill name" />
</div>
`, 'Add Mill');
  if (!result) return;
  const v = getModalValues();
  if (!v.name) { toast('Name required', 'warning'); return; }
  const mill = getOrCreateMill(v.name);
  toast(`Mill "${mill.name}" ${DB.mills[mill.id] ? 'already exists, reused.' : 'added.'}`, 'success');
  renderMills();
}

// ============================================================
// UTILITY
// ============================================================
function emptyState(icon, text) {
  return `<div class="empty-state">
<div class="empty-icon">${icon}</div>
<div class="empty-text">${text}</div>
</div>`;
}

// ============================================================
// EVENT BINDINGS
// ============================================================
// ============================================================
// EVENT BINDINGS
// ============================================================
function bindEvents() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });

  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });

  document.getElementById('modalClose').addEventListener('click', () => closeModal(null));
  document.getElementById('modalCancel').addEventListener('click', () => closeModal(null));
  document.getElementById('modalConfirm').addEventListener('click', () => closeModal(true));

  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modalOverlay')) closeModal(null);
  });

  document.getElementById('addTruckBtn').addEventListener('click', addTruck);

  document.getElementById('backToTrucks').addEventListener('click', () => {
    document.getElementById('truckDetail').classList.add('hidden');
    document.getElementById('truckList').classList.remove('hidden');
    document.getElementById('breadcrumb').textContent = '';
  });

  document.getElementById('addLotBtn').addEventListener('click', addLot);

  document.getElementById('backToLots').addEventListener('click', () => {
    currentLotId = null;
    document.getElementById('lotDetail').classList.add('hidden');
    document.getElementById('truckDetail').classList.remove('hidden');
  });

  document.getElementById('addLotProcessingBtn').addEventListener('click', () => {
    addProcessingTo('lot', currentLotId);
  });

  document.getElementById('addItemBtn').addEventListener('click', addItem);

  document.getElementById('backToItems').addEventListener('click', () => {
    currentItemId = null;
    document.getElementById('itemDetail').classList.add('hidden');
    document.getElementById('lotDetail').classList.remove('hidden');
    const { lot } = findLot(currentLotId);
    if (lot) renderLotInfoGrid(lot);
  });

  document.getElementById('addItemProcessingBtn').addEventListener('click', () => {
    addProcessingTo('item', currentItemId);
  });

  document.getElementById('addSubitemBtn').addEventListener('click', addSubitem);

  document.getElementById('sellItemBtn').addEventListener('click', () => {
    sellEntity('item', currentItemId);
  });

  document.getElementById('addCustomerBtn').addEventListener('click', addCustomer);
  document.getElementById('addMillBtn').addEventListener('click', addMill);

  // Profit report: entity type change → refresh options + hide result
  document.getElementById('profitEntityType').addEventListener('change', () => {
    updateProfitEntityOptions();
    document.getElementById('profitResult').classList.add('hidden');
  });

  // Profit report: calculate button
  document.getElementById('calcProfitBtn').addEventListener('click', renderProfitResult);
  // Add this inside bindEvents(), after existing listeners:

  // Mobile sidebar overlay toggle
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');

  // Toggle sidebar on mobile
  sidebarToggle.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      sidebar.classList.toggle('active');
      sidebarOverlay.classList.toggle('active');
    } else {
      sidebar.classList.toggle('collapsed');
    }
  });

  // Close sidebar when clicking overlay
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
      sidebar.classList.remove('active');
      sidebarOverlay.classList.remove('active');
    });
  }

  // Close sidebar when navigating on mobile
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        sidebar.classList.remove('active');
        sidebarOverlay.classList.remove('active');
      }
    });
  });
  // Navigation buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.view);
      // Close mobile sidebar after navigation
      if (window.innerWidth <= 768) {
        closeMobileSidebar();
      }
    });
  });

  // Desktop sidebar toggle (inside sidebar)

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      if (window.innerWidth > 768) {
        // Desktop: collapse/expand sidebar
        document.getElementById('sidebar').classList.toggle('collapsed');
      } else {
        // Mobile: toggle sidebar visibility
        toggleMobileSidebar();
      }
    });
  }

  // Mobile hamburger menu button (in topbar)
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', () => {
      toggleMobileSidebar();
    });
  }

  // Sidebar overlay click to close
 
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
      closeMobileSidebar();
    });
  }

  // Modal controls
  document.getElementById('modalClose').addEventListener('click', () => closeModal(null));
  document.getElementById('modalCancel').addEventListener('click', () => closeModal(null));
  document.getElementById('modalConfirm').addEventListener('click', () => closeModal(true));
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modalOverlay')) closeModal(null);
  });

  // ... rest of your existing event listeners ...
  document.getElementById('addTruckBtn').addEventListener('click', addTruck);
  document.getElementById('backToTrucks').addEventListener('click', () => {
    document.getElementById('truckDetail').classList.add('hidden');
    document.getElementById('truckList').classList.remove('hidden');
    document.getElementById('breadcrumb').textContent = '';
  });
  document.getElementById('addLotBtn').addEventListener('click', addLot);
  document.getElementById('backToLots').addEventListener('click', () => {
    currentLotId = null;
    document.getElementById('lotDetail').classList.add('hidden');
    document.getElementById('truckDetail').classList.remove('hidden');
  });
  document.getElementById('addLotProcessingBtn').addEventListener('click', () => {
    addProcessingTo('lot', currentLotId);
  });
  document.getElementById('addItemBtn').addEventListener('click', addItem);
  document.getElementById('backToItems').addEventListener('click', () => {
    currentItemId = null;
    document.getElementById('itemDetail').classList.add('hidden');
    document.getElementById('lotDetail').classList.remove('hidden');
    const { lot } = findLot(currentLotId);
    if (lot) renderLotInfoGrid(lot);
  });
  document.getElementById('addItemProcessingBtn').addEventListener('click', () => {
    addProcessingTo('item', currentItemId);
  });
  document.getElementById('addSubitemBtn').addEventListener('click', addSubitem);
  document.getElementById('sellItemBtn').addEventListener('click', () => {
    sellEntity('item', currentItemId);
  });
  document.getElementById('addCustomerBtn').addEventListener('click', addCustomer);
  document.getElementById('addMillBtn').addEventListener('click', addMill);

  // Profit report controls
  document.getElementById('profitEntityType').addEventListener('change', () => {
    updateProfitEntityOptions();
    document.getElementById('profitResult').classList.add('hidden');
  });
  document.getElementById('calcProfitBtn').addEventListener('click', renderProfitResult);

}
// ============================================================
// MOBILE SIDEBAR HELPERS (add these new functions)
// ============================================================
function toggleMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');

  sidebar.classList.toggle('active');
  overlay.classList.toggle('active');
  if (mobileMenuBtn) mobileMenuBtn.classList.toggle('active');

  // Prevent body scroll when sidebar is open
  document.body.style.overflow = sidebar.classList.contains('active') ? 'hidden' : '';
}

function closeMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');

  sidebar.classList.remove('active');
  overlay.classList.remove('active');
  if (mobileMenuBtn) mobileMenuBtn.classList.remove('active');
  document.body.style.overflow = '';
}

// Handle window resize
window.addEventListener('resize', () => {
  if (window.innerWidth > 768) {
    closeMobileSidebar();
  }
});
// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  loadDB();
  bindEvents();
  navigate('dashboard');
})
// Add near end of app.js, after DOMContentLoaded
window.addEventListener('resize', () => {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (window.innerWidth > 768) {
    sidebar.classList.remove('active');
    overlay.classList.remove('active');
  }
});
