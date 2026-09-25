// Admin Dashboard & Security Logic
let adminToken = localStorage.getItem('admin_token') || '';
let currentTab = 'pending';
let allOrders = [];
let allDataRequests = [];
let currentUser = 'admin';

// XSS Sanitizer Helper
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Authenticated Fetch Wrapper
async function adminFetch(url, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  if (adminToken) {
    headers['Authorization'] = `Bearer ${adminToken}`;
  }

  const mergedOptions = {
    ...options,
    headers
  };

  const response = await fetch(url, mergedOptions);

  if (response.status === 401 || response.status === 403) {
    console.warn('[Admin] Auth token invalid or expired. Redirecting to login.');
    adminLogout('सत्र समाप्त हो गया है। कृपया पुनः लॉगिन करें। (Session expired)');
    throw new Error('AUTH_EXPIRED');
  }

  return response;
}

document.addEventListener('DOMContentLoaded', async () => {
  if (adminToken) {
    try {
      const res = await adminFetch('/api/admin/verify-token');
      const data = await res.json();
      if (data.success && data.valid) {
        currentUser = data.user?.username || 'admin';
        showDashboard();
      } else {
        adminLogout();
      }
    } catch (err) {
      adminLogout();
    }
  } else {
    showLoginModal();
  }
});

function showLoginModal(errorMessage = '') {
  const loginScreen = document.getElementById('adminLoginScreen') || document.getElementById('adminLoginOverlay');
  const dashboard = document.getElementById('adminDashboardContainer');
  if (loginScreen) loginScreen.style.display = 'flex';
  if (dashboard) {
    dashboard.style.display = 'none';
    dashboard.classList.add('hidden');
  }
  const errorMsg = document.getElementById('loginErrorMsg');
  if (errorMsg) {
    if (errorMessage) {
      errorMsg.textContent = errorMessage;
      errorMsg.style.display = 'block';
    } else {
      errorMsg.style.display = 'none';
    }
  }
}

function showDashboard() {
  const loginScreen = document.getElementById('adminLoginScreen') || document.getElementById('adminLoginOverlay');
  const dashboard = document.getElementById('adminDashboardContainer');
  if (loginScreen) loginScreen.style.display = 'none';
  if (dashboard) {
    dashboard.classList.remove('hidden');
    dashboard.style.display = 'flex';
  }

  const userBadge = document.getElementById('currentAdminUserBadge');
  if (userBadge) userBadge.textContent = currentUser;

  loadDashboardData();
  switchTab(currentTab || 'pending');
}

// Handle Admin Login with Rate-Limiting / Lockout Handling
async function handleAdminLogin(e) {
  e.preventDefault();
  const usernameInput = (document.getElementById('adminUsernameInput')?.value || 'admin').trim();
  const passwordInput = (document.getElementById('adminPasswordInput')?.value || document.getElementById('adminPinInput')?.value || '').trim();
  const errorMsg = document.getElementById('loginErrorMsg');
  const submitBtn = document.getElementById('adminLoginSubmitBtn') || e.target.querySelector('button[type="submit"]');

  if (!passwordInput) {
    if (errorMsg) {
      errorMsg.textContent = 'कृपया पासवर्ड या पिन दर्ज करें।';
      errorMsg.style.display = 'block';
    }
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'प्रमाणीकरण हो रहा है...';
  }

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameInput, password: passwordInput })
    });
    const data = await res.json();

    if (data.success && data.token) {
      adminToken = data.token;
      currentUser = data.username || usernameInput;
      localStorage.setItem('admin_token', adminToken);
      if (errorMsg) errorMsg.style.display = 'none';
      showDashboard();
    } else {
      let msg = data.error || 'अमान्य क्रेडेंशियल (Invalid Credentials).';
      if (data.remainingAttempts !== undefined) {
        msg += ` (शेष प्रयास: ${data.remainingAttempts})`;
      }
      if (errorMsg) {
        errorMsg.textContent = msg;
        errorMsg.style.display = 'block';
      }
    }
  } catch (err) {
    console.error('Login error:', err);
    if (errorMsg) {
      errorMsg.textContent = 'सर्वर प्रमाणीकरण में त्रुटि।';
      errorMsg.style.display = 'block';
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'लॉगिन करें (Enter Dashboard)';
    }
  }
}

function adminLogout(reason = '') {
  adminToken = '';
  localStorage.removeItem('admin_token');
  showLoginModal();
  const errorMsg = document.getElementById('loginErrorMsg');
  if (errorMsg && reason) {
    errorMsg.textContent = reason;
    errorMsg.style.display = 'block';
  }
}

// Toggle Show/Hide Password in UI
function togglePasswordVisibility(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (btnEl) btnEl.textContent = '👁️';
  } else {
    input.type = 'password';
    if (btnEl) btnEl.textContent = '🔒';
  }
}

// Sidebar Toggle for Mobile / Tablet
function toggleAdminSidebar(forceState) {
  const sidebar = document.getElementById('adminSidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!sidebar) return;

  const isOpen = forceState !== undefined ? forceState : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', isOpen);
  if (backdrop) backdrop.classList.toggle('active', isOpen);
}

// Refresh active tab
function refreshCurrentTab() {
  if (currentTab === 'pending' || currentTab === 'all' || currentTab === 'propertyRequests') loadOrders();
  else if (currentTab === 'requests') loadDataRequests();
  else if (currentTab === 'uploadData') loadUploadDistricts();
  else if (currentTab === 'settings') loadSettingsAdmin();
  else if (currentTab === 'security') loadSecurityLogs();
}

// Tab titles map
const tabTitles = {
  pending: '⏳ लंबित सत्यापन कतार (Pending UTR Queue)',
  propertyRequests: '📑 प्रॉपर्टी अनुरोध प्रबंधन (Property Requests Management)',
  all: '📋 सभी ऑर्डर इतिहास (All Order History)',
  requests: '📬 नागरिकों द्वारा अनुरोधित अनुपलब्ध ग्राम (Missing Village Requests)',
  uploadData: '📤 नया ग्राम डेटा अपलोड (Upload Village Excel / Data)',
  settings: '⚙️ UPI एवं सिस्टम सेटिंग्स (Settings)',
  security: '🛡️ सुरक्षा, पासवर्ड एवं ऑडिट लॉग (Security & Audit)'
};

// Switch Tabs
function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  const tabPending = document.getElementById('pendingOrdersTab');
  const tabPropReq = document.getElementById('propertyRequestsTab');
  const tabAll = document.getElementById('allOrdersTab');
  const tabReq = document.getElementById('dataRequestsTab');
  const tabUpload = document.getElementById('uploadDataTab');
  const tabSettings = document.getElementById('settingsTab');
  const tabSecurity = document.getElementById('securityTab');

  if (tabPending) tabPending.style.display = tabName === 'pending' ? 'block' : 'none';
  if (tabPropReq) tabPropReq.style.display = tabName === 'propertyRequests' ? 'block' : 'none';
  if (tabAll) tabAll.style.display = tabName === 'all' ? 'block' : 'none';
  if (tabReq) tabReq.style.display = tabName === 'requests' ? 'block' : 'none';
  if (tabUpload) tabUpload.style.display = tabName === 'uploadData' ? 'block' : 'none';
  if (tabSettings) tabSettings.style.display = tabName === 'settings' ? 'block' : 'none';
  if (tabSecurity) tabSecurity.style.display = tabName === 'security' ? 'block' : 'none';

  // Update topbar header title
  const titleEl = document.getElementById('currentViewTitle');
  if (titleEl && tabTitles[tabName]) {
    titleEl.textContent = tabTitles[tabName];
  }

  if (tabName === 'pending' || tabName === 'all' || tabName === 'propertyRequests') loadOrders();
  else if (tabName === 'requests') loadDataRequests();
  else if (tabName === 'uploadData') loadUploadDistricts();
  else if (tabName === 'settings') loadSettingsAdmin();
  else if (tabName === 'security') loadSecurityLogs();
}

