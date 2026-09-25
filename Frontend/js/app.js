// Public Portal Application Logic
let currentDistrict = '';
let currentVillageCode = '';
let currentVillageName = '';
let currentSearch = '';
let currentPage = 1;
let currentOrder = null;
let pollInterval = null;
let activeSettings = { price: 0, upi_id: '', merchant_name: '' };

// DOM Elements
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  await loadSettings();
  await loadDistricts();
  await loadAvailableCoverage();
  setupEventListeners();
  checkSavedOrder();
}

// Load Global Settings (Price, UPI ID, Merchant)
async function loadSettings() {
  try {
    const res = await fetch(`/api/settings?_t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.success && data.data) {
      activeSettings = data.data;
      updateAllPriceElements();
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

function updateAllPriceElements() {
  const numPrice = Number(activeSettings.price) || 0;
  if (numPrice <= 0) return;
  const formattedExact = `₹${numPrice.toFixed(2)}`;
  const formattedSimple = `₹${numPrice % 1 === 0 ? numPrice.toFixed(0) : numPrice.toFixed(2)}`;

  document.querySelectorAll('.dynamic-fee').forEach(el => {
    el.textContent = formattedSimple;
  });
  document.querySelectorAll('.dynamic-fee-exact').forEach(el => {
    el.textContent = formattedExact;
  });
}

// Handle State Change
let currentState = 'Uttar Pradesh';

async function onStateChange() {
  const stateSelect = document.getElementById('stateSelect');
  currentState = stateSelect.value;
  const districtSelect = document.getElementById('districtSelect');
  const villageSelect = document.getElementById('villageSelect');
  const banner = document.getElementById('unavailableDataBanner');
  
  currentDistrict = '';
  currentVillageCode = '';
  currentVillageName = '';
  document.getElementById('villagersSection').style.display = 'none';

  if (currentState === 'Uttar Pradesh') {
    if (banner) banner.style.display = 'none';
    districtSelect.disabled = false;
    await loadDistricts();
    villageSelect.innerHTML = '<option value="">-- पहले जिला चुनें --</option>';
    villageSelect.disabled = true;
  } else {
    districtSelect.innerHTML = `<option value="">-- ${currentState} का डेटा प्रक्रियाधीन है --</option>`;
    districtSelect.disabled = true;
    villageSelect.innerHTML = '<option value="">-- अनुपलब्ध --</option>';
    villageSelect.disabled = true;

    if (banner) {
      document.getElementById('unavailableBannerTitle').textContent = `'${currentState}' का डेटा वर्तमान में संकलन प्रक्रिया में है`;
      document.getElementById('unavailableBannerDesc').textContent = `वर्तमान में '${currentState}' के ग्रामों का डिजिटल रिकॉर्ड पोर्टल में जोड़ा जा रहा है। यदि आप अपने ग्राम का डेटा शीघ्र जुड़वाना चाहते हैं, तो कृपया नीचे दिए गए बटन पर क्लिक कर विवरण दर्ज करें।`;
      document.getElementById('unavailableBtnText').textContent = `'${currentState}' के ग्राम का डेटा जोड़ने का अनुरोध करें`;
      banner.style.display = 'block';
    }
  }
}

// Load Districts
async function loadDistricts() {
  const districtSelect = document.getElementById('districtSelect');
  districtSelect.innerHTML = '<option value="">-- जिला चुनें (Select District) --</option>';

  try {
    const res = await fetch(`/api/districts?_t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.success && data.districts) {
      data.districts.forEach(dist => {
        const opt = document.createElement('option');
        opt.value = dist;
        opt.textContent = dist;
        districtSelect.appendChild(opt);
      });
    }
  } catch (err) {
    console.error('Error fetching districts:', err);
  }
}

let currentTehsil = '';

// District Changed -> Load Villages directly
async function onDistrictChange() {
  const district = document.getElementById('districtSelect').value;
  const villageSelect = document.getElementById('villageSelect');
  const banner = document.getElementById('unavailableDataBanner');
  currentDistrict = district;
  currentTehsil = '';
  currentVillageCode = '';
  currentVillageName = '';

  document.getElementById('villagersSection').style.display = 'none';

  if (!district) {
    if (banner) banner.style.display = 'none';
    villageSelect.innerHTML = '<option value="">-- Select Village --</option>';
    villageSelect.disabled = true;
    return;
  }

  // Load Villages directly for the selected district
  await loadVillagesForDistrict(district, '');
}

