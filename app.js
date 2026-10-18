// =========================================================================
    // STEP 1 DATA & FORMULAS: SALES, DEMAND PREDICTION & SAFETY STOCK ENGINE
    // =========================================================================
    const STORAGE_KEY = 'smartstock_inventory_state_v2';
    const LEGACY_STORAGE_KEY = 'smartstock_step1_state_v1';
    // BSP reference rate on 16 Oct 2026, used only to convert saved USD values once.
    const LEGACY_USD_TO_PHP = 63.049;
    const currencyFormatter = new Intl.NumberFormat('en-PH', {
      style: 'currency',
      currency: 'PHP',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    let stateNotice = '';
    let storageUnavailable = false;

    const DEFAULT_PRODUCTS = [
      {
        id: 'p1',
        name: 'Industrial Thermal Printer',
        sku: 'SKU-101',
        cost: 7565.88,
        price: 12294.56,
        stock: 95,      // Intentionally overstocked so user immediately sees Excess Inventory detection
        avgSales: 4,
        maxSales: 6,
        avgLead: 5,
        maxLead: 8,
        soldCount: 18
      },
      {
        id: 'p2',
        name: 'Wireless Barcode Scanner',
        sku: 'SKU-102',
        cost: 2206.72,
        price: 4098.19,
        stock: 48,      // In Optimal range
        avgSales: 5,
        maxSales: 8,
        avgLead: 4,
        maxLead: 6,
        soldCount: 32
      },
      {
        id: 'p3',
        name: 'Heavy-Duty Shipping Scale',
        sku: 'SKU-103',
        cost: 3467.70,
        price: 6241.85,
        stock: 14,      // Below Reorder Point so user sees Reorder Alert
        avgSales: 3,
        maxSales: 5,
        avgLead: 4,
        maxLead: 7,
        soldCount: 21
      },
      {
        id: 'p4',
        name: 'RFID Inventory Tag Roll (500pk)',
        sku: 'SKU-104',
        cost: 2521.96,
        price: 4728.68,
        stock: 160,     // Excess stock example
        avgSales: 6,
        maxSales: 9,
        avgLead: 5,
        maxLead: 7,
        soldCount: 45
      }
    ];

    const DEFAULT_TRANSACTIONS = [
      { id: 't1', time: '09:15 AM', productName: 'Wireless Barcode Scanner', type: 'SALE', qty: 4, amount: 16392.74, note: 'Morning retail counter order' },
      { id: 't2', time: '10:40 AM', productName: 'Industrial Thermal Printer', type: 'RESTOCK', qty: 30, amount: 226976.40, note: 'Supplier batch shipment #88' },
      { id: 't3', time: '01:20 PM', productName: 'Heavy-Duty Shipping Scale', type: 'SALE', qty: 3, amount: 18725.55, note: 'Warehouse B fulfillment' }
    ];

    let appState = {
      currency: 'PHP',
      products: [],
      transactions: [],
      holdingRate: 0.25
    };

    let inventoryChartInstance = null;

    // Load or initialize state safely
    function loadState() {
      try {
        const current = localStorage.getItem(STORAGE_KEY);
        if (current) {
          const parsed = JSON.parse(current);
          if (parsed && Array.isArray(parsed.products)) {
            appState = { ...parsed, currency: 'PHP', transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [] };
            return;
          }
          throw new Error('Saved inventory has an invalid format.');
        }

        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) {
          const parsed = JSON.parse(legacy);
          if (!parsed || !Array.isArray(parsed.products)) throw new Error('Saved inventory has an invalid format.');
          const toPhp = amount => Math.round((Number(amount) || 0) * LEGACY_USD_TO_PHP * 100) / 100;
          parsed.products.forEach(product => {
            product.cost = toPhp(product.cost);
            product.price = toPhp(product.price);
          });
          parsed.transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
          parsed.transactions.forEach(transaction => { transaction.amount = toPhp(transaction.amount); });
          appState = { ...parsed, currency: 'PHP' };
          if (saveState()) stateNotice = 'Saved prices were converted to PHP using the BSP reference rate from 16 Oct 2026.';
          return;
        }
      } catch (e) {
        stateNotice = 'Saved data could not be read, so demo inventory was loaded. Reset the demo after adding products to save a fresh copy.';
      }
      appState = {
        currency: 'PHP',
        products: JSON.parse(JSON.stringify(DEFAULT_PRODUCTS)),
        transactions: JSON.parse(JSON.stringify(DEFAULT_TRANSACTIONS)),
        holdingRate: 0.25
      };
    }

    function saveState() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
        storageUnavailable = false;
        return true;
      } catch (e) {
        storageUnavailable = true;
        return false;
      }
    }

    // Core Supply Chain Math Function for a single product
    function computeMetrics(prod, holdingRate) {
      const avgSales = Math.max(0, Number(prod.avgSales) || 0);
      const maxSales = Math.max(avgSales, Number(prod.maxSales) || avgSales);
      const avgLead = Math.max(1, Number(prod.avgLead) || 1);
      const maxLead = Math.max(avgLead, Number(prod.maxLead) || avgLead);
      const stock = Math.max(0, Math.round(Number(prod.stock) || 0));
      const cost = Math.max(0, Number(prod.cost) || 0);
      const price = Math.max(0, Number(prod.price) || 0);

      // 1. Safety Stock = (Max Daily Sales * Max Lead Time) - (Avg Daily Sales * Avg Lead Time)
      const safetyStock = Math.max(0, Math.round((maxSales * maxLead) - (avgSales * avgLead)));

      // 2. Reorder Point (ROP) = (Avg Daily Sales * Avg Lead Time) + Safety Stock
      const leadTimeDemand = Math.round(avgSales * avgLead);
      const reorderPoint = leadTimeDemand + safetyStock;

      // 3. 7-Day Predicted Customer Demand
      const weeklyDemand = Math.round(avgSales * 7);

      // 4. Max Optimal Ceiling = Reorder Point + 7-Day Cycle Stock (minimum buffer of 10 if avgSales is 0)
      const cycleBuffer = weeklyDemand > 0 ? weeklyDemand : 10;
      const maxOptimal = reorderPoint + cycleBuffer;

      // 5. Determine Excess Inventory or Reorder Deficit
      let status = 'OPTIMAL';
      let excessUnits = 0;
      let orderNeeded = 0;

      if (stock > maxOptimal) {
        status = 'EXCESS';
        excessUnits = stock - maxOptimal;
      } else if (stock <= reorderPoint) {
        status = 'REORDER';
        orderNeeded = Math.max(1, maxOptimal - stock);
      }

      const excessCapital = excessUnits * cost;
      const annualExcessTaxAndSpaceCost = excessCapital * holdingRate;

      return {
        safetyStock,
        reorderPoint,
        weeklyDemand,
        maxOptimal,
        status,
        excessUnits,
        orderNeeded,
        excessCapital,
        annualExcessTaxAndSpaceCost,
        stockValue: stock * cost,
        revenueGenerated: (Number(prod.soldCount) || 0) * price
      };
    }

    function formatCurrency(num) {
      return currencyFormatter.format(Number(num) || 0);
    }

    function showToast(msg) {
      const box = document.getElementById('toastBox');
      const text = document.getElementById('toastMessage');
      text.textContent = storageUnavailable
        ? 'Changes could not be saved in this browser. Export a copy before closing this tab.'
        : msg;
      box.classList.remove('hidden');
      clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => {
        box.classList.add('hidden');
      }, 2600);
    }

    // Update Live Preview inside the Add/Edit Form
    function updateFormPreview() {
      const tempProd = {
        stock: document.getElementById('prodStock').value,
        cost: document.getElementById('prodCost').value,
        price: document.getElementById('prodPrice').value,
        avgSales: document.getElementById('prodAvgSales').value,
        maxSales: document.getElementById('prodMaxSales').value,
        avgLead: document.getElementById('prodAvgLead').value,
        maxLead: document.getElementById('prodMaxLead').value
      };
      const m = computeMetrics(tempProd, appState.holdingRate);
      document.getElementById('previewSafetyStock').textContent = m.safetyStock + '\u00a0units';
      document.getElementById('previewRop').textContent = m.reorderPoint + '\u00a0units';
      document.getElementById('previewCeiling').textContent = m.maxOptimal + '\u00a0units';

      const badge = document.getElementById('previewStatusBadge');
      if (m.status === 'EXCESS') {
        badge.textContent = 'Excess stock (+' + m.excessUnits + '\u00a0units over ceiling)';
        badge.className = 'font-semibold text-amber-600';
      } else if (m.status === 'REORDER') {
        badge.textContent = 'Low stock (order ' + m.orderNeeded + '\u00a0units)';
        badge.className = 'font-semibold text-rose-600';
      } else {
        badge.textContent = 'Optimal Stock Level';
        badge.className = 'font-semibold text-emerald-600';
      }
    }

    // Render all KPIs, Tables, Dropdowns, and Chart
    function renderAll() {
      const rate = Number(appState.holdingRate) || 0.25;
      let totalUnits = 0;
      let totalValue = 0;
      let totalWeeklyDemand = 0;
      let totalSafetyStock = 0;
      let totalExcessUnits = 0;
      let totalExcessCost = 0;
      let totalUnitsSold = 0;
      let totalRevenue = 0;
      let reorderItemsCount = 0;

      appState.products.forEach(p => {
        const m = computeMetrics(p, rate);
        totalUnits += Number(p.stock) || 0;
        totalValue += m.stockValue;
        totalWeeklyDemand += m.weeklyDemand;
        totalSafetyStock += m.safetyStock;
        totalExcessUnits += m.excessUnits;
        totalExcessCost += m.annualExcessTaxAndSpaceCost;
        totalUnitsSold += Number(p.soldCount) || 0;
        totalRevenue += m.revenueGenerated;
        if (m.status === 'REORDER') reorderItemsCount++;
      });

      document.getElementById('kpiSkuCount').textContent = appState.products.length.toLocaleString('en-PH') + '\u00a0SKUs';
      document.getElementById('kpiTotalUnits').textContent = totalUnits.toLocaleString('en-PH') + '\u00a0units';
      document.getElementById('kpiTotalValue').textContent = formatCurrency(totalValue);
      document.getElementById('kpiPredictedDemand').textContent = totalWeeklyDemand.toLocaleString('en-PH') + '\u00a0units';
      document.getElementById('kpiSafetyStockTotal').textContent = totalSafetyStock.toLocaleString('en-PH') + '\u00a0units';
      document.getElementById('kpiExcessUnits').textContent = totalExcessUnits.toLocaleString('en-PH') + '\u00a0units';
      document.getElementById('kpiExcessCost').textContent = formatCurrency(totalExcessCost) + '\u00a0/yr';
      document.getElementById('kpiUnitsSold').textContent = totalUnitsSold.toLocaleString('en-PH') + '\u00a0sold';
      document.getElementById('kpiSalesRevenue').textContent = formatCurrency(totalRevenue);
      document.getElementById('kpiReorderCount').textContent = reorderItemsCount + (reorderItemsCount === 1 ? ' item' : ' items');

      const hasProducts = appState.products.length > 0;
      document.getElementById('btnExportCsv').disabled = !hasProducts;
      document.getElementById('btnCopyReportText').disabled = !hasProducts;

      renderInventoryTable(rate);
      renderTransactionSelectAndLog();
      renderReportTableAndChart(rate);
      updateFormPreview();
      document.querySelector('main').setAttribute('aria-busy', 'false');
    }

    function renderInventoryTable(rate) {
      const tbody = document.getElementById('inventoryTableBody');
      const search = (document.getElementById('searchInventoryInput').value || '').trim().toLowerCase();
      const statusFilter = document.getElementById('filterStatusSelect').value;

      const filtered = appState.products.filter(p => {
        const m = computeMetrics(p, rate);
        const matchesSearch = p.name.toLowerCase().includes(search) || p.sku.toLowerCase().includes(search);
        const matchesStatus = statusFilter === 'ALL' || m.status === statusFilter;
        return matchesSearch && matchesStatus;
      });

      if (filtered.length === 0) {
        const emptyMessage = appState.products.length === 0
          ? 'No products yet. Add an item to start tracking stock.'
          : 'No products match this search. Clear the search or status filter.';
        const actionLabel = appState.products.length === 0 ? 'Add first product' : 'Clear filters';
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state"><p>${emptyMessage}</p><button type="button" data-action="${appState.products.length === 0 ? 'add-first' : 'clear-filters'}">${actionLabel}</button></td></tr>`;
        return;
      }

      tbody.innerHTML = filtered.map(p => {
        const m = computeMetrics(p, rate);
        let badgeHtml = '';
        if (m.status === 'EXCESS') {
          badgeHtml = `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800">Excess: +${m.excessUnits}&nbsp;units</span>
                       <div class="text-[11px] text-amber-700 mt-0.5">Est. holding cost ${formatCurrency(m.annualExcessTaxAndSpaceCost)}/yr</div>`;
        } else if (m.status === 'REORDER') {
          badgeHtml = `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-100 text-rose-800">Reorder now (${m.orderNeeded}&nbsp;units)</span>
                       <div class="text-[11px] text-rose-600 mt-0.5">At/below ROP (${m.reorderPoint})</div>`;
        } else {
          badgeHtml = `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800">Optimal Stock</span>
                       <div class="text-[11px] text-slate-400 mt-0.5">Lean &amp; protected</div>`;
        }

        return `
          <tr class="hover:bg-slate-50/80 transition">
            <td class="py-3 px-3">
              <div class="font-semibold text-slate-900">${escapeHtml(p.name)}</div>
              <div class="text-[11px] text-slate-500"><span translate="no">${escapeHtml(p.sku)}</span> &bull; Cost: ${formatCurrency(p.cost)} &bull; Price: ${formatCurrency(p.price)}</div>
            </td>
            <td class="py-3 px-3 text-center">
              <div class="font-bold text-sm text-slate-900">${p.stock}</div>
              <div class="inline-flex items-center gap-1 mt-1">
                <button type="button" data-action="quick-sale" data-id="${escapeHtml(p.id)}" class="px-2 py-0.5 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 text-[11px] font-semibold" title="Record 1 unit sold" aria-label="Record one sale of ${escapeHtml(p.name)}" ${p.stock <= 0 ? 'disabled' : ''}>-1 Sale</button>
                <button type="button" data-action="quick-restock" data-id="${escapeHtml(p.id)}" class="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-semibold" title="Add 10 units to stock" aria-label="Restock 10 units of ${escapeHtml(p.name)}">+10</button>
              </div>
            </td>
            <td class="py-3 px-3 text-center">
              <div class="font-semibold text-indigo-600">${m.weeklyDemand}&nbsp;units</div>
              <div class="text-[11px] text-slate-400">${p.avgSales}/day avg</div>
            </td>
            <td class="py-3 px-3 text-center">
              <div class="font-semibold text-slate-800">${m.safetyStock}&nbsp;units</div>
              <div class="text-[11px] text-slate-400">Max delay: ${p.maxLead}d</div>
            </td>
            <td class="py-3 px-3 text-center">
              <div class="font-medium text-slate-700">${m.reorderPoint} &ndash; ${m.maxOptimal}</div>
              <div class="text-[11px] text-slate-400">ROP to Ceiling</div>
            </td>
            <td class="py-3 px-3">${badgeHtml}</td>
            <td class="py-3 px-3 text-right space-x-1 whitespace-nowrap">
              <button type="button" data-action="edit" data-id="${escapeHtml(p.id)}" class="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-700 font-medium" aria-label="Edit ${escapeHtml(p.name)}">Edit</button>
              <button type="button" data-action="delete" data-id="${escapeHtml(p.id)}" class="px-2.5 py-1 rounded-lg border border-rose-200 hover:bg-rose-50 text-rose-600 font-medium" aria-label="Delete ${escapeHtml(p.name)}">Delete</button>
            </td>
          </tr>
        `;
      }).join('');
    }

    function renderTransactionSelectAndLog() {
      const select = document.getElementById('txProductSelect');
      const currentVal = select.value;
      select.innerHTML = appState.products.map(p =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${p.stock}&nbsp;on hand)</option>`
      ).join('');
      select.disabled = appState.products.length === 0;
      document.getElementById('transactionForm').querySelectorAll('input, select, button[type="submit"]').forEach(control => {
        control.disabled = appState.products.length === 0;
      });
      const emptyState = document.getElementById('transactionEmptyState');
      emptyState.hidden = appState.products.length > 0;
      emptyState.classList.toggle('hidden', appState.products.length > 0);
      if (currentVal && appState.products.some(p => p.id === currentVal)) {
        select.value = currentVal;
      }

      document.getElementById('txCountBadge').textContent = appState.transactions.length + ' entries';
      const tbody = document.getElementById('txTableBody');
      if (appState.transactions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><p>No sales or restocks have been logged yet.</p><span>Record a transaction to see stock movement here.</span></td></tr>';
        return;
      }
      tbody.innerHTML = appState.transactions.slice(0, 25).map(t => {
        const isSale = t.type === 'SALE';
        return `
          <tr>
            <td class="py-2.5 px-3 text-slate-500">${escapeHtml(t.time)}</td>
            <td class="py-2.5 px-3 font-medium text-slate-900">${escapeHtml(t.productName)}</td>
            <td class="py-2.5 px-3">
              <span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ${isSale ? 'bg-emerald-100 text-emerald-800' : 'bg-indigo-100 text-indigo-800'}">
                ${isSale ? 'Customer Sale' : 'Restock Delivery'}
              </span>
            </td>
            <td class="py-2.5 px-3 text-center font-semibold">${isSale ? '-' : '+'}${t.qty}</td>
            <td class="py-2.5 px-3 text-right font-medium ${isSale ? 'text-emerald-700' : 'text-slate-700'}">${formatCurrency(t.amount)}</td>
            <td class="py-2.5 px-3 text-slate-500">${escapeHtml(t.note || 'No note')}</td>
          </tr>
        `;
      }).join('');
    }

    function renderReportTableAndChart(rate) {
      const tbody = document.getElementById('reportTableBody');
      const chartCanvas = document.getElementById('inventoryChart');
      const chartState = document.getElementById('chartState');
      if (appState.products.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><p>No inventory to report yet.</p><button type="button" data-action="add-first">Add first product</button></td></tr>';
        chartState.textContent = 'Add a product to compare stock levels.';
        chartState.hidden = false;
        chartCanvas.hidden = true;
        if (inventoryChartInstance) {
          inventoryChartInstance.destroy();
          inventoryChartInstance = null;
        }
        return;
      }
      chartCanvas.hidden = false;
      tbody.innerHTML = appState.products.map(p => {
        const m = computeMetrics(p, rate);
        let recommendation = 'Maintain current lean schedule';
        if (m.status === 'EXCESS') {
          recommendation = `Pause reorders & sell down ${m.excessUnits}\u00a0excess units to save ${formatCurrency(m.annualExcessTaxAndSpaceCost)}/yr`;
        } else if (m.status === 'REORDER') {
          recommendation = `Place purchase order for ${m.orderNeeded}\u00a0units to prevent a stockout`;
        }
        return `
          <tr>
            <td class="py-3 px-3 font-semibold text-slate-900">${escapeHtml(p.name)} <span class="text-slate-400 font-normal">(${escapeHtml(p.sku)})</span></td>
            <td class="py-3 px-3 text-center font-bold">${p.stock}</td>
            <td class="py-3 px-3 text-center">${m.safetyStock}</td>
            <td class="py-3 px-3 text-center text-indigo-600 font-semibold">${m.maxOptimal}</td>
            <td class="py-3 px-3 text-center font-bold ${m.excessUnits > 0 ? 'text-amber-600' : 'text-slate-400'}">${m.excessUnits}</td>
            <td class="py-3 px-3 text-right">${formatCurrency(m.excessCapital)}</td>
            <td class="py-3 px-3 text-right font-semibold ${m.annualExcessTaxAndSpaceCost > 0 ? 'text-rose-600' : 'text-slate-400'}">${formatCurrency(m.annualExcessTaxAndSpaceCost)}/yr</td>
            <td class="py-3 px-3 text-slate-700">${escapeHtml(recommendation)}</td>
          </tr>
        `;
      }).join('');

      // Update Chart.js Bar Chart if canvas exists
      const ctx = document.getElementById('inventoryChart');
      if (!ctx) return;
      if (typeof Chart === 'undefined') {
        chartCanvas.hidden = true;
        chartState.textContent = 'The chart could not load. Use the detailed table below to review stock levels.';
        chartState.hidden = false;
        return;
      }
      chartState.hidden = true;

      const labels = appState.products.map(p => p.name);
      const currentData = appState.products.map(p => p.stock);
      const optimalCeilingData = appState.products.map(p => computeMetrics(p, rate).maxOptimal);
      const safetyStockData = appState.products.map(p => computeMetrics(p, rate).safetyStock);

      if (inventoryChartInstance) {
        inventoryChartInstance.data.labels = labels;
        inventoryChartInstance.data.datasets[0].data = currentData;
        inventoryChartInstance.data.datasets[1].data = optimalCeilingData;
        inventoryChartInstance.data.datasets[2].data = safetyStockData;
        inventoryChartInstance.update();
      } else {
        try {
          inventoryChartInstance = new Chart(ctx, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              {
                label: 'Current Stock on Hand',
                data: currentData,
                backgroundColor: '#405349',
                borderRadius: 6
              },
              {
                label: 'Max Optimal Ceiling (Avoid Excess Above This)',
                data: optimalCeilingData,
                backgroundColor: '#176b50',
                borderRadius: 6
              },
              {
                label: 'Required Safety Stock Buffer',
                data: safetyStockData,
                backgroundColor: '#bd812c',
                borderRadius: 6
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'top',
                labels: { font: { family: 'Plus Jakarta Sans', size: 11 } }
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                title: { display: true, text: 'Units', font: { family: 'Plus Jakarta Sans', size: 11 } }
              }
            }
          }
          });
        } catch (error) {
          chartCanvas.hidden = true;
          chartState.textContent = 'The chart could not render. Use the detailed table below to review stock levels.';
          chartState.hidden = false;
        }
      }
    }

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // Switch Tabs
    function switchTab(tabName) {
      const views = {
        INVENTORY: document.getElementById('viewInventory'),
        SALES: document.getElementById('viewSales'),
        REPORTS: document.getElementById('viewReports')
      };
      const buttons = {
        INVENTORY: document.getElementById('tabBtnInventory'),
        SALES: document.getElementById('tabBtnSales'),
        REPORTS: document.getElementById('tabBtnReports')
      };

      Object.keys(views).forEach(k => {
        buttons[k].setAttribute('aria-selected', String(k === tabName));
        buttons[k].tabIndex = k === tabName ? 0 : -1;
        views[k].hidden = k !== tabName;
        views[k].classList.toggle('hidden', k !== tabName);
      });

      if (tabName === 'REPORTS' && inventoryChartInstance) {
        setTimeout(() => inventoryChartInstance.resize(), 50);
      }
    }

    // Event Listeners Setup
    window.addEventListener('DOMContentLoaded', () => {
      loadState();
      document.getElementById('holdingRateInput').value = String(appState.holdingRate || 0.25);
      renderAll();
      if (stateNotice || storageUnavailable) showToast(stateNotice || 'Changes could not be saved in this browser. Export a copy before closing this tab.');

      // Formula Guide Toggle
      document.getElementById('btnToggleFormulaGuide').addEventListener('click', (e) => {
        const panel = document.getElementById('formulaGuidePanel');
        const isOpen = panel.classList.toggle('hidden') === false;
        e.currentTarget.setAttribute('aria-expanded', String(isOpen));
      });
      document.getElementById('btnCloseFormulaGuide').addEventListener('click', () => {
        document.getElementById('formulaGuidePanel').classList.add('hidden');
        document.getElementById('btnToggleFormulaGuide').setAttribute('aria-expanded', 'false');
        document.getElementById('btnToggleFormulaGuide').focus();
      });

      // Tab buttons
      document.getElementById('tabBtnInventory').addEventListener('click', () => switchTab('INVENTORY'));
      document.getElementById('tabBtnSales').addEventListener('click', () => switchTab('SALES'));
      document.getElementById('tabBtnReports').addEventListener('click', () => switchTab('REPORTS'));
      const tabOrder = ['INVENTORY', 'SALES', 'REPORTS'];
      document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
        const current = tabOrder.findIndex(name => document.getElementById(`tabBtn${name[0]}${name.slice(1).toLowerCase()}`).getAttribute('aria-selected') === 'true');
        let next = current;
        if (e.key === 'ArrowRight') next = (current + 1) % tabOrder.length;
        else if (e.key === 'ArrowLeft') next = (current - 1 + tabOrder.length) % tabOrder.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabOrder.length - 1;
        else return;
        e.preventDefault();
        switchTab(tabOrder[next]);
        document.getElementById(`tabBtn${tabOrder[next][0]}${tabOrder[next].slice(1).toLowerCase()}`).focus();
      });
      document.getElementById('btnStartProduct').addEventListener('click', () => {
        switchTab('INVENTORY');
        document.getElementById('prodName').focus();
      });

      // Holding rate selector
      document.getElementById('holdingRateInput').addEventListener('change', (e) => {
        appState.holdingRate = Number(e.target.value) || 0.25;
        saveState();
        renderAll();
        showToast('Updated warehouse & tax carrying rate');
      });

      // Live preview on form inputs
      ['prodCost', 'prodPrice', 'prodStock', 'prodAvgSales', 'prodMaxSales', 'prodAvgLead', 'prodMaxLead'].forEach(id => {
        document.getElementById(id).addEventListener('input', updateFormPreview);
      });
      ['prodName', 'prodSku'].forEach(id => {
        document.getElementById(id).addEventListener('input', () => {
          document.getElementById('productFormError').hidden = true;
        });
      });

      // Clear form button
      document.getElementById('btnClearForm').addEventListener('click', () => {
        document.getElementById('editProductId').value = '';
        document.getElementById('formTitle').textContent = 'Add or Update Product';
        document.getElementById('btnSubmitProduct').textContent = 'Save Product to Inventory';
        document.getElementById('productFormError').hidden = true;
        document.getElementById('productForm').reset();
        updateFormPreview();
      });

      // Add/Update Product Form Submit
      document.getElementById('productForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const editId = document.getElementById('editProductId').value;
        const name = document.getElementById('prodName').value.trim();
        const sku = document.getElementById('prodSku').value.trim();
        const cost = Number(document.getElementById('prodCost').value) || 0;
        const price = Number(document.getElementById('prodPrice').value) || 0;
        const stock = Math.max(0, Math.round(Number(document.getElementById('prodStock').value) || 0));
        const avgSales = Math.max(0, Number(document.getElementById('prodAvgSales').value) || 0);
        const maxSales = Math.max(avgSales, Number(document.getElementById('prodMaxSales').value) || avgSales);
        const avgLead = Math.max(1, Math.round(Number(document.getElementById('prodAvgLead').value) || 1));
        const maxLead = Math.max(avgLead, Math.round(Number(document.getElementById('prodMaxLead').value) || avgLead));

        if (!name || !sku) {
          const error = document.getElementById('productFormError');
          error.textContent = 'Enter both a product name and SKU before saving.';
          error.hidden = false;
          document.getElementById(!name ? 'prodName' : 'prodSku').focus();
          return;
        }

        if (editId) {
          const idx = appState.products.findIndex(p => p.id === editId);
          if (idx > -1) {
            appState.products[idx] = {
              ...appState.products[idx],
              name, sku, cost, price, stock, avgSales, maxSales, avgLead, maxLead
            };
            showToast('Updated ' + name);
          }
        } else {
          appState.products.unshift({
            id: 'p_' + Date.now(),
            name, sku, cost, price, stock, avgSales, maxSales, avgLead, maxLead,
            soldCount: 0
          });
          showToast('Added ' + name + ' to inventory');
        }

        document.getElementById('editProductId').value = '';
        document.getElementById('formTitle').textContent = 'Add or Update Product';
        document.getElementById('btnSubmitProduct').textContent = 'Save Product to Inventory';
        document.getElementById('productFormError').hidden = true;
        document.getElementById('productForm').reset();
        saveState();
        renderAll();
      });

      // Search and Filter listeners
      document.getElementById('searchInventoryInput').addEventListener('input', () => renderAll());
      document.getElementById('filterStatusSelect').addEventListener('change', () => renderAll());

      // Table row actions delegation (Quick Sale, Quick Restock, Edit, Delete)
      document.getElementById('inventoryTableBody').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        const id = btn.getAttribute('data-id');
        if (action === 'add-first') {
          switchTab('INVENTORY');
          document.getElementById('prodName').focus();
          return;
        }
        if (action === 'clear-filters') {
          document.getElementById('searchInventoryInput').value = '';
          document.getElementById('filterStatusSelect').value = 'ALL';
          renderAll();
          document.getElementById('searchInventoryInput').focus();
          return;
        }
        const prod = appState.products.find(p => p.id === id);
        if (!prod) return;

        const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (action === 'quick-sale') {
          if (prod.stock <= 0) {
            showToast('Out of stock! Record a restock first.');
            return;
          }
          prod.stock -= 1;
          prod.soldCount = (Number(prod.soldCount) || 0) + 1;
          appState.transactions.unshift({
            id: 't_' + Date.now(),
            time: nowTime,
            productName: prod.name,
            type: 'SALE',
            qty: 1,
            amount: prod.price,
            note: 'Quick 1-unit counter sale'
          });
          saveState();
          renderAll();
          showToast('Recorded 1 sale of ' + prod.name);
        } else if (action === 'quick-restock') {
          prod.stock += 10;
          appState.transactions.unshift({
            id: 't_' + Date.now(),
            time: nowTime,
            productName: prod.name,
            type: 'RESTOCK',
            qty: 10,
            amount: prod.cost * 10,
            note: 'Quick +10 unit restock'
          });
          saveState();
          renderAll();
          showToast('Restocked +10 units of ' + prod.name);
        } else if (action === 'edit') {
          document.getElementById('editProductId').value = prod.id;
          document.getElementById('prodName').value = prod.name;
          document.getElementById('prodSku').value = prod.sku;
          document.getElementById('prodCost').value = prod.cost;
          document.getElementById('prodPrice').value = prod.price;
          document.getElementById('prodStock').value = prod.stock;
          document.getElementById('prodAvgSales').value = prod.avgSales;
          document.getElementById('prodMaxSales').value = prod.maxSales;
          document.getElementById('prodAvgLead').value = prod.avgLead;
          document.getElementById('prodMaxLead').value = prod.maxLead;
          document.getElementById('formTitle').textContent = 'Editing: ' + prod.name;
          document.getElementById('btnSubmitProduct').textContent = 'Update Product';
          updateFormPreview();
          showToast('Loaded ' + prod.name + ' into form');
        } else if (action === 'delete') {
          appState.products = appState.products.filter(p => p.id !== id);
          saveState();
          renderAll();
          showToast('Removed ' + prod.name);
        }
      });
      document.getElementById('reportTableBody').addEventListener('click', (e) => {
        if (!e.target.closest('button[data-action="add-first"]')) return;
        switchTab('INVENTORY');
        document.getElementById('prodName').focus();
      });

      // Batch Transaction Form Submit
      document.getElementById('transactionForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const prodId = document.getElementById('txProductSelect').value;
        const type = document.getElementById('txTypeSelect').value;
        const qty = Math.max(1, Math.round(Number(document.getElementById('txQtyInput').value) || 1));
        const note = document.getElementById('txNoteInput').value.trim();

        const prod = appState.products.find(p => p.id === prodId);
        if (!prod) return;

        if (type === 'SALE' && prod.stock < qty) {
          showToast('Not enough stock on hand (' + prod.stock + ' available)');
          return;
        }

        const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (type === 'SALE') {
          prod.stock -= qty;
          prod.soldCount = (Number(prod.soldCount) || 0) + qty;
        } else {
          prod.stock += qty;
        }

        appState.transactions.unshift({
          id: 't_' + Date.now(),
          time: nowTime,
          productName: prod.name,
          type,
          qty,
          amount: type === 'SALE' ? prod.price * qty : prod.cost * qty,
          note: note || (type === 'SALE' ? 'Batch sale recorded' : 'Supplier delivery received')
        });

        document.getElementById('txNoteInput').value = '';
        saveState();
        renderAll();
        showToast((type === 'SALE' ? 'Sold ' : 'Restocked ') + qty + ' units of ' + prod.name);
      });

      // Export CSV Report
      document.getElementById('btnExportCsv').addEventListener('click', () => {
        if (appState.products.length === 0) {
          showToast('Add a product before exporting a report.');
          return;
        }
        const rate = Number(appState.holdingRate) || 0.25;
        const headers = ['SKU', 'Product Name', 'Current Stock', '7-Day Predicted Demand', 'Safety Stock', 'Reorder Point', 'Max Optimal Stock', 'Status', 'Excess Units', 'Annual Excess Holding/Tax Cost (PHP)'];
        const csvCell = value => {
          const safeValue = /^[=+\-@\t\r]/.test(String(value)) ? '\t' + value : value;
          return '"' + String(safeValue).replace(/"/g, '""') + '"';
        };
        const rows = appState.products.map(p => {
          const m = computeMetrics(p, rate);
          return [
            csvCell(p.sku),
            csvCell(p.name),
            p.stock,
            m.weeklyDemand,
            m.safetyStock,
            m.reorderPoint,
            m.maxOptimal,
            m.status,
            m.excessUnits,
            m.annualExcessTaxAndSpaceCost.toFixed(2)
          ].join(',');
        });
        try {
          const csv = '\ufeff' + [headers.map(csvCell).join(','), ...rows.map(row => row.join(','))].join('\r\n');
          const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = 'inventory_report_php.csv';
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          showToast('PHP inventory report downloaded.');
        } catch (error) {
          showToast('Could not export the report. Try again or copy the report summary.');
        }
      });

      // Copy Report Summary
      document.getElementById('btnCopyReportText').addEventListener('click', async () => {
        if (appState.products.length === 0) {
          showToast('Add a product before copying a report.');
          return;
        }
        const rate = Number(appState.holdingRate) || 0.25;
        const lines = appState.products.map(p => {
          const m = computeMetrics(p, rate);
          return `${p.name} (${p.sku}): Stock=${p.stock}, SafetyStock=${m.safetyStock}, OptimalMax=${m.maxOptimal}, Excess=${m.excessUnits} units (${formatCurrency(m.annualExcessTaxAndSpaceCost)}/yr risk)`;
        });
        const summaryText = 'SmartStock Inventory Optimization Report:\n' + lines.join('\n');
        try {
          await navigator.clipboard.writeText(summaryText);
          showToast('Report summary copied.');
        } catch (error) {
          const tempArea = document.createElement('textarea');
          tempArea.value = summaryText;
          tempArea.setAttribute('readonly', '');
          tempArea.style.position = 'fixed';
          tempArea.style.opacity = '0';
          document.body.appendChild(tempArea);
          let copied = false;
          try {
            tempArea.select();
            copied = document.execCommand('copy');
          } catch (fallbackError) {
            copied = false;
          } finally {
            tempArea.remove();
          }
          showToast(copied ? 'Report summary copied.' : 'Copy failed. Use Export CSV Report instead.');
        }
      });

      // Reset Demo Data
      document.getElementById('btnResetDemo').addEventListener('click', () => {
        appState = {
          currency: 'PHP',
          products: JSON.parse(JSON.stringify(DEFAULT_PRODUCTS)),
          transactions: JSON.parse(JSON.stringify(DEFAULT_TRANSACTIONS)),
          holdingRate: 0.25
        };
        document.getElementById('holdingRateInput').value = '0.25';
        saveState();
        renderAll();
        showToast('Demo inventory reset to defaults');
      });
    });