// Load Dashboard & Orders
async function loadDashboardData() {
  await loadOrders();
  await loadDataRequests();
  await loadSettingsAdmin();
  await loadUploadDistricts();
}

async function loadOrders() {
  try {
    const res = await adminFetch('/api/admin/orders');
    const data = await res.json();

    if (data.success && data.orders) {
      allOrders = data.orders;
      updateStats(allOrders);
      renderPendingOrders(allOrders.filter(o => o.status === 'pending'));
      renderPropertyRequests(allOrders);
      renderAllOrders(allOrders);
    }
  } catch (err) {
    console.error('Error loading orders:', err);
  }
}

function updateStats(orders) {
  const pendingCount = orders.filter(o => o.status === 'pending').length;
  const verifiedOrders = orders.filter(o => o.status === 'verified');
  const verifiedCount = verifiedOrders.length;
  const totalRevenue = verifiedOrders.reduce((sum, o) => sum + (parseFloat(o.amount) || 0), 0);

  const statP = document.getElementById('statPendingOrders');
  const statV = document.getElementById('statVerifiedOrders');
  const statT = document.getElementById('statTotalOrders');
  const statR = document.getElementById('statTotalRevenue');

  if (statP) statP.textContent = pendingCount;
  if (statV) statV.textContent = verifiedCount;
  if (statT) statT.textContent = orders.length;
  if (statR) statR.textContent = `₹${totalRevenue.toLocaleString('en-IN')}`;

  const pendingBadge = document.getElementById('pendingCountBadge');
  if (pendingBadge) {
    pendingBadge.textContent = pendingCount;
    pendingBadge.style.display = pendingCount > 0 ? 'inline-block' : 'none';
  }

  const propReqBadge = document.getElementById('propReqSidebarBadge');
  if (propReqBadge) {
    propReqBadge.textContent = pendingCount;
    propReqBadge.style.display = pendingCount > 0 ? 'inline-block' : 'none';
  }

  // Update Sub-Tab Count Badges in Property Requests View
  const bSubP = document.getElementById('badgeSubPending');
  const bSubV = document.getElementById('badgeSubVerified');
  const bSubA = document.getElementById('badgeSubAll');
  if (bSubP) bSubP.textContent = pendingCount;
  if (bSubV) bSubV.textContent = verifiedCount;
  if (bSubA) bSubA.textContent = orders.length;
}

// Render Pending Queue (XSS-Safe)
function renderPendingOrders(orders) {
  const tbody = document.getElementById('pendingTableBody');
  if (!tbody) return;

  if (!orders || orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:2rem; color:#64748b;">🎉 कोई लंबित भुगतान अनुरोध नहीं है (No pending orders).</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  orders.forEach((o) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${escapeHtml(o.order_id)}</strong></td>
      <td>
        <div style="font-weight:700; color:#0f172a;">${escapeHtml(o.owner_name)}</div>
        <div style="font-size:0.8rem; color:#64748b;">पिता: ${escapeHtml(o.father_name || '--')}</div>
      </td>
      <td>
        <div>${escapeHtml(o.village_name)} (${escapeHtml(o.village_code)})</div>
        <div style="font-size:0.8rem; color:#64748b;">जिला: ${escapeHtml(o.district_name)}</div>
      </td>
      <td>
        <a href="tel:${escapeHtml(o.user_mobile)}" style="font-weight:600; color:#2563eb; text-decoration:none;">📞 ${escapeHtml(o.user_mobile)}</a>
      </td>
      <td>
        <div style="background:#fef3c7; border:1px solid #fde68a; padding:0.25rem 0.5rem; border-radius:4px; font-family:monospace; font-weight:700; color:#92400e; display:inline-block;">
          ${escapeHtml(o.transaction_ref || 'उपलब्ध नहीं')}
        </div>
      </td>
      <td>
        <span style="font-size:0.8rem; color:#64748b;">${formatDate(o.created_at)}</span>
      </td>
      <td>
        <div style="display:flex; gap:0.4rem;">
          <button class="btn btn-emerald btn-sm" onclick="handleOrderAction('${escapeHtml(o.order_id)}', 'verified')">
            ✓ स्वीकृत (Approve)
          </button>
          <button class="btn btn-secondary btn-sm" style="color:#dc2626;" onclick="handleOrderAction('${escapeHtml(o.order_id)}', 'rejected')">
            ✕ अस्वीकृत (Reject)
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(row);
  });
}

// Property Requests Sub-Tab Handler (Pending / Complete / All)
let currentPropReqSubTab = 'pending';

function switchPropReqSubTab(subTabName) {
  currentPropReqSubTab = subTabName;
  document.querySelectorAll('.prop-subtab-btn').forEach(btn => {
    const isActive = btn.dataset.subtab === subTabName;
    btn.classList.toggle('btn-emerald', isActive);
    btn.classList.toggle('btn-secondary', !isActive);
  });
  filterPropRequests();
}

function filterPropRequests() {
  renderPropertyRequests(allOrders);
}