// Load Tehsils helper
async function loadTehsilsForDistrict(district) {
  const tehsilSelect = document.getElementById('tehsilSelect');
  if (!tehsilSelect) return;
  tehsilSelect.innerHTML = '<option value="">-- All Tehsils (सभी तहसीलें) --</option>';

  try {
    const res = await fetch(`/api/tehsils?district=${encodeURIComponent(district)}&_t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.success && data.tehsils) {
      data.tehsils.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        tehsilSelect.appendChild(opt);
      });
    }
  } catch (err) {
    console.error('Error loading tehsils:', err);
  }
}

// Tehsil Changed -> Filter Villages
async function onTehsilChange() {
  const tehsil = document.getElementById('tehsilSelect')?.value || '';
  currentTehsil = tehsil;
  currentVillageCode = '';
  currentVillageName = '';
  document.getElementById('villagersSection').style.display = 'none';
  await loadVillagesForDistrict(currentDistrict, tehsil);
}

// Helper: Load Villages by District and Tehsil
async function loadVillagesForDistrict(district, tehsil = '') {
  const villageSelect = document.getElementById('villageSelect');
  const banner = document.getElementById('unavailableDataBanner');
  villageSelect.innerHTML = '<option value="">-- Select Village (ग्राम चुनें) --</option>';

  if (!district) {
    villageSelect.disabled = true;
    return;
  }

  try {
    const url = `/api/villages?district=${encodeURIComponent(district)}&tehsil=${encodeURIComponent(tehsil)}&_t=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();

    if (data.success && data.villages && data.villages.length > 0) {
      if (banner) banner.style.display = 'none';
      villageSelect.disabled = false;
      data.villages.forEach(v => {
        const opt = document.createElement('option');
        opt.value = String(v.village_code).trim();
        opt.dataset.villageName = v.village_name;
        opt.dataset.tehsil = v.tehsil || '';
        opt.textContent = `${v.village_name} (${v.village_code})`;
        villageSelect.appendChild(opt);
      });
      if (currentVillageCode) {
        villageSelect.value = String(currentVillageCode).trim();
      }
    } else {
      villageSelect.innerHTML = `<option value="">-- No villages found --</option>`;
      villageSelect.disabled = true;

      if (banner) {
        document.getElementById('unavailableBannerTitle').textContent = `जनपद '${district}' का डेटा वर्तमान में संकलन प्रक्रिया में है`;
        document.getElementById('unavailableBannerDesc').textContent = `वर्तमान में जनपद '${district}' के ग्रामों का डिजिटल रिकॉर्ड पोर्टल में जोड़ा जा रहा है। यदि आप अपने ग्राम का डेटा शीघ्र जुड़वाना चाहते हैं, तो कृपया नीचे दिए गए बटन पर क्लिक कर अनुरोध भेजें।`;
        document.getElementById('unavailableBtnText').textContent = `जनपद '${district}' के ग्राम का डेटा जोड़ने का अनुरोध करें`;
        banner.style.display = 'block';
      }
    }
  } catch (err) {
    console.error('Error loading villages:', err);
  }
}

// Search by Village Name or Code Button Handler
async function searchByVillageOrCode() {
  const inputVal = (document.getElementById('quickVillageCodeInput')?.value || '').trim();
  if (!inputVal) {
    alert('Please enter a village name or village code to search.');
    return;
  }
  handleQuickVillageSearch(inputVal);
}

// Reset Form Filters
function resetFilters() {
  document.getElementById('stateSelect').value = 'Uttar Pradesh';
  document.getElementById('districtSelect').value = '';
  const villageSelect = document.getElementById('villageSelect');
  if (villageSelect) {
    villageSelect.innerHTML = '<option value="">-- Select Village --</option>';
    villageSelect.disabled = true;
  }
  const quickInput = document.getElementById('quickVillageCodeInput');
  if (quickInput) quickInput.value = '';
  const villagerSearch = document.getElementById('villagerSearchInput');
  if (villagerSearch) villagerSearch.value = '';
  document.getElementById('villagersSection').style.display = 'none';
  currentDistrict = '';
  currentTehsil = '';
  currentVillageCode = '';
  currentVillageName = '';
}

// Export Table Data to Excel / CSV
function exportToExcel() {
  if (!currentDistrict) {
    alert('Please select a district first to export records.');
    return;
  }
  const villageName = currentVillageName || 'Records';
  const table = document.querySelector('.property-table');
  if (!table || document.getElementById('villagersSection').style.display === 'none') {
    alert('Please select a village or search to view records before exporting.');
    return;
  }

  let csv = [];
  const rows = table.querySelectorAll('tr');
  rows.forEach(r => {
    const cols = r.querySelectorAll('th, td');
    let rowData = [];
    cols.forEach((c, idx) => {
      if (idx < cols.length - 1) { // exclude Action button
        rowData.push('"' + (c.innerText || '').replace(/"/g, '""').trim() + '"');
      }
    });
    if (rowData.length > 0) csv.push(rowData.join(','));
  });

  const blob = new Blob(["\uFEFF" + csv.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${currentDistrict}_${villageName}_Properties.csv`;
  link.click();
}

// Interactive FAQ Toggle
function toggleFaq(button) {
  const faqItem = button.closest('.faq-item');
  if (!faqItem) return;
  const wasActive = faqItem.classList.contains('active');
  
  // Close other FAQ items
  document.querySelectorAll('.faq-item').forEach(item => item.classList.remove('active'));
  
  if (!wasActive) {
    faqItem.classList.add('active');
  }
}

// Update Step Guide active indicator
function updateStepGuides(activeStep) {
  const s1 = document.getElementById('stepGuide1');
  const s2 = document.getElementById('stepGuide2');
  const s3 = document.getElementById('stepGuide3');
  
  if (s1) s1.classList.toggle('active', activeStep === 1);
  if (s2) s2.classList.toggle('active', activeStep === 2);
  if (s3) s3.classList.toggle('active', activeStep === 3);
}

// Village Changed -> Load Villagers List
async function onVillageChange() {
  const villageSelect = document.getElementById('villageSelect');
  const covSection = document.getElementById('availableCoverageSection');
  currentVillageCode = String(villageSelect.value || '').trim();
  const selectedOption = villageSelect.options[villageSelect.selectedIndex];
  currentVillageName = (selectedOption && selectedOption.dataset && selectedOption.dataset.villageName) 
    ? selectedOption.dataset.villageName 
    : (currentVillageName || currentVillageCode);
  currentPage = 1;

  if (!currentVillageCode) {
    document.getElementById('villagersSection').style.display = 'none';
    if (covSection) covSection.style.display = 'block';
    updateStepGuides(1);
    return;
  }

  // Hide Available Coverage Directory table after selection / searching
  if (covSection) covSection.style.display = 'none';

  document.getElementById('selectedVillageDisplay').textContent = `${currentVillageName} (कोड: ${currentVillageCode})`;
  document.getElementById('selectedDistrictDisplay').textContent = currentDistrict;
  document.getElementById('villagersSection').style.display = 'block';
  updateStepGuides(2);

  await loadVillagers();
}

const currentPropertiesMap = new Map();

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Copy Property ID with visual feedback & toast
function copyPropertyId(text, btn) {
  if (!text) return;
  
  function onSuccess() {
    if (btn) {
      const origHtml = btn.innerHTML;
      btn.innerHTML = '✅ <span>Copied!</span>';
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-emerald');
      setTimeout(() => {
        btn.innerHTML = origHtml;
        btn.classList.remove('btn-emerald');
        btn.classList.add('btn-secondary');
      }, 2000);
    }
    showToastNotification(`✅ Property ID (${text}) कॉपी हो गई!`);
  }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
      fallbackCopy(text, onSuccess);
    });
  } else {
    fallbackCopy(text, onSuccess);
  }
}

function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    if (cb) cb();
  } catch (e) {
    prompt('कृपया Property ID कॉपी करें:', text);
  }
  document.body.removeChild(ta);
}

function showToastNotification(msg) {
  let toast = document.getElementById('globalAppToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalAppToast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #0f172a;
      color: #ffffff;
      padding: 12px 20px;
      border-radius: 10px;
      font-size: 0.9rem;
      font-weight: 600;
      box-shadow: 0 10px 25px rgba(0,0,0,0.25);
      z-index: 999999;
      display: flex;
      align-items: center;
      gap: 10px;
      transition: opacity 0.3s ease, transform 0.3s ease;
      opacity: 0;
      transform: translateY(10px);
      pointer-events: none;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
  }, 2500);
}

function triggerUnlock(propId) {
  const rec = currentPropertiesMap.get(Number(propId)) || currentPropertiesMap.get(String(propId));
  if (!rec) {
    console.error('Property record not found for ID:', propId);
    return;
  }
  updateStepGuides(3);
  openPaymentModal(rec.id, rec.owner_name, rec.father_name);
}

// Fetch Villagers for selected village
async function loadVillagers() {
  const tbody = document.getElementById('villagersTableBody');
  const countBadge = document.getElementById('recordsCountBadge');
  const paginationInfo = document.getElementById('paginationInfo');
  
  tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 2rem; color: #64748b;">⏳ रिकॉर्ड लोड हो रहे हैं (Loading records)...</td></tr>`;

  try {
    const searchVal = document.getElementById('villagerSearchInput').value.trim();
    const url = `/api/properties?district=${encodeURIComponent(currentDistrict)}&villageCode=${encodeURIComponent(currentVillageCode)}&search=${encodeURIComponent(searchVal)}&page=${currentPage}&limit=25&_t=${Date.now()}`;
    
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();

    if (!data.success || !data.records || data.records.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align: center; padding: 2.5rem; color: #64748b;">
            <div style="font-size: 1.8rem; margin-bottom: 0.5rem;">🔍</div>
            <p style="font-weight: 700; color: #334155; margin-bottom: 0.5rem; font-size: 1rem;">
              इस खोज अथवा ग्राम में कोई रिकॉर्ड नहीं मिला।
            </p>
            <p style="font-size: 0.85rem; color: #64748b; margin-bottom: 1rem;">
              कृपया सही नाम/स्पेलिंग जांचें या डेटा जोड़ने का अनुरोध करें।
            </p>
            <button class="btn btn-outline-primary btn-sm" onclick="openMissingDataModal('${escapeHtml(currentState)}', '${escapeHtml(currentDistrict)}', '${escapeHtml(currentVillageName)}')">
              ➕ इस ग्राम / व्यक्ति का डेटा जोड़ने का अनुरोध करें (Request Data)
            </button>
          </td>
        </tr>
      `;
      countBadge.textContent = `0 रिकॉर्ड्स`;
      paginationInfo.textContent = `पृष्ठ 0 / 0`;
      document.getElementById('prevPageBtn').disabled = true;
      document.getElementById('nextPageBtn').disabled = true;
      return;
    }

    countBadge.textContent = `${data.total} रिकॉर्ड्स`;
    paginationInfo.textContent = `पृष्ठ ${data.page} / ${data.totalPages} (कुल: ${data.total} रिकॉर्ड)`;
    document.getElementById('prevPageBtn').disabled = data.page <= 1;
    document.getElementById('nextPageBtn').disabled = data.page >= data.totalPages;

    currentPropertiesMap.clear();
    tbody.innerHTML = '';
    const numPrice = Number(activeSettings.price) || 0;
    const priceText = numPrice > 0 ? (numPrice % 1 === 0 ? `₹${numPrice.toFixed(0)}` : `₹${numPrice.toFixed(2)}`) : 'अनलॉक';

    data.records.forEach((rec, idx) => {
      const mapKey = isNaN(Number(rec.id)) ? String(rec.id) : Number(rec.id);
      currentPropertiesMap.set(mapKey, rec);
      const row = document.createElement('tr');
      const serialNum = (data.page - 1) * data.limit + (idx + 1);
      const propCardId = rec.property_card_id || rec.masked_property_card_id || '--';

      row.innerHTML = `
        <td style="font-weight: 700; color: #64748b; text-align: center;">${serialNum}</td>
        <td>${escapeHtml(rec.state_name || 'Uttar Pradesh')}</td>
        <td><strong>${escapeHtml(rec.district_name || currentDistrict)}</strong></td>
        <td>${escapeHtml(rec.village_name || currentVillageName)}</td>
        <td><strong style="color: #0f172a;">${escapeHtml(rec.owner_name) || 'अज्ञात'}</strong></td>
        <td>${escapeHtml(rec.father_name) || '--'}</td>
        <td style="text-align: right; font-weight: 600;">${rec.total_area || '0'}</td>
        <td style="text-align: center; white-space: nowrap;">
          <div style="display: inline-flex; align-items: center; gap: 6px; background: #f8fafc; padding: 3px 8px; border-radius: 6px; border: 1px solid #cbd5e1;">
            <span style="font-family: monospace; font-weight: 700; font-size: 0.88rem; color: #1e293b; letter-spacing: 0.5px;">${escapeHtml(propCardId)}</span>
            <button type="button" class="btn btn-secondary btn-sm" onclick="copyPropertyId('${escapeHtml(rec.property_card_id || propCardId)}', this)" title="Copy Property ID" style="padding: 2px 7px; font-size: 0.72rem; display: inline-flex; align-items: center; gap: 3px; font-weight: 700; cursor: pointer;">
              📋 <span>Copy</span>
            </button>
          </div>
        </td>
        <td style="text-align: center;">
          <button type="button" class="btn btn-primary btn-sm" onclick="triggerUnlock('${rec.id}')" style="font-size: 0.78rem; padding: 0.35rem 0.75rem; white-space: nowrap;">
            🔓 अनलॉक (Unlock)
          </button>
        </td>
      `;
      tbody.appendChild(row);
    });

  } catch (err) {
    console.error('Error loading villagers list:', err);
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; padding: 2rem; color: #dc2626;">रिकॉर्ड प्राप्त करने में त्रुटि। पुनः प्रयास करें।</td></tr>`;
  }
}

// Direct Payment Modal Flow
async function openPaymentModal(propId, ownerName, fatherName) {
  const modal = document.getElementById('paymentModal');
  const userMobileInput = document.getElementById('payMobileInput');
  const utrInput = document.getElementById('utrInput');
  const errBox = document.getElementById('utrErrorBox');

  if (errBox) {
    errBox.style.display = 'none';
    errBox.textContent = '';
  }

  if (userMobileInput) {
    userMobileInput.style.borderColor = '#cbd5e1';
    const savedMobile = localStorage.getItem('user_saved_mobile') || '';
    userMobileInput.value = savedMobile;
    userMobileInput.oninput = () => {
      userMobileInput.value = userMobileInput.value.replace(/\D/g, '').slice(0, 10);
      userMobileInput.style.borderColor = '#cbd5e1';
      if (errBox) errBox.style.display = 'none';
    };
  }

  if (utrInput) {
    utrInput.value = '';
    utrInput.style.borderColor = '#f59e0b';
    utrInput.oninput = () => {
      utrInput.style.borderColor = '#f59e0b';
      if (errBox) errBox.style.display = 'none';
    };
  }

  document.getElementById('payOwnerDisplay').textContent = ownerName || '--';
  document.getElementById('payFatherDisplay').textContent = fatherName || '--';
  document.getElementById('payVillageDisplay').textContent = `${currentVillageName} (कोड: ${currentVillageCode})`;
  document.getElementById('payDistrictDisplay').textContent = currentDistrict;
  document.getElementById('orderIdDisplay').textContent = 'लोड हो रहा है...';

  // Check if this property already has a saved order
  const savedPropOrder = JSON.parse(localStorage.getItem('order_prop_' + propId) || 'null');

  // Show main payment screen
  const stepMain = document.getElementById('paymentStepMain');
  if (stepMain) stepMain.style.display = 'block';
  const step3 = document.getElementById('paymentStep3');
  if (step3) step3.style.display = 'none';

  const hiddenPropId = document.getElementById('currentSelectedPropId');
  if (hiddenPropId) hiddenPropId.value = propId;

  if (modal) modal.classList.add('active');

  // Request order from backend (reuses existing active or verified order)
  try {
    const res = await fetch('/api/orders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        propertyId: propId, 
        userMobile: localStorage.getItem('user_saved_mobile') || '',
        existingOrderId: savedPropOrder?.order_id || localStorage.getItem('active_order_id'),
        existingOrderToken: savedPropOrder?.order_token || localStorage.getItem('active_order_token')
      })
    });
    const data = await res.json();

    if (data.success && data.order) {
      currentOrder = data.order;
      localStorage.setItem('active_order_id', currentOrder.order_id);
      localStorage.setItem('active_order_token', currentOrder.order_token);
      localStorage.setItem('order_prop_' + propId, JSON.stringify({
        order_id: currentOrder.order_id,
        order_token: currentOrder.order_token
      }));

      // If already verified, directly show certificate
      if (currentOrder.status === 'verified') {
        closeModal('paymentModal');
        displayUnlockedCertificate(currentOrder);
        return;
      }

      // If UTR was already submitted and pending, show status screen
      if (currentOrder.transaction_ref && currentOrder.status === 'pending') {
        showOrderStatusScreen(currentOrder);
        startStatusPolling(currentOrder.order_id, currentOrder.order_token);
        return;
      }

      document.getElementById('orderIdDisplay').textContent = currentOrder.order_id;
      document.getElementById('qrUpiIdText').textContent = currentOrder.upi_id;

      const upiIntentBtn = document.getElementById('upiIntentBtn');
      const orderPrice = (Number(currentOrder.amount || activeSettings.price) || 80).toFixed(2);
      if (currentOrder.upi_uri) {
        upiIntentBtn.href = currentOrder.upi_uri;
      } else {
        upiIntentBtn.href = `upi://pay?pa=${encodeURIComponent(currentOrder.upi_id)}&pn=${encodeURIComponent(currentOrder.merchant_name)}&am=${orderPrice}&cu=INR&tn=${encodeURIComponent(currentOrder.order_id)}`;
      }

      // Pre-fill mobile from localStorage if present & validate button state
      const savedMobile = localStorage.getItem('user_saved_mobile');
      const payMobileInput = document.getElementById('payMobileInput');
      if (payMobileInput && savedMobile && !payMobileInput.value) {
        payMobileInput.value = savedMobile;
      }
      checkPaymentFormValidity();
    }
  } catch (err) {
    console.error('Error initiating payment order:', err);
  }
}

// Real-time Payment Form Validator: Disables button until both Mobile (10 digits) & UTR (6 to 30 alphanumeric) are filled
function checkPaymentFormValidity() {
  const mobileEl = document.getElementById('payMobileInput');
  const utrEl = document.getElementById('utrInput');
  const submitBtn = document.getElementById('submitUtrBtn');
  const counterEl = document.getElementById('payMobileCounter');
  const utrCounterEl = document.getElementById('utrCounter');
  const errBox = document.getElementById('utrErrorBox');

  const rawMobile = mobileEl ? mobileEl.value.replace(/\D/g, '').slice(0, 10) : '';
  if (mobileEl && mobileEl.value !== rawMobile) {
    mobileEl.value = rawMobile;
  }

  if (counterEl) {
    counterEl.textContent = `${rawMobile.length}/10 अंक`;
    if (rawMobile.length === 10) {
      counterEl.style.background = '#dcfce7';
      counterEl.style.color = '#15803d';
      counterEl.style.borderColor = '#86efac';
    } else {
      counterEl.style.background = '#fef3c7';
      counterEl.style.color = '#78350f';
      counterEl.style.borderColor = '#fde68a';
    }
  }

  // Clean UTR: alphanumeric only, max 30 chars
  let cleanUtr = utrEl ? utrEl.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 30) : '';
  if (utrEl && utrEl.value !== cleanUtr) {
    utrEl.value = cleanUtr;
  }

  if (utrCounterEl) {
    if (cleanUtr.length === 0) {
      utrCounterEl.textContent = '0/12 (न्यूनतम 6, अधिकतम 30)';
      utrCounterEl.style.background = '#fef3c7';
      utrCounterEl.style.color = '#78350f';
      utrCounterEl.style.borderColor = '#fde68a';
    } else if (cleanUtr.length < 6) {
      utrCounterEl.textContent = `${cleanUtr.length}/30 (न्यूनतम 6 आवश्यक)`;
      utrCounterEl.style.background = '#fee2e2';
      utrCounterEl.style.color = '#991b1b';
      utrCounterEl.style.borderColor = '#fca5a5';
    } else {
      utrCounterEl.textContent = `${cleanUtr.length}/30 ✓ (मान्य UTR)`;
      utrCounterEl.style.background = '#dcfce7';
      utrCounterEl.style.color = '#15803d';
      utrCounterEl.style.borderColor = '#86efac';
    }
  }

  const isMobileValid = (rawMobile.length === 10 && /^[6-9]\d{9}$/.test(rawMobile));
  const isUtrValid = (cleanUtr.length >= 6 && cleanUtr.length <= 30);

  // Visual outline indicators
  if (mobileEl) {
    if (isMobileValid) {
      mobileEl.style.borderColor = '#10b981';
      mobileEl.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.15)';
    } else if (rawMobile.length > 0) {
      mobileEl.style.borderColor = '#f59e0b';
      mobileEl.style.boxShadow = 'none';
    } else {
      mobileEl.style.borderColor = '#cbd5e1';
      mobileEl.style.boxShadow = 'none';
    }
  }

  if (utrEl) {
    if (isUtrValid) {
      utrEl.style.borderColor = '#10b981';
      utrEl.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.15)';
    } else if (cleanUtr.length > 0) {
      utrEl.style.borderColor = '#f59e0b';
      utrEl.style.boxShadow = 'none';
    } else {
      utrEl.style.borderColor = '#cbd5e1';
      utrEl.style.boxShadow = 'none';
    }
  }

  // Strictly enable or disable submit button
  if (submitBtn) {
    if (isMobileValid && isUtrValid) {
      submitBtn.removeAttribute('disabled');
      submitBtn.disabled = false;
      submitBtn.style.opacity = '1';
      submitBtn.style.cursor = 'pointer';
      submitBtn.style.pointerEvents = 'auto';
      submitBtn.style.filter = 'none';
      submitBtn.style.background = '#10b981';
      if (errBox) errBox.style.display = 'none';
    } else {
      submitBtn.setAttribute('disabled', 'true');
      submitBtn.disabled = true;
      submitBtn.style.opacity = '0.45';
      submitBtn.style.cursor = 'not-allowed';
      submitBtn.style.pointerEvents = 'none';
      submitBtn.style.filter = 'grayscale(35%)';
    }
  }
}

// Attach live listeners to payment inputs once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  ['payMobileInput', 'utrInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', checkPaymentFormValidity);
      el.addEventListener('keyup', checkPaymentFormValidity);
      el.addEventListener('change', checkPaymentFormValidity);
      el.addEventListener('paste', () => setTimeout(checkPaymentFormValidity, 50));
    }
  });
});

// Restore saved order state on page load
async function checkSavedOrder() {
  try {
    const activeOrderId = localStorage.getItem('active_order_id');
    const activeOrderToken = localStorage.getItem('active_order_token');
    if (!activeOrderId) return;

    const res = await fetch(`/api/orders/status?orderId=${encodeURIComponent(activeOrderId)}&orderToken=${encodeURIComponent(activeOrderToken || '')}`);
    const data = await res.json();
    if (data.success && data.order) {
      currentOrder = data.order;
    }
  } catch (err) {
    console.error('checkSavedOrder error:', err);
  }
}

// Copy UPI ID to clipboard
function copyUpiId() {
  const upiId = document.getElementById('qrUpiIdText').textContent;
  navigator.clipboard.writeText(upiId).then(() => {
    alert('UPI ID क्लिपबोर्ड पर कॉपी हो गया: ' + upiId);
  }).catch(() => {
    prompt('UPI ID कॉपी करें:', upiId);
  });
}