function renderPropertyRequests(orders) {
  const tbody = document.getElementById('propRequestsTableBody');
  if (!tbody) return;

  const searchFilter = (document.getElementById('propReqSearchInput')?.value || '').toLowerCase().trim();
  let filtered = [...(orders || [])];

  if (currentPropReqSubTab !== 'all') {
    filtered = filtered.filter(o => o.status === currentPropReqSubTab);
  }

  if (searchFilter) {
    filtered = filtered.filter(o => 
      (o.order_id && o.order_id.toLowerCase().includes(searchFilter)) ||
      (o.owner_name && o.owner_name.toLowerCase().includes(searchFilter)) ||
      (o.father_name && o.father_name.toLowerCase().includes(searchFilter)) ||
      (o.village_name && o.village_name.toLowerCase().includes(searchFilter)) ||
      (o.district_name && o.district_name.toLowerCase().includes(searchFilter)) ||
      (o.user_mobile && o.user_mobile.includes(searchFilter)) ||
      (o.transaction_ref && o.transaction_ref.toLowerCase().includes(searchFilter))
    );
  }

  const countEl = document.getElementById('propReqFilteredCount');
  if (countEl) countEl.textContent = filtered.length;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:#64748b;">कोई प्रॉपर्टी अनुरोध नहीं मिला।</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  filtered.forEach(o => {
    const row = document.createElement('tr');
    let statusBadge = '';
    if (o.status === 'verified') {
      statusBadge = '<span style="background:#dcfce7; color:#15803d; padding:0.25rem 0.6rem; border-radius:6px; font-weight:700; font-size:0.8rem; display:inline-block;">✓ पूर्ण (Verified)</span>';
    } else if (o.status === 'pending') {
      statusBadge = '<span style="background:#fef3c7; color:#b45309; padding:0.25rem 0.6rem; border-radius:6px; font-weight:700; font-size:0.8rem; display:inline-block;">⏳ लंबित (Pending)</span>';
    } else {
      statusBadge = '<span style="background:#fee2e2; color:#b91c1c; padding:0.25rem 0.6rem; border-radius:6px; font-weight:700; font-size:0.8rem; display:inline-block;">✕ अस्वीकृत (Rejected)</span>';
    }

    let actionBtns = '';
    if (o.status === 'pending') {
      actionBtns = `
        <div style="display:flex; gap:0.4rem;">
          <button class="btn btn-emerald btn-sm" onclick="handleOrderAction('${escapeHtml(o.order_id)}', 'verified')">
            ✓ स्वीकृत
          </button>
          <button class="btn btn-secondary btn-sm" style="color:#dc2626;" onclick="handleOrderAction('${escapeHtml(o.order_id)}', 'rejected')">
            ✕ अस्वीकृत
          </button>
        </div>
      `;
    } else if (o.status === 'verified') {
      actionBtns = `
        <span style="font-size:0.8rem; color:#15803d; font-weight:700;">✅ सत्यापित</span>
      `;
    } else {
      actionBtns = `
        <button class="btn btn-emerald btn-sm" onclick="handleOrderAction('${escapeHtml(o.order_id)}', 'verified')">
          पुनः स्वीकृत करें
        </button>
      `;
    }

    row.innerHTML = `
      <td><strong>${escapeHtml(o.order_id)}</strong></td>
      <td>
        <div style="font-weight:700; color:#0f172a;">${escapeHtml(o.owner_name)}</div>
        <div style="font-size:0.8rem; color:#64748b;">पिता/पति: ${escapeHtml(o.father_name || '--')}</div>
      </td>
      <td>
        <div>${escapeHtml(o.village_name)} (${escapeHtml(o.village_code)})</div>
        <div style="font-size:0.8rem; color:#64748b;">जिला: ${escapeHtml(o.district_name)}</div>
      </td>
      <td>
        <a href="tel:${escapeHtml(o.user_mobile)}" style="font-weight:600; color:#2563eb; text-decoration:none;">📞 ${escapeHtml(o.user_mobile)}</a>
      </td>
      <td>
        <span style="font-family:monospace; font-weight:700; background:#f1f5f9; padding:0.2rem 0.4rem; border-radius:4px; font-size:0.85rem;">${escapeHtml(o.transaction_ref || '--')}</span>
      </td>
      <td>₹${(parseFloat(o.amount) || 80).toFixed(2)}</td>
      <td><span style="font-size:0.8rem; color:#64748b;">${formatDate(o.created_at)}</span></td>
      <td>${statusBadge}</td>
      <td>${actionBtns}</td>
    `;
    tbody.appendChild(row);
  });
}

// Export Property Requests to Excel
async function exportPropRequestsToExcel() {
  await exportOrdersToExcel(currentPropReqSubTab);
}

// Export Orders to Excel (.xlsx)
async function exportOrdersToExcel(statusFilter = '') {
  try {
    const activeFilter = statusFilter || document.getElementById('allOrdersStatusFilter')?.value || currentPropReqSubTab || 'all';
    const res = await adminFetch(`/api/admin/orders/export-excel?status=${encodeURIComponent(activeFilter)}`);
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Property_Requests_${activeFilter}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Export error:', err);
    alert('Excel रिपोर्ट डाउनलोड करने में त्रुटि आई।');
  }
}

// Export Village Data Requests to Excel
async function exportDataRequestsToExcel() {
  try {
    const status = document.getElementById('dataRequestsStatusFilter')?.value || 'all';
    const res = await adminFetch(`/api/admin/data-requests/export-excel?status=${encodeURIComponent(status)}`);
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Village_Data_Requests_${status}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Export error:', err);
    alert('ग्राम अनुरोध Excel डाउनलोड करने में त्रुटि आई।');
  }
}

// Render All Orders (XSS-Safe)
function renderAllOrders(orders) {
  const tbody = document.getElementById('allOrdersTableBody');
  if (!tbody) return;

  const searchFilter = (document.getElementById('allOrdersSearchInput')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('allOrdersStatusFilter')?.value || 'all';

  let filtered = [...orders];
  if (statusFilter !== 'all') {
    filtered = filtered.filter(o => o.status === statusFilter);
  }
  if (searchFilter) {
    filtered = filtered.filter(o => 
      (o.order_id && o.order_id.toLowerCase().includes(searchFilter)) ||
      (o.owner_name && o.owner_name.toLowerCase().includes(searchFilter)) ||
      (o.user_mobile && o.user_mobile.includes(searchFilter)) ||
      (o.transaction_ref && o.transaction_ref.toLowerCase().includes(searchFilter))
    );
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:2rem; color:#64748b;">कोई ऑर्डर नहीं मिला।</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  filtered.forEach(o => {
    const row = document.createElement('tr');
    let statusBadge = '';
    if (o.status === 'verified') {
      statusBadge = '<span style="background:#dcfce7; color:#15803d; padding:0.2rem 0.5rem; border-radius:4px; font-weight:700; font-size:0.8rem;">✓ सत्यापित</span>';
    } else if (o.status === 'pending') {
      statusBadge = '<span style="background:#fef3c7; color:#b45309; padding:0.2rem 0.5rem; border-radius:4px; font-weight:700; font-size:0.8rem;">⏳ लंबित</span>';
    } else {
      statusBadge = '<span style="background:#fee2e2; color:#b91c1c; padding:0.2rem 0.5rem; border-radius:4px; font-weight:700; font-size:0.8rem;">✕ अस्वीकृत</span>';
    }

    row.innerHTML = `
      <td><strong>${escapeHtml(o.order_id)}</strong></td>
      <td>${escapeHtml(o.owner_name)} <br><small style="color:#64748b;">${escapeHtml(o.village_name)}</small></td>
      <td>${escapeHtml(o.user_mobile)}</td>
      <td>₹${(parseFloat(o.amount) || 80).toFixed(2)}</td>
      <td><span style="font-family:monospace; font-size:0.85rem;">${escapeHtml(o.transaction_ref || '--')}</span></td>
      <td>${statusBadge}</td>
      <td>
        <span style="font-size:0.8rem; color:#64748b;">${formatDate(o.created_at)}</span>
      </td>
    `;
    tbody.appendChild(row);
  });
}