// Submit Order / UTR Request (Both Mobile and UTR are STRICTLY REQUIRED)
async function submitUtrTransaction() {
  const mobileInputEl = document.getElementById('payMobileInput');
  const utrInputEl = document.getElementById('utrInput');
  const errBox = document.getElementById('utrErrorBox');

  const rawMobile = mobileInputEl ? mobileInputEl.value.trim() : '';
  const cleanMobile = rawMobile.replace(/\D/g, '').slice(-10);
  const cleanUtr = utrInputEl ? utrInputEl.value.trim() : '';

  // 1. Mandatory Mobile Number Validation (10 digits starting with 6-9)
  if (!cleanMobile || cleanMobile.length !== 10 || !/^[6-9]\d{9}$/.test(cleanMobile)) {
    if (errBox) {
      errBox.innerHTML = '⚠️ <strong>मान्य मोबाइल नंबर आवश्यक है:</strong> कृपया अपना 10 अंकों का मान्य भारतीय मोबाइल नंबर (शुरुआत 6, 7, 8 या 9) दर्ज करें।';
      errBox.style.display = 'block';
    }
    if (mobileInputEl) {
      mobileInputEl.style.borderColor = '#ef4444';
      mobileInputEl.focus();
    }
    return;
  }
  localStorage.setItem('user_saved_mobile', cleanMobile);

  // 2. Mandatory UTR / UPI Transaction ID Validation (6 to 30 alphanumeric)
  if (!cleanUtr || cleanUtr.length < 6 || cleanUtr.length > 30 || !/^[A-Za-z0-9]{6,30}$/.test(cleanUtr)) {
    if (errBox) {
      errBox.innerHTML = '⚠️ <strong>मान्य UTR आईडी आवश्यक है:</strong> कृपया UPI भुगतान के बाद प्राप्त न्यूनतम 6 व अधिकतम 30 अक्षरों/अंकों का UPI Ref / UTR ID दर्ज करें (मानक UPI UTR 12 अंक होता है)।';
      errBox.style.display = 'block';
    }
    if (utrInputEl) {
      utrInputEl.style.borderColor = '#ef4444';
      utrInputEl.focus();
    }
    return;
  }

  if (!currentOrder || !currentOrder.order_id) {
    alert('ऑर्डर विवरण लोड हो रहा है, कृपया 2 सेकंड बाद पुनः प्रयास करें।');
    return;
  }

  const submitBtn = document.getElementById('submitUtrBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ सत्यापित किया जा रहा है...';

  try {
    if (errBox) errBox.style.display = 'none';

    const res = await fetch('/api/orders/submit-utr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: currentOrder.order_id,
        orderToken: currentOrder.order_token,
        transactionRef: cleanUtr,
        userMobile: cleanMobile
      })
    });
    const data = await res.json();

    if (!data.success) {
      const errorText = data.error || 'सबमिशन विफल (Submission failed)';
      if (errBox) {
        errBox.innerHTML = `⚠️ ${escapeHtml(errorText)}`;
        errBox.style.display = 'block';
        errBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        alert('त्रुटि: ' + errorText);
      }
      if (utrInputEl) {
        utrInputEl.style.borderColor = '#ef4444';
        utrInputEl.focus();
      }
      submitBtn.disabled = false;
      submitBtn.textContent = '✅ भुगतान सबमिट करें (Submit Payment & Unlock)';
      return;
    }

    if (errBox) errBox.style.display = 'none';

    // Move to Step 3: Pending / Verification status
    showOrderStatusScreen(data.order);
    startStatusPolling(data.order.order_id, data.order.order_token);

  } catch (err) {
    console.error('Error submitting UTR:', err);
    if (errBox) {
      errBox.innerHTML = '⚠️ सबमिट करने में त्रुटि। कृपया पुनः प्रयास करें।';
      errBox.style.display = 'block';
    } else {
      alert('सबमिट करने में त्रुटि।');
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '✅ भुगतान सबमिट करें (Submit Payment & Unlock)';
  }
}

// Show Order Status / Verification Screen
function showOrderStatusScreen(order) {
  document.getElementById('paymentStepMain').style.display = 'none';
  document.getElementById('paymentStep3').style.display = 'block';

  document.getElementById('statusOrderId').textContent = order.order_id;
  document.getElementById('statusUtrRef').textContent = order.transaction_ref || '--';
}

// Poll order status
function startStatusPolling(orderId, orderToken) {
  if (pollInterval) clearInterval(pollInterval);

  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/orders/status?orderId=${encodeURIComponent(orderId)}&orderToken=${encodeURIComponent(orderToken)}`);
      const data = await res.json();

      if (data.success && data.order) {
        if (data.order.status === 'verified') {
          clearInterval(pollInterval);
          closeModal('paymentModal');
          displayUnlockedCertificate(data.order);
        } else if (data.order.status === 'rejected') {
          clearInterval(pollInterval);
          document.getElementById('verificationStatusMsg').innerHTML = `
            <div style="color: #dc2626; font-weight: 700; padding: 1rem; background: #fef2f2; border-radius: 8px; border: 1px solid #f87171;">
              ❌ यूटीआर मिलान नहीं हुआ / भुगतान अस्वीकृत कर दिया गया है।<br>
              <small style="color: #64748b;">कृपया सही यूटीआर नंबर के साथ पुनः प्रयास करें या सहायता केंद्र से संपर्क करें।</small>
            </div>
          `;
        }
      }
    } catch (err) {
      console.error('Polling error:', err);
    }
  }, 4000);
}

// Display Unlocked Certificate
function displayUnlockedCertificate(orderData) {
  const modal = document.getElementById('certificateModal');
  const prop = orderData.property_details || {};

  document.getElementById('certOwnerName').textContent = orderData.owner_name || prop.owner_name;
  document.getElementById('certFatherName').textContent = orderData.father_name || prop.father_name || '--';
  document.getElementById('certVillage').textContent = `${orderData.village_name || prop.village_name} (कोड: ${prop.village_code || '--'})`;
  document.getElementById('certDistrict').textContent = orderData.district_name || prop.district_name;
  document.getElementById('certTehsil').textContent = prop.tehsil || '--';
  document.getElementById('certPropertyId').textContent = prop.property_card_id || orderData.property_card_id;
  document.getElementById('certTotalArea').textContent = `${prop.total_area || 0} वर्ग मीटर`;
  document.getElementById('certBuiltArea').textContent = `${prop.built_area || 0} वर्ग मीटर`;
  document.getElementById('certOpenArea').textContent = `${prop.open_area || 0} वर्ग मीटर`;
  document.getElementById('certOrderId').textContent = orderData.order_id;
  document.getElementById('certUtr').textContent = orderData.transaction_ref || '--';

  modal.classList.add('active');
}

// Clean Full-Page Certificate Print Trigger
function printCertificateDocument() {
  window.print();
}

// Track Existing Order Dialog
function openTrackModal() {
  const modal = document.getElementById('trackModal');
  const savedOrderId = localStorage.getItem('active_order_id') || '';
  const savedMobile = localStorage.getItem('user_saved_mobile') || '';

  if (savedOrderId && document.getElementById('trackOrderIdInput')) {
    document.getElementById('trackOrderIdInput').value = savedOrderId;
  }
  if (savedMobile && document.getElementById('trackMobileInput')) {
    document.getElementById('trackMobileInput').value = savedMobile;
  }

  const resultBox = document.getElementById('trackResultBox');
  if (resultBox) resultBox.innerHTML = '';
  modal.classList.add('active');
}

async function searchTrackOrder() {
  const mobile = document.getElementById('trackMobileInput')?.value.trim() || '';
  const utr = document.getElementById('trackUtrInput')?.value.trim() || '';
  const orderId = document.getElementById('trackOrderIdInput')?.value.trim() || '';
  const resultBox = document.getElementById('trackResultBox');

  if (!mobile && !utr && !orderId) {
    alert('कृपया खोजने के लिए मोबाइल नंबर, UTR नंबर अथवा ऑर्डर आईडी दर्ज करें।');
    return;
  }

  resultBox.innerHTML = '<div style="text-align: center; color: #2563eb; padding: 1rem;">🔍 ऑर्डर खोजा जा रहा है... कृपया प्रतीक्षा करें...</div>';

  try {
    const token = localStorage.getItem('active_order_token') || '';
    const params = new URLSearchParams();
    if (orderId) params.append('orderId', orderId);
    if (token) params.append('orderToken', token);
    if (mobile) params.append('mobile', mobile);
    if (utr) params.append('utr', utr);

    const res = await fetch(`/api/orders/track?${params.toString()}`);
    const data = await res.json();

    if (!data.success || !data.order) {
      resultBox.innerHTML = `
        <div style="background: #fef2f2; color: #dc2626; padding: 1rem; border-radius: 8px; border: 1px solid #fecaca; font-size: 0.88rem;">
          ⚠️ <strong>कोई ऑर्डर रिकॉर्ड नहीं मिला!</strong><br>
          कृपया सुनिश्चित करें कि आपका मोबाइल नंबर (उदा. 9876543210) अथवा 12-अंकीय UPI UTR नंबर सही है।
        </div>
      `;
      return;
    }

    const o = data.order;
    window.lastTrackedOrder = o;

    // Save to local storage for quick retrieval
    localStorage.setItem('active_order_id', o.order_id);
    if (o.order_token) localStorage.setItem('active_order_token', o.order_token);
    if (o.user_mobile) localStorage.setItem('user_saved_mobile', o.user_mobile);

    let statusHtml = '';
    if (o.status === 'verified') {
      statusHtml = `
        <div style="background: #f0fdf4; border: 1.5px solid #86efac; padding: 1.25rem; border-radius: 10px;">
          <div style="color: #15803d; font-weight: 800; font-size: 1rem; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.4rem;">
            ✅ भुगतान सत्यापित (Verified) - प्रमाण पत्र तैयार है!
          </div>

          <div style="background: #ffffff; border: 1px solid #bbf7d0; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.85rem;">
            <div style="font-size: 0.78rem; color: #64748b; font-weight: 600;">आपकी ऑर्डर आईडी (Order ID):</div>
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-top: 0.2rem;">
              <code style="font-size: 1.05rem; font-weight: 800; color: #1e3a8a; font-family: monospace;">${escapeHtml(o.order_id)}</code>
              <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${escapeHtml(o.order_id)}'); alert('ऑर्डर आईडी कॉपी हो गई: ${escapeHtml(o.order_id)}');" style="font-size: 0.75rem; padding: 0.25rem 0.6rem;">
                📋 कॉपी करें
              </button>
            </div>
          </div>

          <div style="font-size: 0.85rem; color: #334155; line-height: 1.5; margin-bottom: 1rem;">
            <div><strong>नागरिक का नाम:</strong> ${escapeHtml(o.owner_name)} ${o.father_name ? `(पिता: ${escapeHtml(o.father_name)})` : ''}</div>
            <div><strong>ग्राम व जनपद:</strong> ${escapeHtml(o.village_name || '--')} (${escapeHtml(o.district_name || '--')})</div>
            <div><strong>पंजीकृत मोबाइल:</strong> ${escapeHtml(o.user_mobile || '--')}</div>
            <div><strong>UTR / संदर्भ:</strong> <code style="font-family: monospace; color: #047857;">${escapeHtml(o.transaction_ref || '--')}</code></div>
          </div>

          <button class="btn btn-emerald" style="width: 100%; font-weight: 800; padding: 0.75rem;" onclick="closeModal('trackModal'); displayUnlockedCertificate(window.lastTrackedOrder);">
            📄 संपत्ति कार्ड एवं आईडी देखें (View Property Card)
          </button>
        </div>
      `;
    } else if (o.status === 'rejected') {
      statusHtml = `
        <div style="background: #fef2f2; border: 1.5px solid #fecaca; padding: 1.25rem; border-radius: 10px;">
          <div style="color: #b91c1c; font-weight: 800; font-size: 1rem; margin-bottom: 0.5rem;">
            ✕ भुगतान सत्यापन अस्वीकृत (Rejected)
          </div>
          <p style="font-size: 0.84rem; color: #7f1d1d; margin-bottom: 0.75rem;">
            ऑर्डर आईडी: <strong>${escapeHtml(o.order_id)}</strong><br>
            दर्ज UTR: <code>${escapeHtml(o.transaction_ref || '--')}</code>
          </p>
          <small style="color: #64748b;">कृपया सही UTR नंबर के साथ पुनः प्रयास करें अथवा हेल्पडेस्क से संपर्क करें।</small>
        </div>
      `;
    } else {
          const orderFee = Number(o.amount || activeSettings.price || 80);
          const feeFormatted = '₹' + (orderFee % 1 === 0 ? orderFee.toFixed(0) : orderFee.toFixed(2));

          statusHtml = `
            <div style="background: #fffbeb; border: 1.5px solid #fde68a; padding: 1.25rem; border-radius: 10px;">
              <div style="color: #b45309; font-weight: 800; font-size: 1rem; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.4rem;">
                ⏳ ऑर्डर स्थिति: प्रशासक सत्यापन की प्रतीक्षा में (Pending Verification)
              </div>

              <div style="background: #ffffff; border: 1px solid #fef08a; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.85rem;">
                <div style="font-size: 0.78rem; color: #64748b; font-weight: 600;">आपकी ऑर्डर आईडी (Order ID):</div>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-top: 0.2rem;">
                  <code style="font-size: 1.05rem; font-weight: 800; color: #1e3a8a; font-family: monospace;">${escapeHtml(o.order_id)}</code>
                  <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${escapeHtml(o.order_id)}'); alert('ऑर्डर आईडी कॉपी हो गई: ${escapeHtml(o.order_id)}');" style="font-size: 0.75rem; padding: 0.25rem 0.6rem;">
                    📋 कॉपी करें
                  </button>
                </div>
              </div>

              <div style="font-size: 0.84rem; color: #451a03; line-height: 1.5;">
                <div><strong>नागरिक:</strong> ${escapeHtml(o.owner_name)} (${escapeHtml(o.village_name)})</div>
                <div><strong>मोबाइल:</strong> ${escapeHtml(o.user_mobile || '--')}</div>
                <div><strong>शुल्क:</strong> <strong>${feeFormatted}</strong></div>
                <div><strong>जमा UTR:</strong> <code style="font-family: monospace; font-weight: 700;">${escapeHtml(o.transaction_ref || 'जमा नहीं हुआ')}</code></div>
              </div>

              <div style="background: #fef3c7; border: 1px solid #fde68a; border-radius: 6px; padding: 0.55rem 0.75rem; margin-top: 0.75rem; font-size: 0.8rem; color: #92400e;">
                ⏱️ <strong>अनुमानित सत्यापन समय:</strong> अधिकतम 6 घंटे। प्रशासक टीम द्वारा मिलान होने के बाद (6 घंटे बाद) आप यहाँ पुनः अपनी संपत्ति आईडी देख व डाउनलोड कर सकेंगे।
              </div>
            </div>
          `;
        }

        resultBox.innerHTML = statusHtml;

      } catch (err) {
        console.error('Error tracking order:', err);
        resultBox.innerHTML = `<div style="color: #dc2626; padding: 1rem; background: #fef2f2; border-radius: 8px;">ट्रैकिंग में त्रुटि आई। कृपया पुनः प्रयास करें।</div>`;
      }
    }

// Missing Village Request Modal Flow
function openMissingDataModal(preselectedState, preselectedDistrict, preselectedVillage, preselectedCode) {
  const modal = document.getElementById('missingDataModal');
  const form = document.getElementById('missingDataForm');
  
  if (preselectedState) {
    form.stateName.value = preselectedState;
  } else if (currentState) {
    form.stateName.value = currentState;
  }

  const reqDist = document.getElementById('reqDistrict');
  if (preselectedDistrict) {
    reqDist.value = preselectedDistrict;
  } else if (currentDistrict) {
    reqDist.value = currentDistrict;
  }

  if (form.villageName) {
    if (preselectedVillage) {
      form.villageName.value = preselectedVillage;
    } else if (currentVillageName) {
      form.villageName.value = currentVillageName;
    }
  }

  if (form.villageCode) {
    if (preselectedCode) {
      form.villageCode.value = preselectedCode;
    } else if (currentVillageCode) {
      form.villageCode.value = currentVillageCode;
    }
  }

  modal.classList.add('active');
}

function validateReqMobileInput(el) {
  if (!el) return;
  const clean = el.value.replace(/\D/g, '').slice(0, 10);
  el.value = clean;
  clearFieldError(el);
  const counter = document.getElementById('reqMobileCounter');
  if (counter) {
    counter.textContent = `${clean.length}/10 अंक`;
    if (clean.length === 10 && /^[6-9]\d{9}$/.test(clean)) {
      counter.style.background = '#dcfce7';
      counter.style.color = '#15803d';
    } else {
      counter.style.background = '#dbeafe';
      counter.style.color = '#1e40af';
    }
  }
}

function clearFieldError(input) {
  if (!input) return;
  input.classList.remove('is-invalid');
  const errDiv = input.parentElement?.querySelector('.invalid-feedback');
  if (errDiv) {
    errDiv.textContent = '';
    errDiv.style.display = 'none';
  }
}

function showFieldError(inputId, errId, message) {
  const input = document.getElementById(inputId);
  const errDiv = document.getElementById(errId);
  if (input) {
    input.classList.add('is-invalid');
  }
  if (errDiv) {
    errDiv.innerHTML = `⚠️ ${message}`;
    errDiv.style.display = 'block';
  }
}

async function submitMissingDataRequest(e) {
  e.preventDefault();
  const form = document.getElementById('missingDataForm');

  // Clear previous errors
  ['reqDistrict', 'reqTehsil', 'reqVillage', 'reqVillageCode', 'reqUserMobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) clearFieldError(el);
  });

  const payload = {
    stateName: form.stateName.value.trim(),
    districtName: (document.getElementById('reqDistrict')?.value || '').trim(),
    tehsilName: (document.getElementById('reqTehsil')?.value || '').trim(),
    villageName: (document.getElementById('reqVillage')?.value || '').trim(),
    villageCode: (document.getElementById('reqVillageCode')?.value || '').trim(),
    userName: (form.userName?.value || '').trim(),
    userMobile: (document.getElementById('reqUserMobile')?.value || '').trim(),
    notes: (form.notes?.value || '').trim()
  };

  let hasError = false;
  let firstInvalidEl = null;

  // 1. District validation (Min 2, Max 50)
  if (!payload.districtName) {
    showFieldError('reqDistrict', 'errDistrict', 'कृपया जनपद / जिला का नाम दर्ज करें (District is required)');
    if (!firstInvalidEl) firstInvalidEl = document.getElementById('reqDistrict');
    hasError = true;
  } else if (payload.districtName.length < 2 || payload.districtName.length > 50) {
    showFieldError('reqDistrict', 'errDistrict', 'जनपद का नाम न्यूनतम 2 और अधिकतम 50 अक्षरों का होना चाहिए (2-50 chars required)');
    if (!firstInvalidEl) firstInvalidEl = document.getElementById('reqDistrict');
    hasError = true;
  }

  // 2. Tehsil validation (Min 2, Max 50)
  if (!payload.tehsilName) {
    showFieldError('reqTehsil', 'errTehsil', 'कृपया तहसील का नाम दर्ज करें (Tehsil is required)');
    if (!firstInvalidEl) firstInvalidEl = document.getElementById('reqTehsil');
    hasError = true;
  } else if (payload.tehsilName.length < 2 || payload.tehsilName.length > 50) {
    showFieldError('reqTehsil', 'errTehsil', 'तहसील का नाम न्यूनतम 2 और अधिकतम 50 अक्षरों का होना चाहिए (2-50 chars required)');
    if (!firstInvalidEl) firstInvalidEl = document.getElementById('reqTehsil');
    hasError = true;
  }

  // 3. Village Name validation (Min 2, Max 60)
  if (!payload.villageName) {
    showFieldError('reqVillage', 'errVillage', 'कृपया ग्राम का नाम दर्ज करें (Village Name is required)');
    if (!firstInvalidEl) firstInvalidEl = document.getElementById('reqVillage');
    hasError = true;
  } else if (payload.villageName.length < 2 || payload.villageName.length > 60) {
    showFieldError('reqVillage', 'errVillage', 'ग्राम का नाम न्यूनतम 2 और अधिकतम 60 अक्षरों का होना चाहिए (2-60 chars required)');
    if (!firstInvalidEl) firstInvalidEl = document.getElementById('reqVillage');
    hasError = true;
  }

  // 4. Village Code validation (Min 4, Max 15)
  if (!payload.villageCode) {
    showFieldError('reqVillageCode', 'errVillageCode', 'कृपया ग्राम कोड दर्ज करें (Village Code is required)');
    if (!firstInvalidEl) firstInvalidEl = document.getElementById('reqVillageCode');
    hasError = true;
  } else if (payload.villageCode.length < 4 || payload.villageCode.length > 15) {
    showFieldError('reqVillageCode', 'errVillageCode', 'ग्राम कोड 4 से 15 अंकों/अक्षरों का होना चाहिए (4-15 chars required)');
    if (!firstInvalidEl) firstInvalidEl = document.getElementById('reqVillageCode');
    hasError = true;
  }

  // 5. Mobile Number validation (Exactly 10 digits starting with 6-9)
  if (!payload.userMobile) {
    showFieldError('reqUserMobile', 'errMobile', 'कृपया मोबाइल नंबर दर्ज करें (Mobile number is required)');
    if (!firstInvalidEl) firstInvalidEl = document.getElementById('reqUserMobile');
    hasError = true;
  } else if (payload.userMobile.length !== 10 || !/^[6-9]\d{9}$/.test(payload.userMobile)) {
    showFieldError('reqUserMobile', 'errMobile', 'कृपया 10 अंकों का मान्य मोबाइल नंबर दर्ज करें (उदा. 9876543210, शुरुआत 6-9)');
    if (!firstInvalidEl) firstInvalidEl = document.getElementById('reqUserMobile');
    hasError = true;
  }

  if (hasError) {
    if (firstInvalidEl) firstInvalidEl.focus();
    return;
  }

  try {
    const res = await fetch('/api/data-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      alert('✅ अनुरोध सफलतापूर्वक दर्ज हो गया!\n\nधन्यवाद! आपके ग्राम का विवरण प्राप्त हो गया है। हमारी तकनीकी टीम अधिकतम 6 घंटे के भीतर डेटा की जांच व अपलोड करेगी।\n\n⏱️ कृपया 6 घंटे बाद पोर्टल पर आकर अपने ग्राम की जांच करें।');
      form.reset();
      closeModal('missingDataModal');
    } else {
      alert('त्रुटि: ' + data.error);
    }
  } catch (err) {
    console.error('Error submitting data request:', err);
    alert('अनुरोध सबमिट करने में विफल।');
  }
}

// Modal helper
function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
  if (id === 'paymentModal' && pollInterval) {
    clearInterval(pollInterval);
  }
}

// Setup Event Listeners
function setupEventListeners() {
  document.getElementById('stateSelect').addEventListener('change', onStateChange);
  document.getElementById('districtSelect').addEventListener('change', onDistrictChange);
  document.getElementById('villageSelect').addEventListener('change', onVillageChange);

  // Villager search debounce & clear button
  let searchTimeout = null;
  const searchInput = document.getElementById('villagerSearchInput');
  const clearBtn = document.getElementById('clearVillagerSearchBtn');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (clearBtn) {
        clearBtn.style.display = searchInput.value ? 'block' : 'none';
      }
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        currentPage = 1;
        loadVillagers();
      }, 250);
    });
  }

  // Pagination buttons
  document.getElementById('prevPageBtn').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadVillagers();
    }
  });

  document.getElementById('nextPageBtn').addEventListener('click', () => {
    currentPage++;
    loadVillagers();
  });
}

function clearVillagerSearch() {
  const input = document.getElementById('villagerSearchInput');
  const clearBtn = document.getElementById('clearVillagerSearchBtn');
  if (input) {
    input.value = '';
    input.focus();
  }
  if (clearBtn) clearBtn.style.display = 'none';
  currentPage = 1;
  loadVillagers();
}

function checkSavedOrder() {
  const savedId = localStorage.getItem('active_order_id');
  const savedToken = localStorage.getItem('active_order_token');
  if (savedId && savedToken) {
    // Check in background if active order became verified
    fetch(`/api/orders/status?orderId=${encodeURIComponent(savedId)}&orderToken=${encodeURIComponent(savedToken)}`)
      .then(res => res.json())
      .then(data => {
        if (data.success && data.order && data.order.status === 'verified') {
          console.log('Saved order is verified!');
        }
      })
      .catch(() => {});
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ==========================================================================
// AVAILABLE COVERAGE DIRECTORY (States, Districts & Villages with Codes)
// ==========================================================================
let allCoverageList = [];
let activeCoverageDistrict = 'ALL';

async function loadAvailableCoverage() {
  try {
    const res = await fetch(`/api/coverage?_t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.success) {
      allCoverageList = data.coverage || [];
      
      // Update KPIs & Hero stats
      const totalStates = data.totalStates || 1;
      const totalDistricts = data.totalDistricts || 0;
      const totalVillages = data.totalVillages || 0;
      const totalProps = data.totalProperties || 0;

      const elState = document.getElementById('covTotalStates');
      const elDist = document.getElementById('covTotalDistricts');
      const elVill = document.getElementById('covTotalVillages');
      const elProp = document.getElementById('covTotalProperties');

      if (elState) elState.textContent = totalStates;
      if (elDist) elDist.textContent = totalDistricts;
      if (elVill) elVill.textContent = totalVillages;
      if (elProp) elProp.textContent = `${totalProps.toLocaleString('en-IN')}+`;

      const heroState = document.getElementById('heroStatesCount');
      const heroVill = document.getElementById('heroVillagesCount');
      const heroDist = document.getElementById('heroDistrictsCount');
      const heroRec = document.getElementById('heroRecordsCount');
      if (heroState) heroState.textContent = totalStates;
      if (heroVill) heroVill.textContent = totalVillages;
      if (heroDist) heroDist.textContent = totalDistricts;
      if (heroRec) heroRec.textContent = `${totalProps.toLocaleString('en-IN')}+`;

      const chipAll = document.getElementById('chipCountAll');
      if (chipAll) chipAll.textContent = totalVillages;

      // Populate District Filter Chips
      renderDistrictFilterChips();

      // Render the Grid
      renderCoverageGrid();
    }
  } catch (err) {
    console.error('Failed to load available coverage:', err);
    const container = document.getElementById('coverageGridContainer');
    if (container) {
      container.innerHTML = `<div style="text-align: center; padding: 2rem; color: #ef4444; grid-column: 1 / -1;">
        डेटा लोड करने में त्रुटि। कृपया पुनः प्रयास करें।
      </div>`;
    }
  }
}