// Action on Order
async function handleOrderAction(orderId, action) {
  const targetOrder = (allOrders || []).find(o => o.order_id === orderId);
  const orderAmt = targetOrder ? (parseFloat(targetOrder.amount) || 80).toFixed(0) : '80';
  const confirmMsg = action === 'verified' 
    ? `क्या आप पुष्टि करते हैं कि ऑर्डर ${orderId} का ₹${orderAmt} UPI भुगतान प्राप्त हो गया है?` 
    : `क्या आप ऑर्डर ${orderId} को अस्वीकृत करना चाहते हैं?`;
  
  if (!confirm(confirmMsg)) return;

  try {
    const res = await adminFetch(`/api/admin/orders/${encodeURIComponent(orderId)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, adminNotes: `Action ${action} by Admin` })
    });
    const data = await res.json();

    if (data.success) {
      alert(`ऑर्डर ${orderId} सफलतापूर्वक ${action === 'verified' ? 'सत्यापित (Approved)' : 'अस्वीकृत'} कर दिया गया!`);
      await loadOrders();
    } else {
      alert('त्रुटि: ' + data.error);
    }
  } catch (err) {
    console.error('Action error:', err);
    if (err.message !== 'AUTH_EXPIRED') {
      alert('कार्रवाई करने में त्रुटि।');
    }
  }
}

// Clear All Orders
async function clearAllOrdersAdmin() {
  if (!confirm('⚠️ क्या आप वाकई सभी ऑर्डर और अनुरोध इतिहास को हटाना (Clear) चाहते हैं? यह क्रिया पूर्ववत नहीं की जा सकती।')) {
    return;
  }
  try {
    const res = await adminFetch('/api/admin/orders/clear-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data.success) {
      alert('🎉 सभी ऑर्डर इतिहास सफलतापूर्वक हटा दिया गया है!');
      await loadOrders();
    } else {
      alert('त्रुटि: ' + data.error);
    }
  } catch (err) {
    console.error('Clear orders error:', err);
    alert('ऑर्डर हटाने में त्रुटि आई।');
  }
}

// Delete Single Order
async function deleteSingleOrderAdmin(orderId) {
  if (!confirm(`क्या आप ऑर्डर ${orderId} को हटाना चाहते हैं?`)) return;
  try {
    const res = await adminFetch(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      await loadOrders();
    } else {
      alert('त्रुटि: ' + data.error);
    }
  } catch (err) {
    console.error('Delete order error:', err);
    alert('ऑर्डर हटाने में त्रुटि।');
  }
}

// Pre-fill Upload Form from Missing Village Data Request
function prefillAndOpenUpload(state, district, tehsil, villageName, villageCode) {
  switchTab('uploadData');
  const stateEl = document.getElementById('uploadStateSelect');
  if (stateEl && state) {
    stateEl.value = state;
    if (typeof onUploadStateChange === 'function') onUploadStateChange();
  }
  const distSelect = document.getElementById('uploadDistrictSelect');
  const distInput = document.getElementById('uploadDistrictInput');
  if (distSelect && district) {
    let found = false;
    for (let i = 0; i < distSelect.options.length; i++) {
      if (distSelect.options[i].value.toLowerCase() === district.toLowerCase()) {
        distSelect.selectedIndex = i;
        found = true;
        break;
      }
    }
    if (!found) {
      const opt = document.createElement('option');
      opt.value = district;
      opt.textContent = district;
      distSelect.appendChild(opt);
      distSelect.value = district;
    }
  } else if (distInput && district) {
    distInput.value = district;
  }
  const tehEl = document.getElementById('uploadTehsilInput');
  if (tehEl && tehsil) tehEl.value = tehsil;
  const vNameEl = document.getElementById('uploadVillageNameInput');
  if (vNameEl && villageName) vNameEl.value = villageName;
  const vCodeEl = document.getElementById('uploadVillageCodeInput');
  if (vCodeEl && villageCode) vCodeEl.value = villageCode;
}

// Load Missing Data Requests
async function loadDataRequests() {
  try {
    const res = await adminFetch('/api/admin/data-requests');
    const data = await res.json();

    if (data.success && data.requests) {
      allDataRequests = data.requests;
      const countBadge = document.getElementById('totalRequestsCountBadge');
      if (countBadge) countBadge.textContent = allDataRequests.length;
      
      const statReq = document.getElementById('statDataRequests');
      if (statReq) statReq.textContent = allDataRequests.length;

      filterDataRequests();
    }
  } catch (err) {
    console.error('Error loading data requests:', err);
  }
}

// Filter and search Data Requests
function filterDataRequests() {
  const searchFilter = (document.getElementById('dataRequestsSearchInput')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('dataRequestsStatusFilter')?.value || 'all';

  let filtered = [...allDataRequests];

  if (statusFilter !== 'all') {
    filtered = filtered.filter(r => (r.status || 'pending') === statusFilter);
  }

  if (searchFilter) {
    filtered = filtered.filter(r => 
      (r.village_name && r.village_name.toLowerCase().includes(searchFilter)) ||
      (r.district_name && r.district_name.toLowerCase().includes(searchFilter)) ||
      (r.tehsil_name && r.tehsil_name.toLowerCase().includes(searchFilter)) ||
      (r.user_name && r.user_name.toLowerCase().includes(searchFilter)) ||
      (r.user_mobile && r.user_mobile.includes(searchFilter)) ||
      (r.village_code && r.village_code.includes(searchFilter))
    );
  }

  renderDataRequests(filtered);
}

// Render Missing Data Requests with Status & Actions
function renderDataRequests(requests) {
  const tbody = document.getElementById('dataRequestsTableBody');
  if (!tbody) return;

  if (!requests || requests.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:#64748b;">कोई ग्राम डेटा अनुरोध नहीं मिला।</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  requests.forEach((r, idx) => {
    const row = document.createElement('tr');
    const status = r.status || 'pending';

    let statusBadge = '';
    let actionButtons = '';

    if (status === 'uploaded') {
      statusBadge = `<span class="order-badge-verified">✓ डेटा अपलोडेड</span>`;
      actionButtons = `
        <button class="btn btn-secondary btn-sm" style="font-size:0.75rem; padding:0.25rem 0.6rem; color:#64748b;" onclick="handleDataRequestStatus(${r.id}, 'pending')" title="वापस लंबित करें">
          ↩️ लंबित करें
        </button>
      `;
    } else if (status === 'rejected') {
      statusBadge = `<span class="order-badge-rejected">✕ अस्वीकृत</span>`;
      actionButtons = `
        <button class="btn btn-secondary btn-sm" style="font-size:0.75rem; padding:0.25rem 0.6rem; color:#2563eb;" onclick="handleDataRequestStatus(${r.id}, 'pending')" title="पुनर्स्थापित करें">
          ↩️ पुनः लंबित करें
        </button>
      `;
    } else {
      statusBadge = `<span class="order-badge-pending">⏳ लंबित</span>`;
      actionButtons = `
        <div style="display:flex; gap:0.35rem; flex-wrap:wrap;">
          <button class="btn btn-emerald btn-sm" style="font-size:0.75rem; padding:0.3rem 0.6rem; font-weight:700;" onclick="handleDataRequestStatus(${r.id}, 'uploaded')" title="डेटा अपलोड हो चुका है">
            ✓ डेटा अपलोड हो गया
          </button>
          <button class="btn btn-secondary btn-sm" style="font-size:0.75rem; padding:0.3rem 0.6rem; color:#dc2626; font-weight:700;" onclick="handleDataRequestStatus(${r.id}, 'rejected')" title="अनुरोध अस्वीकृत करें">
            ✕ अस्वीकृत
          </button>
          <button class="btn btn-secondary btn-sm" style="font-size:0.75rem; padding:0.3rem 0.6rem; color:#2563eb; font-weight:700;" onclick="prefillAndOpenUpload('${escapeHtml(r.state_name || 'Uttar Pradesh')}', '${escapeHtml(r.district_name)}', '${escapeHtml(r.tehsil_name || '')}', '${escapeHtml(r.village_name)}', '${escapeHtml(r.village_code || '')}')" title="इस ग्राम का नया डेटा अपलोड करें">
            📤 डेटा अपलोड
          </button>
        </div>
      `;
    }

    row.innerHTML = `
      <td>#${idx + 1}</td>
      <td>
        <strong style="color:#0f172a; font-size:0.92rem;">${escapeHtml(r.village_name)}</strong>
        ${r.village_code ? `<br><small style="color:#64748b; font-family:monospace;">कोड: ${escapeHtml(r.village_code)}</small>` : ''}
      </td>
      <td>${escapeHtml(r.district_name)} (${escapeHtml(r.state_name || 'UP')})</td>
      <td>${escapeHtml(r.tehsil_name || '--')}</td>
      <td>${escapeHtml(r.user_name || '--')}</td>
      <td><a href="tel:${escapeHtml(r.user_mobile)}" style="color:#2563eb; font-weight:600; text-decoration:none;">📞 ${escapeHtml(r.user_mobile)}</a></td>
      <td><span style="font-size:0.8rem; color:#64748b;">${formatDate(r.created_at)}</span></td>
      <td>${statusBadge}</td>
      <td>${actionButtons}</td>
    `;
    tbody.appendChild(row);
  });
}

// Action: Mark Missing Data Request Status (Uploaded / Pending)
async function handleDataRequestStatus(id, newStatus) {
  try {
    const res = await adminFetch(`/api/admin/data-requests/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();

    if (data.success && data.request) {
      const idx = allDataRequests.findIndex(r => r.id === parseInt(id, 10));
      if (idx !== -1) {
        allDataRequests[idx].status = newStatus;
      }
      filterDataRequests();
    } else {
      alert('स्थिति अपडेट करने में त्रुटि: ' + (data.error || 'अज्ञात त्रुटि'));
    }
  } catch (err) {
    console.error('Error updating request status:', err);
    alert('सर्वर अनुरोध विफल।');
  }
}

// Clear All Missing Village Data Requests
async function clearAllDataRequestsAdmin() {
  if (!confirm('⚠️ क्या आप वाकई सभी अनुपलब्ध ग्राम अनुरोधों को हटाना (Clear) चाहते हैं?')) {
    return;
  }
  try {
    const res = await adminFetch('/api/admin/data-requests/clear-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data.success) {
      alert('🎉 सभी ग्राम अनुरोध सफलतापूर्वक हटा दिए गए हैं!');
      await loadDataRequests();
    } else {
      alert('त्रुटि: ' + data.error);
    }
  } catch (err) {
    console.error('Clear data requests error:', err);
    alert('ग्राम अनुरोध हटाने में त्रुटि आई।');
  }
}

// Delete Single Missing Data Request
async function deleteSingleDataRequestAdmin(id) {
  if (!confirm(`क्या आप अनुरोध #${id} को हटाना चाहते हैं?`)) return;
  try {
    const res = await adminFetch(`/api/admin/data-requests/${id}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      await loadDataRequests();
    } else {
      alert('त्रुटि: ' + data.error);
    }
  } catch (err) {
    console.error('Delete data request error:', err);
    alert('अनुरोध हटाने में त्रुटि।');
  }
}

// Load Settings
async function loadSettingsAdmin() {
  try {
    const res = await adminFetch('/api/admin/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      const s = data.settings;
      if (document.getElementById('setUpiId')) document.getElementById('setUpiId').value = s.upi_id || '';
      if (document.getElementById('setMerchantName')) document.getElementById('setMerchantName').value = s.merchant_name || '';
      if (document.getElementById('setPrice')) document.getElementById('setPrice').value = s.price || 80.00;
      if (document.getElementById('setSmtpHost')) document.getElementById('setSmtpHost').value = s.smtp_host || '';
      if (document.getElementById('setSmtpPort')) document.getElementById('setSmtpPort').value = s.smtp_port || '587';
      if (document.getElementById('setSmtpUser')) document.getElementById('setSmtpUser').value = s.smtp_user || '';
      if (document.getElementById('setNotifyEmail')) document.getElementById('setNotifyEmail').value = s.notify_email || '';
      if (document.getElementById('setAutoVerify')) document.getElementById('setAutoVerify').checked = Boolean(s.auto_verify_demo);
    }
  } catch (err) {
    console.error('Error loading admin settings:', err);
  }
}

// Save Settings
async function saveAdminSettings(e) {
  e.preventDefault();
  const upiId = document.getElementById('setUpiId').value.trim();
  const merchantName = document.getElementById('setMerchantName').value.trim();
  const price = parseFloat(document.getElementById('setPrice').value);
  const autoVerify = document.getElementById('setAutoVerify').checked;

  const smtpHost = document.getElementById('setSmtpHost')?.value.trim() || '';
  const smtpPort = document.getElementById('setSmtpPort')?.value.trim() || '';
  const smtpUser = document.getElementById('setSmtpUser')?.value.trim() || '';
  const smtpPass = document.getElementById('setSmtpPass')?.value.trim() || '';
  const notifyEmail = document.getElementById('setNotifyEmail')?.value.trim() || '';

  const payload = {
    upi_id: upiId,
    merchant_name: merchantName,
    price: price,
    auto_verify_demo: autoVerify,
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    smtp_user: smtpUser,
    notify_email: notifyEmail
  };
  if (smtpPass) payload.smtp_pass = smtpPass;

  try {
    const res = await adminFetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      alert('सेटिंग्स सफलतापूर्वक सहेज ली गई हैं!');
    } else {
      alert('त्रुटि: ' + data.error);
    }
  } catch (err) {
    console.error('Error saving settings:', err);
    if (err.message !== 'AUTH_EXPIRED') alert('सेटिंग्स सहेजने में विफल।');
  }
}

// Handle Password / Username Change
async function handleChangePassword(e) {
  e.preventDefault();
  const oldPassword = document.getElementById('currentPasswordInput').value.trim();
  const newPassword = document.getElementById('newPasswordInput').value.trim();
  const confirmPassword = document.getElementById('confirmPasswordInput').value.trim();
  const newUsername = (document.getElementById('newUsernameInput')?.value || '').trim();
  const statusEl = document.getElementById('passwordChangeStatus');

  if (!oldPassword || !newPassword) {
    if (statusEl) {
      statusEl.innerHTML = '<span style="color:#dc2626;">कृपया वर्तमान व नया पासवर्ड दोनों दर्ज करें।</span>';
    }
    return;
  }

  if (newPassword.length < 6) {
    if (statusEl) {
      statusEl.innerHTML = '<span style="color:#dc2626;">नया पासवर्ड कम से कम 6 अक्षरों का होना चाहिए।</span>';
    }
    return;
  }

  if (newPassword !== confirmPassword) {
    if (statusEl) {
      statusEl.innerHTML = '<span style="color:#dc2626;">नया पासवर्ड और पुष्टि पासवर्ड मेल नहीं खाते।</span>';
    }
    return;
  }

  try {
    const res = await adminFetch('/api/admin/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword, newPassword, newUsername })
    });
    const data = await res.json();

    if (data.success) {
      alert('🎉 व्यवस्थापक पासवर्ड सफलतापूर्वक बदल दिया गया है! कृपया नए पासवर्ड के साथ पुनः लॉगिन करें।');
      adminLogout('पासवर्ड सफलतापूर्वक बदल दिया गया है। कृपया नए पासवर्ड से लॉगिन करें।');
    } else {
      if (statusEl) {
        statusEl.innerHTML = `<span style="color:#dc2626;">त्रुटि: ${escapeHtml(data.error)}</span>`;
      }
    }
  } catch (err) {
    console.error('Password change error:', err);
  }
}

let allSecurityLogs = [];
let securityLogsCurrentPage = 1;
let securityLogsPageSize = 10;

// Load Security Audit Logs
async function loadSecurityLogs() {
  const tbody = document.getElementById('securityLogsTableBody');
  if (!tbody) return;

  try {
    const res = await adminFetch('/api/admin/audit-logs');
    const data = await res.json();

    if (data.success && data.logs) {
      allSecurityLogs = data.logs || [];
      securityLogsCurrentPage = 1;
      renderSecurityLogsPage();
    }
  } catch (err) {
    console.error('Error loading security logs:', err);
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:2rem; color:#dc2626;">लॉग लोड करने में त्रुटि हुई।</td></tr>`;
  }
}

function renderSecurityLogsPage() {
  const tbody = document.getElementById('securityLogsTableBody');
  const paginEl = document.getElementById('securityLogsPagination');
  const infoEl = document.getElementById('securityLogsPaginationInfo');
  const btnsEl = document.getElementById('securityLogsPaginationButtons');
  if (!tbody) return;

  if (!allSecurityLogs || allSecurityLogs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:2rem; color:#64748b;">कोई सुरक्षा ऑडिट लॉग उपलब्ध नहीं है।</td></tr>`;
    if (paginEl) paginEl.style.display = 'none';
    return;
  }

  const total = allSecurityLogs.length;
  const totalPages = Math.ceil(total / securityLogsPageSize) || 1;
  if (securityLogsCurrentPage > totalPages) securityLogsCurrentPage = totalPages;
  if (securityLogsCurrentPage < 1) securityLogsCurrentPage = 1;

  const startIndex = (securityLogsCurrentPage - 1) * securityLogsPageSize;
  const endIndex = Math.min(startIndex + securityLogsPageSize, total);
  const pagedLogs = allSecurityLogs.slice(startIndex, endIndex);

  tbody.innerHTML = '';
  pagedLogs.forEach((log) => {
    const row = document.createElement('tr');
    let badge = '';
    if (log.status === 'success') {
      badge = '<span style="background:#dcfce7; color:#15803d; padding:0.2rem 0.5rem; border-radius:4px; font-weight:700; font-size:0.75rem;">✓ सफल (Success)</span>';
    } else if (log.status === 'blocked') {
      badge = '<span style="background:#fee2e2; color:#b91c1c; padding:0.2rem 0.5rem; border-radius:4px; font-weight:700; font-size:0.75rem;">⛔ अवरुद्ध (Blocked)</span>';
    } else {
      badge = '<span style="background:#fef3c7; color:#b45309; padding:0.2rem 0.5rem; border-radius:4px; font-weight:700; font-size:0.75rem;">⚠️ विफल (Failed)</span>';
    }

    row.innerHTML = `
      <td><strong>#${log.id}</strong></td>
      <td><code style="background:#f1f5f9; padding:2px 6px; border-radius:4px; font-size:0.8rem;">${escapeHtml(log.event_type)}</code></td>
      <td>${badge}</td>
      <td><span style="font-family:monospace; font-size:0.8rem; color:#475569;">${escapeHtml(log.details)}</span></td>
      <td><span style="font-size:0.8rem; color:#64748b;">${formatDate(log.timestamp)}</span></td>
    `;
    tbody.appendChild(row);
  });

  if (paginEl) {
    paginEl.style.display = 'flex';
    paginEl.style.justifyContent = 'space-between';
    paginEl.style.alignItems = 'center';
    paginEl.style.flexWrap = 'wrap';
    paginEl.style.gap = '0.5rem';

    if (infoEl) {
      infoEl.innerHTML = `प्रदर्शित: <strong>${startIndex + 1} - ${endIndex}</strong> / कुल <strong>${total}</strong> रिकॉर्ड (पृष्ठ ${securityLogsCurrentPage}/${totalPages})`;
    }

    if (btnsEl) {
      btnsEl.innerHTML = `
        <button class="btn btn-secondary btn-sm" ${securityLogsCurrentPage <= 1 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="goToSecurityLogsPage(${securityLogsCurrentPage - 1})">
          ◀ पिछला (Prev)
        </button>
        <span style="display:inline-flex; align-items:center; padding:0.25rem 0.6rem; font-size:0.85rem; font-weight:700; color:#1e293b; background:#f8fafc; border:1px solid #e2e8f0; border-radius:4px;">
          ${securityLogsCurrentPage} / ${totalPages}
        </span>
        <button class="btn btn-secondary btn-sm" ${securityLogsCurrentPage >= totalPages ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="goToSecurityLogsPage(${securityLogsCurrentPage + 1})">
          अगला (Next) ▶
        </button>
      `;
    }
  }
}

function goToSecurityLogsPage(page) {
  securityLogsCurrentPage = page;
  renderSecurityLogsPage();
}

function changeSecurityLogsPageSize(newSize) {
  securityLogsPageSize = parseInt(newSize, 10) || 10;
  securityLogsCurrentPage = 1;
  renderSecurityLogsPage();
}

// Re-import Excel Data
async function triggerReimport() {
  if (!confirm('क्या आप सभी Excel फ़ाइलों से डेटा को पुनः सिंक / इम्पोर्ट करना चाहते हैं?')) return;
  const btn = document.getElementById('reimportBtn');
  btn.disabled = true;
  btn.textContent = 'डेटा सिंक हो रहा है...';

  try {
    const res = await adminFetch('/api/admin/reimport', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert('डेटा सफलतापूर्वक इम्पोर्ट हो गया!');
      await loadOrders();
    } else {
      alert('इम्पोर्ट में त्रुटि: ' + data.error);
    }
  } catch (err) {
    if (err.message !== 'AUTH_EXPIRED') alert('सिंक विफल।');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 सभी Excel ग्राम डेटा पुनः सिंक करें';
  }
}

// QR Image Preview & Upload Handlers
function previewSelectedQr(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('adminQrPreview').src = e.target.result;
    document.getElementById('uploadQrBtn').style.display = 'inline-flex';
    document.getElementById('qrUploadMsg').innerHTML = `<span style="color:#2563eb;">चयनित फ़ाइल: ${escapeHtml(file.name)} (${(file.size/1024).toFixed(1)} KB)</span>`;
  };
  reader.readAsDataURL(file);
}

async function uploadQrImage() {
  const fileInput = document.getElementById('qrFileInput');
  const file = fileInput.files[0];
  if (!file) {
    alert('कृपया पहले QR छवि फ़ाइल चुनें।');
    return;
  }

  const uploadBtn = document.getElementById('uploadQrBtn');
  const msgEl = document.getElementById('qrUploadMsg');
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'अपलोड हो रहा है...';

  const formData = new FormData();
  formData.append('qr_image', file);

  try {
    const res = await adminFetch('/api/admin/upload-qr', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      msgEl.innerHTML = `<span style="color:#15803d;">✓ ${escapeHtml(data.message)}</span>`;
      document.getElementById('adminQrPreview').src = `images/payment_qr.png?v=${Date.now()}`;
      uploadBtn.style.display = 'none';
      alert('नया QR कोड सफलतापूर्वक अपलोड और सक्रिय कर दिया गया है!');
    } else {
      msgEl.innerHTML = `<span style="color:#dc2626;">त्रुटि: ${escapeHtml(data.error)}</span>`;
      alert('त्रुटि: ' + data.error);
    }
  } catch (err) {
    console.error('Error uploading QR:', err);
    if (err.message !== 'AUTH_EXPIRED') msgEl.innerHTML = `<span style="color:#dc2626;">अपलोड करने में त्रुटि आई।</span>`;
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = '📤 QR अपलोड करें (Upload & Save QR)';
  }
}

const ALL_UP_DISTRICTS_LIST = [
  'Agra', 'Aligarh', 'Ambedkar Nagar', 'Amethi', 'Amroha', 'Auraiya', 'Ayodhya', 'Azamgarh',
  'Baghpat', 'Bahraich', 'Ballia', 'Balrampur', 'Banda', 'Bara Banki', 'Bareilly', 'Basti',
  'Bhadohi', 'Bijnor', 'Budaun', 'Bulandshahr', 'Chandauli', 'Chitrakoot', 'Deoria', 'Etah',
  'Etawah', 'Farrukhabad', 'Fatehpur', 'Firozabad', 'Gautam Buddha Nagar', 'Ghaziabad', 'Ghazipur',
  'Gonda', 'Gorakhpur', 'Hamirpur', 'Hapur', 'Hardoi', 'Hathras', 'Jalaun', 'Jaunpur', 'Jhansi',
  'Kannauj', 'Kanpur Dehat', 'Kanpur Nagar', 'Kasganj', 'Kaushambi', 'Kheri', 'Kushinagar',
  'Lalitpur', 'Lucknow', 'Mahoba', 'Mahrajganj', 'Mainpuri', 'Mathura', 'Mau', 'Meerut',
  'Mirzapur', 'Moradabad', 'Muzaffarnagar', 'Pilibhit', 'Pratapgarh', 'Prayagraj', 'Rae Bareli',
  'Rampur', 'Saharanpur', 'Sambhal', 'Sant Kabir Nagar', 'Shahjahanpur', 'Shamli', 'Shrawasti',
  'Siddharthnagar', 'Sitapur', 'Sonbhadra', 'Sultanpur', 'Unnao', 'Varanasi'
];

// Load Districts for Upload Form based on State
async function loadUploadDistricts(keepSelected = false) {
  const select = document.getElementById('uploadDistrictSelect');
  if (!select) return;

  const currentVal = keepSelected ? select.value : '';
  const stateSelect = document.getElementById('uploadStateSelect');
  const selectedState = stateSelect ? stateSelect.value : 'Uttar Pradesh';

  select.innerHTML = '<option value="">-- जनपद चुनें (Select District) --</option>';

  if (selectedState === 'Uttar Pradesh') {
    ALL_UP_DISTRICTS_LIST.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      select.appendChild(opt);
    });
  }

  // Also fetch any existing districts from database
  try {
    const res = await fetch('/api/districts');
    const data = await res.json();
    if (data.success && data.districts) {
      data.districts.forEach(d => {
        const exists = Array.from(select.options).some(opt => opt.value.toLowerCase() === d.toLowerCase());
        if (!exists) {
          const opt = document.createElement('option');
          opt.value = d;
          opt.textContent = d;
          select.appendChild(opt);
        }
      });
    }
  } catch (err) {
    console.error('Failed loading districts from API:', err);
  }

  if (currentVal) {
    select.value = currentVal;
  }
}

function onUploadStateChange() {
  loadUploadDistricts(false);
}

// File Selection & Drag-Drop Handling
function onVillageFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;

  const infoEl = document.getElementById('selectedFileInfo');
  if (infoEl) {
    document.getElementById('selectedFileName').textContent = file.name;
    document.getElementById('selectedFileSize').textContent = `${(file.size / 1024).toFixed(1)} KB`;
    infoEl.style.display = 'block';
  }

  // Auto-detect village name & code from filename
  const baseName = file.name.replace(/\.[^/.]+$/, "");
  const codeMatch = baseName.match(/^(.*?)\s+(\d+)$/);
  const villageNameInput = document.getElementById('uploadVillageNameInput');
  const villageCodeInput = document.getElementById('uploadVillageCodeInput');
  const distSelect = document.getElementById('uploadDistrictSelect');

  if (codeMatch) {
    if (villageNameInput && !villageNameInput.value) villageNameInput.value = codeMatch[1].trim();
    if (villageCodeInput && !villageCodeInput.value) villageCodeInput.value = codeMatch[2].trim();
  } else {
    if (villageNameInput && !villageNameInput.value) villageNameInput.value = baseName.replace(/_decoded/gi, '').trim();
  }

  // Auto-detect District if mentioned in filename
  if (distSelect) {
    const lowerName = file.name.toLowerCase();
    for (const d of ALL_UP_DISTRICTS_LIST) {
      if (lowerName.includes(d.toLowerCase())) {
        distSelect.value = d;
        break;
      }
    }
  }
}