let openedCoverageDistricts = new Set();

function toggleDistrictCoverage(districtName) {
  if (openedCoverageDistricts.has(districtName)) {
    openedCoverageDistricts.delete(districtName);
  } else {
    openedCoverageDistricts.add(districtName);
  }
  renderCoverageGrid();
}

function renderDistrictFilterChips() {
  const row = document.getElementById('districtFilterRow');
  if (!row) return;

  // Calculate village counts per district
  const distCounts = {};
  allCoverageList.forEach(v => {
    distCounts[v.district] = (distCounts[v.district] || 0) + 1;
  });

  const sortedDistricts = Object.keys(distCounts).sort();

  // Keep the "ALL" button, remove any previous dynamic chips
  row.querySelectorAll('.district-chip:not(:first-child)').forEach(el => el.remove());

  sortedDistricts.forEach(dist => {
    const btn = document.createElement('button');
    btn.className = `district-chip ${activeCoverageDistrict === dist ? 'active' : ''}`;
    btn.onclick = () => filterByDistrictChip(dist, btn);
    btn.innerHTML = `${dist} <span class="badge">${distCounts[dist]}</span>`;
    row.appendChild(btn);
  });
}

function filterByDistrictChip(districtName, btnElement) {
  activeCoverageDistrict = districtName;
  const row = document.getElementById('districtFilterRow');
  if (row) {
    row.querySelectorAll('.district-chip').forEach(el => el.classList.remove('active'));
  }
  if (btnElement) {
    btnElement.classList.add('active');
  }
  if (districtName !== 'ALL') {
    openedCoverageDistricts.add(districtName);
  }
  renderCoverageGrid();
}