// Handle Upload Submit
async function handleVillageDataUpload(e) {
  e.preventDefault();
  const fileInput = document.getElementById('villageDataFileInput');
  const file = fileInput.files[0];

  if (!file) {
    alert('कृपया पहले एक Excel (.xlsx, .xls) या डाटा फ़ाइल चुनें।');
    document.getElementById('uploadDropZone').click();
    return;
  }

  const uploadBtn = document.getElementById('startUploadBtn');
  uploadBtn.disabled = true;
  uploadBtn.textContent = '⏳ डेटा प्रोसेस व अपलोड हो रहा है... कृपया प्रतीक्षा करें...';

  const resultCard = document.getElementById('uploadResultCard');
  if (resultCard) resultCard.style.display = 'none';

  const stateVal = (document.getElementById('uploadStateSelect')?.value || 'Uttar Pradesh').trim();
  const distVal = (document.getElementById('uploadDistrictSelect')?.value || document.getElementById('uploadDistrictInput')?.value || '').trim();

  if (!distVal) {
    alert('कृपया जनपद (District) का चयन करें!');
    document.getElementById('uploadDistrictSelect')?.focus();
    uploadBtn.disabled = false;
    uploadBtn.textContent = '🚀 ग्राम डेटा अपलोड व तुरंत लाइव करें (Upload & Live Activate)';
    return;
  }

  const formData = new FormData();
  formData.append('village_file', file);
  formData.append('state_name', stateVal);
  formData.append('district_name', distVal);
  formData.append('tehsil_name', (document.getElementById('uploadTehsilInput')?.value || '').trim());
  formData.append('village_name', (document.getElementById('uploadVillageNameInput')?.value || '').trim());
  formData.append('village_code', (document.getElementById('uploadVillageCodeInput')?.value || '').trim());

  try {
    const res = await adminFetch('/api/admin/upload-village-data', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      if (resultCard) {
        const titleEl = document.getElementById('uploadResultTitle');
        const subEl = document.getElementById('uploadResultSubtitle');
        const citEl = document.getElementById('resCitizenCount');
        const excEl = document.getElementById('resExcludedCount');
        const vcEl = document.getElementById('resVillageCode');

        if (titleEl) titleEl.textContent = `ग्राम '${data.villageName}' (${data.districtName}) सफलतापूर्वक लाइव सक्रिय हो गया!`;
        if (subEl) subEl.textContent = data.message;
        if (citEl) citEl.textContent = data.validPropertiesCount;
        if (excEl) excEl.textContent = data.skippedPublicCount || 0;
        if (vcEl) vcEl.textContent = data.villageCode || '--';
        resultCard.style.display = 'block';
      }
      alert(`🎉 ग्राम डेटा सफलतापूर्वक डेटाबेस में सेव व लाइव सक्रिय हो गया है!\n\nग्राम: ${data.villageName}\nजनपद: ${data.districtName}\nकुल वैध संपत्ति रिकॉर्ड्स: ${data.validPropertiesCount}`);
      
      document.getElementById('villageUploadForm').reset();
      const stateSelect = document.getElementById('uploadStateSelect');
      if (stateSelect) stateSelect.value = 'Uttar Pradesh';
      loadUploadDistricts(false);
      const fileInfo = document.getElementById('selectedFileInfo');
      if (fileInfo) fileInfo.style.display = 'none';

      // Refresh admin dashboard stats
      if (typeof loadAdminStats === 'function') loadAdminStats();
      if (typeof loadRecentDataRequests === 'function') loadRecentDataRequests();
    } else {
      alert('अपलोड त्रुटि: ' + (data.error || 'अज्ञात त्रुटि'));
    }
  } catch (err) {
    console.error('Upload error:', err);
    if (err.message !== 'AUTH_EXPIRED') alert('सर्वर पर फ़ाइल अपलोड करने में त्रुटि आई: ' + (err.message || ''));
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = '🚀 ग्राम डेटा अपलोड व तुरंत लाइव करें (Upload & Live Activate)';
  }
}

function formatDate(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  return d.toLocaleString('hi-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Download Complete Live Database Backup (JSON)
async function downloadLiveDatabaseBackup() {
  try {
    const res = await adminFetch('/api/admin/export-database');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('डेटाबेस डाउनलोड विफल: ' + (err.error || 'अज्ञात त्रुटि'));
      return;
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `property_portal_database_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Error downloading database backup:', err);
    alert('डेटाबेस बैकअप डाउनलोड करने में त्रुटि।');
  }
}

// Export Filtered Orders to Excel (.xlsx)
async function exportOrdersToExcel(statusOverride) {
  try {
    const statusFilter = statusOverride || document.getElementById('allOrdersStatusFilter')?.value || 'all';
    const token = getStoredAdminToken();
    if (!token) {
      alert('सत्र समाप्त हो गया है। कृपया पुनः लॉगिन करें।');
      showLoginScreen();
      return;
    }

    const url = `/api/admin/orders/export-excel?status=${encodeURIComponent(statusFilter)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      alert('Excel एक्सपोर्ट विफल: ' + (errJson.error || 'सर्वर त्रुटि'));
      return;
    }

    const blob = await res.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    const statusText = statusFilter !== 'all' ? `_${statusFilter}` : '_all';
    a.download = `Property_Orders${statusText}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);
  } catch (err) {
    console.error('Excel download error:', err);
    alert('Excel फ़ाइल डाउनलोड करने में त्रुटि आई।');
  }
}

// Restore Database from selected JSON File
async function handleRestoreDatabaseFromFile() {
  const fileInput = document.getElementById('dbRestoreFileInput');
  const file = fileInput?.files?.[0];
  if (!file) {
    alert('कृपया पहले एक वैध .json डेटाबेस बैकअप फ़ाइल चुनें!');
    return;
  }

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const backupData = JSON.parse(e.target.result);
      if (!backupData || typeof backupData !== 'object') {
        alert('अमान्य बैकअप फ़ाइल प्रारूप (Invalid JSON).');
        return;
      }

      const propCount = backupData.properties ? backupData.properties.length : (backupData.counts?.properties || 0);
      const orderCount = backupData.orders ? backupData.orders.length : (backupData.counts?.orders || 0);
      const reqCount = backupData.missing_data_requests ? backupData.missing_data_requests.length : (backupData.counts?.missing_data_requests || 0);

      const confirmMsg = `⚠️ क्या आप डेटाबेस को इस बैकअप फ़ाइल से रीस्टोर करना चाहते हैं?\n\n• प्रॉपर्टीज: ${propCount}\n• ऑर्डर्स: ${orderCount}\n• ग्राम अनुरोध: ${reqCount}\n\nनोट: वर्तमान डेटा सुरक्षित बैकअप स्नैपशॉट में सेव होने के बाद रीस्टोर होगा।`;
      
      if (!confirm(confirmMsg)) return;

      const res = await adminFetch('/api/admin/restore-database', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(backupData)
      });
      const data = await res.json();

      if (data.success) {
        alert(`🎉 डेटाबेस सफलतापूर्वक रीस्टोर हो गया!\n\n• कुल प्रॉपर्टीज: ${data.stats?.properties || 0}\n• कुल ग्राम: ${data.stats?.villages || 0}\n• कुल ऑर्डर्स: ${data.stats?.orders || 0}\n• कुल अनुरोध: ${data.stats?.missing_data_requests || 0}`);
        fileInput.value = '';
        await loadOrders();
        await loadDataRequests();
        await loadSettingsAdmin();
      } else {
        alert('रीस्टोर त्रुटि: ' + (data.error || 'अज्ञात त्रुटि'));
      }
    } catch (parseErr) {
      console.error('Error parsing JSON backup:', parseErr);
      alert('JSON फ़ाइल पढ़ने में विफलता। कृपया सुनिश्चित करें कि यह एक वैध JSON फ़ाइल है।');
    }
  };
  reader.readAsText(file);
}