function filterCoverageList() {
  renderCoverageGrid();
}

let districtPageMap = {};
const VILLAGES_PER_PAGE = 5;

function setDistrictPage(distName, page, event) {
  if (event) event.stopPropagation();
  districtPageMap[distName] = page;
  renderCoverageGrid();
}

function renderCoverageGrid() {
  const container = document.getElementById('coverageGridContainer');
  if (!container) return;

  const searchInput = document.getElementById('coverageSearchInput');
  const query = (searchInput?.value || '').trim().toLowerCase();

  // Group all coverage villages by district
  const districtMap = {};
  allCoverageList.forEach(v => {
    const dName = v.district || 'Uttar Pradesh';
    if (!districtMap[dName]) {
      districtMap[dName] = [];
    }
    districtMap[dName].push(v);
  });

  let districtKeys = Object.keys(districtMap).sort();

  // Filter by active district chip
  if (activeCoverageDistrict !== 'ALL') {
    districtKeys = districtKeys.filter(d => d.toLowerCase() === activeCoverageDistrict.toLowerCase());
  }

  // Filter by search query (Search by District Name, Village Name, or Code)
  if (query) {
    districtKeys = districtKeys.filter(d => {
      const matchDistrictName = d.toLowerCase().includes(query);
      const matchingVillages = districtMap[d].filter(v => {
        const matchName = (v.village_name || '').toLowerCase().includes(query);
        const matchCode = String(v.village_code || '').includes(query);
        const matchTehsil = (v.tehsil || '').toLowerCase().includes(query);
        return matchName || matchCode || matchTehsil;
      });
      
      // If villages match inside this district, auto-open this district
      if (matchingVillages.length > 0) {
        openedCoverageDistricts.add(d);
        districtPageMap[d] = 1;
      }
      return matchDistrictName || matchingVillages.length > 0;
    });
  }

  if (districtKeys.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem 1rem; background: #f8fafc; border: 1.5px dashed #cbd5e1; border-radius: 10px;">
        <div style="font-size: 1.5rem; margin-bottom: 0.35rem;">🔍</div>
        <div style="font-weight: 700; color: #334155; font-size: 0.95rem;">कोई जनपद या ग्राम मेल नहीं खाता (No District / Village Found)</div>
        <p style="color: #64748b; font-size: 0.8rem; max-width: 400px; margin: 0.25rem auto 0.75rem;">
          यदि आपका जनपद या ग्राम सूची में नहीं है, तो कृपया डेटा अनुरोध दर्ज करें।
        </p>
        <button class="btn btn-primary btn-sm" onclick="openMissingDataModal(currentState, '${activeCoverageDistrict !== 'ALL' ? activeCoverageDistrict : ''}')">
          ➕ ग्राम डेटा का अनुरोध करें (Request Data)
        </button>
      </div>
    `;
    return;
  }

  // Render District-First Accordion List with Pagination
  const html = `
    <div class="district-accordion-list">
      ${districtKeys.map(distName => {
        let villages = districtMap[distName] || [];
        
        // If there's an active query, filter the visible villages inside the opened district
        if (query) {
          const filteredInside = villages.filter(v => {
            const matchDist = distName.toLowerCase().includes(query);
            const matchName = (v.village_name || '').toLowerCase().includes(query);
            const matchCode = String(v.village_code || '').includes(query);
            const matchTehsil = (v.tehsil || '').toLowerCase().includes(query);
            return matchDist || matchName || matchCode || matchTehsil;
          });
          if (filteredInside.length > 0) {
            villages = filteredInside;
          }
        }

        const totalVillages = villages.length;
        const totalPages = Math.ceil(totalVillages / VILLAGES_PER_PAGE);
        const currentPage = Math.min(Math.max(districtPageMap[distName] || 1, 1), totalPages || 1);
        const startIndex = (currentPage - 1) * VILLAGES_PER_PAGE;
        const endIndex = Math.min(startIndex + VILLAGES_PER_PAGE, totalVillages);
        const pagedVillages = villages.slice(startIndex, endIndex);

        const isOpen = openedCoverageDistricts.has(distName);
        const stateName = villages[0]?.state || 'Uttar Pradesh';

        return `
          <div class="district-accordion-item ${isOpen ? 'is-open' : ''}">
            <div class="district-accordion-header" onclick="toggleDistrictCoverage('${distName}')">
              <div class="district-info">
                <span class="district-icon">🏢</span>
                <span class="district-name">जनपद: <strong>${distName}</strong> (${stateName})</span>
                <span class="district-badge">🏡 ${totalVillages} ग्राम उपलब्ध</span>
              </div>
              <div class="district-header-actions">
                <button type="button" class="district-expand-btn">
                  <span>${isOpen ? 'ग्राम छिपाएं (Hide)' : 'ग्राम सूची देखें (View Villages)'}</span>
                  <span class="expand-chevron">▼</span>
                </button>
              </div>
            </div>

            ${isOpen ? `
              <div class="district-accordion-body">
                <table class="coverage-compact-table">
                  <thead>
                    <tr>
                      <th style="width: 45px;">#</th>
                      <th>ग्राम का नाम (Village Name)</th>
                      <th style="width: 150px;">ग्राम कोड (LGD Code)</th>
                      <th style="width: 120px; text-align: center;">कार्रवाई</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${pagedVillages.map((v, idx) => {
                      const safeName = v.village_name || 'अज्ञात ग्राम';
                      const safeCode = String(v.village_code || '');

                      return `
                        <tr>
                          <td style="color: #94a3b8; font-weight: 600; font-size: 0.8rem;">#${startIndex + idx + 1}</td>
                          <td>
                            <div class="village-name-cell">
                              <span>🏡</span>
                              <span>${safeName}</span>
                            </div>
                          </td>
                          <td>
                            <span class="village-code-pill" title="क्लिक करके कोड कॉपी करें" onclick="copyVillageCode('${safeCode}', this)">
                              #${safeCode} 📋
                            </span>
                          </td>
                          <td style="text-align: center;">
                            <button 
                              type="button" 
                              class="village-select-btn" 
                              onclick="selectVillageFromDirectory('${stateName}', '${distName}', '${safeCode}', '${safeName.replace(/'/g, "\\'")}')"
                              title="यह ग्राम चुनें और रिकॉर्ड्स खोजें"
                            >
                              चुनें ➔
                            </button>
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>

                ${totalPages > 1 ? `
                  <div class="district-pagination-bar" onclick="event.stopPropagation()">
                    <div>
                      प्रदर्शित: <strong>${startIndex + 1} - ${endIndex}</strong> / कुल <strong>${totalVillages}</strong> ग्राम (पेज ${currentPage}/${totalPages})
                    </div>
                    <div class="district-pagination-controls">
                      <button 
                        type="button" 
                        class="dist-page-btn" 
                        onclick="setDistrictPage('${distName}', ${currentPage - 1}, event)" 
                        ${currentPage <= 1 ? 'disabled' : ''}
                        title="पिछला पेज"
                      >
                        ◀
                      </button>

                      ${Array.from({ length: totalPages }, (_, pIdx) => {
                        const pageNum = pIdx + 1;
                        return `
                          <button 
                            type="button" 
                            class="dist-page-btn ${currentPage === pageNum ? 'active' : ''}" 
                            onclick="setDistrictPage('${distName}', ${pageNum}, event)"
                          >
                            ${pageNum}
                          </button>
                        `;
                      }).join('')}

                      <button 
                        type="button" 
                        class="dist-page-btn" 
                        onclick="setDistrictPage('${distName}', ${currentPage + 1}, event)" 
                        ${currentPage >= totalPages ? 'disabled' : ''}
                        title="अगला पेज"
                      >
                        ▶
                      </button>
                    </div>
                  </div>
                ` : ''}
              </div>
            ` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;

  container.innerHTML = html;
}

// Direct Quick Search in Step 1 (Village Code or Name)
let quickSearchTimeout = null;
function handleQuickVillageSearch(query) {
  clearTimeout(quickSearchTimeout);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return;

  quickSearchTimeout = setTimeout(() => {
    // 1. Check exact code match first
    const exactCode = allCoverageList.find(v => String(v.village_code) === q);
    if (exactCode) {
      selectVillageFromDirectory(exactCode.state || 'Uttar Pradesh', exactCode.district, exactCode.village_code, exactCode.village_name || '');
      return;
    }

    // 2. Check code prefix or name match
    const match = allCoverageList.find(v => 
      String(v.village_code).startsWith(q) || 
      (v.village_name && v.village_name.toLowerCase().includes(q))
    );

    if (match) {
      selectVillageFromDirectory(match.state || 'Uttar Pradesh', match.district, match.village_code, match.village_name || '');
    }
  }, 400);
}

// 1-Click Auto Select & Search from Directory
async function selectVillageFromDirectory(state, district, villageCode, villageName = '') {
  // 1. Set State
  const stateSelect = document.getElementById('stateSelect');
  if (stateSelect && state && stateSelect.value !== state) {
    stateSelect.value = state;
    await onStateChange();
  }

  // 2. Set District
  const districtSelect = document.getElementById('districtSelect');
  if (districtSelect && district) {
    districtSelect.value = district;
    currentDistrict = district;
    await onDistrictChange();
  }

  // 3. Set Village
  const cleanCode = String(villageCode || '').trim();
  const villageSelect = document.getElementById('villageSelect');
  if (villageSelect && cleanCode) {
    villageSelect.disabled = false;
    currentVillageCode = cleanCode;
    currentVillageName = villageName || '';
    let foundOpt = Array.from(villageSelect.options).find(o => String(o.value).trim() === cleanCode);
    if (!foundOpt) {
      foundOpt = document.createElement('option');
      foundOpt.value = cleanCode;
      foundOpt.dataset.villageName = villageName || cleanCode;
      foundOpt.textContent = `${villageName || cleanCode} (कोड: ${cleanCode})`;
      villageSelect.appendChild(foundOpt);
    } else if (villageName) {
      foundOpt.dataset.villageName = villageName;
    }
    villageSelect.value = cleanCode;
    await onVillageChange();
  }

  // 4. Smoothly scroll to Step 2 records section
  const target = document.getElementById('villagersSection') || document.getElementById('stepLocationCard') || document.getElementById('stateSelect');
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Auto-sync coverage directory and statistics when returning to tab/window
window.addEventListener('focus', () => {
  if (typeof loadAvailableCoverage === 'function') {
    loadAvailableCoverage();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && typeof loadAvailableCoverage === 'function') {
    loadAvailableCoverage();
  }
});

function scrollToCoverageDirectory() {
  const section = document.getElementById('availableCoverageSection');
  if (section) {
    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const input = document.getElementById('coverageSearchInput');
    if (input) {
      setTimeout(() => input.focus(), 600);
    }
  }
}

function copyVillageCode(code, el) {
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    const originalText = el.innerHTML;
    el.innerHTML = `✓ कॉपी हुआ!`;
    el.style.background = '#dcfce7';
    el.style.color = '#166534';
    setTimeout(() => {
      el.innerHTML = originalText;
      el.style.background = '';
      el.style.color = '';
    }, 1500);
  }).catch(() => {
    // Fallback prompt
    prompt('ग्राम कोड कॉपी करें:', code);
  });
}

function copyPropertyIdForDigilocker() {
  const propIdEl = document.getElementById('certPropertyId');
  const propId = propIdEl ? propIdEl.textContent.trim() : '';
  if (!propId || propId.includes('---')) {
    alert('संपत्ति आईडी अभी उपलब्ध नहीं है।');
    return;
  }
  navigator.clipboard.writeText(propId).then(() => {
    alert(`✓ संपत्ति आईडी कॉपी हो गई: ${propId}\n\nअब DigiLocker खोलकर Search Documents में 'Property Card' चुनकर इसे पेस्ट करें।`);
  }).catch(() => {
    prompt('DigiLocker के लिए Property ID कॉपी करें:', propId);
  });
}

