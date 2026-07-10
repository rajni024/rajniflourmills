// --- Firebase Configuration ---
const firebaseConfig = {
  apiKey: "AIzaSyAzdeL-B6WvSaus5uj_q2_JOcwavTjrbBI",
  authDomain: "milllmr.firebaseapp.com",
  projectId: "milllmr",
  storageBucket: "milllmr.firebasestorage.app",
  messagingSenderId: "416846041177",
  appId: "1:416846041177:web:bcbddcd5d70b716df66148",
  measurementId: "G-1MJ8BYX6MG"
};

// --- Firebase SDK Globals (Loaded dynamically) ---
let initializeApp = null;
let getFirestore = null;
let doc = null;
let setDoc = null;
let getDocs = null;
let collection = null;

// --- Application State ---
let db = null;
let isFirebaseConnected = false;
let orders = [];
let activeView = 'dashboard';
let activeCategory = null; // Currently expanded material category in Under Process view

// --- Dom Elements ---
const views = {
  dashboard: document.getElementById('dashboardView'),
  newEntry: document.getElementById('newEntryView'),
  underProcess: document.getElementById('underProcessView'),
  completed: document.getElementById('completedView'),
  reports: document.getElementById('reportsView'),
  dataSync: document.getElementById('dataSyncView')
};

// --- Initialize App ---
window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initClock();
  loadLocalData();
  lucide.createIcons();
  
  // Try to initialize Firebase dynamically
  try {
    // Dynamic import to prevent crash when loading completely offline
    const firebaseAppModule = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js");
    const firestoreModule = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
    
    initializeApp = firebaseAppModule.initializeApp;
    getFirestore = firestoreModule.getFirestore;
    doc = firestoreModule.doc;
    setDoc = firestoreModule.setDoc;
    getDocs = firestoreModule.getDocs;
    collection = firestoreModule.collection;

    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    updateSyncStatus('connected', 'Cloud Sync Active');
    isFirebaseConnected = true;
    
    // Initial fetch to sync up
    await syncWithFirestore();
  } catch (error) {
    console.warn("Firebase SDK failed to load or device is offline. Operating in local-only mode.", error);
    updateSyncStatus('offline', 'Local Mode (Offline)');
    isFirebaseConnected = false;
  }
  
  // Auto fill date/time and queue number in entry form
  resetNewEntryForm();
  
  // Initial render
  renderAll();
});

// --- Theme Management ---
function initTheme() {
  const savedTheme = localStorage.getItem('rfm_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);

  document.getElementById('themeToggle').addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('rfm_theme', newTheme);
    updateThemeIcon(newTheme);
    showToast(`Switched to ${newTheme} theme`, 'info');
  });
}

function updateThemeIcon(theme) {
  const btn = document.getElementById('themeToggle');
  if (theme === 'dark') {
    btn.innerHTML = '<i data-lucide="sun"></i>';
  } else {
    btn.innerHTML = '<i data-lucide="moon"></i>';
  }
  lucide.createIcons();
}

// --- Live Clock ---
function initClock() {
  const clockEl = document.getElementById('liveTime');
  setInterval(() => {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('en-US', { hour12: false });
  }, 1000);
}

// --- Local Storage Management ---
function loadLocalData() {
  const savedOrders = localStorage.getItem('rfm_orders');
  if (savedOrders) {
    orders = JSON.parse(savedOrders);
  } else {
    orders = [];
  }
}

function saveLocalData() {
  localStorage.setItem('rfm_orders', JSON.stringify(orders));
}

// --- Sync Service with Firebase Firestore ---
async function syncWithFirestore() {
  if (!db) return;
  
  try {
    updateSyncStatus('syncing', 'Syncing Data...');
    
    // 1. Fetch all records from Firestore to merge
    const querySnapshot = await getDocs(collection(db, "GrindingRecords"));
    const firestoreRecords = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      firestoreRecords.push({ docId: doc.id, ...data });
    });
    
    // 2. Merge logic (using local ID or unique queueNumber_date combo)
    // We will build a unified list, prioritising latest updatedAt if available
    let hasChanges = false;
    
    firestoreRecords.forEach(fr => {
      // Find matching local order by id or legacy key (queueNumber + "_" + dateTime.slice(0,10))
      const legacyId = fr.queueNumber + "_" + (fr.dateTime ? fr.dateTime.slice(0, 10) : "");
      
      const localIndex = orders.findIndex(lo => lo.id === fr.id || lo.id === legacyId || (lo.queueNumber === fr.queueNumber && lo.dateTime.slice(0, 10) === fr.dateTime.slice(0, 10)));
      
      if (localIndex === -1) {
        // Not in local storage, add it
        const normalized = normalizeFirestoreRecord(fr);
        orders.push(normalized);
        hasChanges = true;
      } else {
        // Compare modification time or fields to update if remote has more detail
        const local = orders[localIndex];
        
        // Remote completed/paid should override local under_process
        if (fr.status && fr.status !== local.status) {
          orders[localIndex] = normalizeFirestoreRecord(fr);
          hasChanges = true;
        } else if (!local.finalWeight && fr.weight && fr.weight !== local.initialWeight) {
          // If remote weight is different, sync
          local.initialWeight = fr.weight;
          hasChanges = true;
        }
      }
    });

    // 3. Upload local orders that are marked 'pending' or not in Firestore
    for (let order of orders) {
      if (order.syncStatus !== 'synced') {
        await uploadRecordToFirestore(order);
      }
    }
    
    if (hasChanges) {
      saveLocalData();
      renderAll();
    }
    
    updateSyncStatus('connected', 'Cloud Sync Active');
    isFirebaseConnected = true;
  } catch (error) {
    console.error("Sync failed:", error);
    updateSyncStatus('offline', 'Sync Error (Offline)');
    isFirebaseConnected = false;
  }
}

// Helper to standardise older/firestore schemas
function normalizeFirestoreRecord(fr) {
  // Convert standard Firestore document to our app format
  return {
    id: fr.id || fr.docId || `${fr.queueNumber}_${fr.dateTime.slice(0,10)}`,
    queueNumber: parseInt(fr.queueNumber),
    dateTime: fr.dateTime || new Date().toISOString(),
    deliveryDate: fr.deliveryDate || fr.dateTime ? fr.dateTime.slice(0, 10) : new Date().toISOString().slice(0,10),
    customerName: fr.customerName || 'Unknown',
    village: fr.village || '',
    contactNumber: fr.contactNumber || '',
    material: fr.material || 'Kanak',
    initialWeight: parseFloat(fr.weight || fr.initialWeight || 0),
    finalWeight: parseFloat(fr.finalWeight || 0) || null,
    status: fr.status || (fr.finalWeight ? (fr.paymentAmount ? 'paid' : 'completed_pending_payment') : 'under_process'),
    paymentAmount: parseFloat(fr.paymentAmount || 0) || null,
    paymentMode: fr.paymentMode || null,
    syncStatus: 'synced',
    updatedAt: fr.updatedAt || new Date().getTime()
  };
}

async function uploadRecordToFirestore(order) {
  if (!db) return;
  
  // Document ID matches legacy: queueNumber + "_" + Date(YYYY-MM-DD)
  const docId = order.queueNumber + "_" + order.dateTime.slice(0, 10);
  
  const docRef = doc(db, "GrindingRecords", docId);
  const dataToUpload = {
    id: order.id,
    queueNumber: order.queueNumber.toString(),
    dateTime: order.dateTime,
    deliveryDate: order.deliveryDate,
    customerName: order.customerName,
    village: order.village,
    contactNumber: order.contactNumber,
    material: order.material,
    weight: order.initialWeight, // Keep for legacy compatibility
    initialWeight: order.initialWeight,
    finalWeight: order.finalWeight || 0,
    status: order.status,
    paymentAmount: order.paymentAmount || 0,
    paymentMode: order.paymentMode || "",
    updatedAt: order.updatedAt
  };

  try {
    await setDoc(docRef, dataToUpload);
    order.syncStatus = 'synced';
  } catch (err) {
    console.error("Failed uploading record: ", order.id, err);
    order.syncStatus = 'pending';
    throw err;
  }
}

function updateSyncStatus(status, text) {
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncText');
  
  dot.className = 'indicator-dot';
  
  if (status === 'connected') {
    dot.classList.add('dot-green');
  } else if (status === 'syncing') {
    dot.classList.add('dot-amber');
  } else {
    dot.classList.add('dot-red');
  }
  
  txt.textContent = text;
}

// --- Navigation Controller ---
window.switchView = function(viewName) {
  // Hide active details if moving
  if (viewName !== 'underProcess') {
    closeCategoryDetails();
  }
  
  // Toggle Views
  Object.keys(views).forEach(k => {
    if (k === viewName) {
      views[k].classList.add('active');
    } else {
      views[k].classList.remove('active');
    }
  });
  
  activeView = viewName;
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Rendering Engine ---
function renderAll() {
  updateBadges();
  
  switch (activeView) {
    case 'dashboard':
      // Handled statically, just badge counts updated
      break;
    case 'newEntry':
      // Form fields are static
      break;
    case 'underProcess':
      renderUnderProcess();
      break;
    case 'completed':
      renderCompleted();
      break;
    case 'reports':
      renderReports();
      break;
    case 'dataSync':
      renderDataSync();
      break;
  }
  
  lucide.createIcons();
}

function updateBadges() {
  const pendingCount = orders.filter(o => o.status === 'under_process').length;
  const completedCount = orders.filter(o => o.status === 'completed_pending_payment').length;
  
  const bPending = document.getElementById('badgeUnderProcess');
  const bCompleted = document.getElementById('badgeCompleted');
  
  if (pendingCount > 0) {
    bPending.textContent = pendingCount;
    bPending.style.display = 'block';
  } else {
    bPending.style.display = 'none';
  }
  
  if (completedCount > 0) {
    bCompleted.textContent = completedCount;
    bCompleted.style.display = 'block';
  } else {
    bCompleted.style.display = 'none';
  }
}

// --- 1. New Entry View Controller ---
window.toggleCustomMaterialInput = function() {
  const matSelect = document.getElementById('material');
  const customGroup = document.getElementById('customMaterialGroup');
  const customInput = document.getElementById('customMaterial');
  
  if (matSelect.value === 'Other') {
    customGroup.style.display = 'flex';
    customInput.required = true;
  } else {
    customGroup.style.display = 'none';
    customInput.required = false;
    customInput.value = '';
  }
}

window.resetNewEntryForm = function() {
  const form = document.getElementById('newEntryForm');
  form.reset();
  
  // Set current datetime
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000; // offset in milliseconds
  const localISOTime = (new Date(Date.now() - timezoneOffset)).toISOString().slice(0, 16);
  document.getElementById('dateTime').value = localISOTime;
  
  // Set default delivery date to tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  document.getElementById('deliveryDate').value = tomorrow.toISOString().slice(0, 10);
  
  // Auto-increment queue number
  const activeQueueNumbers = orders.map(o => o.queueNumber).filter(n => !isNaN(n));
  const maxQueue = activeQueueNumbers.length > 0 ? Math.max(...activeQueueNumbers) : 100;
  document.getElementById('queueNumber').value = maxQueue + 1;
  
  toggleCustomMaterialInput();
}

document.getElementById('newEntryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const qn = parseInt(document.getElementById('queueNumber').value);
  const dt = document.getElementById('dateTime').value;
  const cName = document.getElementById('customerName').value.trim();
  const vill = document.getElementById('village').value.trim();
  const cNum = document.getElementById('contactNumber').value.trim();
  const initWeight = parseFloat(document.getElementById('initialWeight').value);
  const delDate = document.getElementById('deliveryDate').value;
  
  let mat = document.getElementById('material').value;
  if (mat === 'Other') {
    mat = document.getElementById('customMaterial').value.trim();
  }
  
  if (!mat) {
    showToast("Please choose a material", "error");
    return;
  }
  
  // Check for duplicate queue number on same date
  const isDuplicate = orders.some(o => o.queueNumber === qn && o.dateTime.slice(0, 10) === dt.slice(0, 10));
  if (isDuplicate) {
    if (!confirm(`Queue Number ${qn} is already in use for today. Do you want to save it anyway?`)) {
      return;
    }
  }

  const newOrder = {
    id: `RFM_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    queueNumber: qn,
    dateTime: dt,
    deliveryDate: delDate,
    customerName: cName,
    village: vill,
    contactNumber: cNum,
    material: mat,
    initialWeight: initWeight,
    finalWeight: null,
    status: 'under_process',
    paymentAmount: null,
    paymentMode: null,
    syncStatus: 'pending',
    updatedAt: Date.now()
  };
  
  orders.push(newOrder);
  saveLocalData();
  showToast("Record Saved locally / ਡਾਟਾ ਸੇਵ ਹੋ ਗਿਆ", "success");
  
  // Reset form
  resetNewEntryForm();
  
  // Background Sync
  if (isFirebaseConnected) {
    try {
      await uploadRecordToFirestore(newOrder);
      saveLocalData();
      showToast("Uploaded to Cloud / ਕਲਾਊਡ ਤੇ ਅਪਲੋਡ ਹੋ ਗਿਆ", "success");
    } catch (err) {
      console.warn("Background upload failed, will sync later", err);
    }
  }
  
  // Redirect to Under Process view
  setTimeout(() => switchView('underProcess'), 500);
});

// --- 2. Under Process View Controller ---
function renderUnderProcess() {
  const container = document.getElementById('categoryGrid');
  container.innerHTML = '';
  
  // Get all orders under process
  const pendingOrders = orders.filter(o => o.status === 'under_process');
  
  if (pendingOrders.length === 0) {
    container.innerHTML = `
      <div class="glass-card" style="grid-column: 1 / -1; text-align: center; padding: 3rem;">
        <span style="font-size: 3rem; display: block; margin-bottom: 1rem;">🎉</span>
        <h3 style="font-weight: 700; margin-bottom: 0.5rem;">No active orders under process</h3>
        <p style="color: var(--text-muted);">All grinding tasks are complete. Enter a new order to start!</p>
      </div>
    `;
    return;
  }
  
  // Group by category
  const categories = {};
  pendingOrders.forEach(o => {
    const key = o.material;
    if (!categories[key]) {
      categories[key] = {
        name: key,
        count: 0,
        totalWeight: 0,
        orders: []
      };
    }
    categories[key].count++;
    categories[key].totalWeight += o.initialWeight;
    categories[key].orders.push(o);
  });
  
  // Render Category Cards
  Object.values(categories).forEach(cat => {
    const card = document.createElement('div');
    card.className = 'category-card';
    if (activeCategory === cat.name) {
      card.style.borderColor = 'var(--primary)';
      card.style.boxShadow = '0 0 16px var(--primary-glow)';
    }
    
    // Map material names for display
    const labelPa = getMaterialPunjabiLabel(cat.name);
    
    card.innerHTML = `
      <div class="category-card-header">
        <span class="category-name">${cat.name} <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-muted);">(${labelPa})</span></span>
        <span class="category-stat">${cat.count} orders</span>
      </div>
      <div class="category-total-weight">${cat.totalWeight.toFixed(2)} kg</div>
      <div class="category-count">Pending grinding</div>
    `;
    
    card.addEventListener('click', () => selectCategory(cat.name));
    container.appendChild(card);
  });
  
  // Render Expanded details if a category is selected
  if (activeCategory && categories[activeCategory]) {
    renderCategoryOrdersList(categories[activeCategory].orders);
  } else {
    document.getElementById('selectedCategorySection').style.display = 'none';
  }
}

function getMaterialPunjabiLabel(material) {
  const mapping = {
    'Kanak': 'ਕਣਕ',
    'Makki': 'ਮੱਕੀ',
    'Chawal': 'ਚਾਵਲ',
    'Bajra': 'ਬਾਜਰਾ',
    'Saro': 'ਸਰੋਂ',
    'Haldi': 'ਹਲਦੀ'
  };
  return mapping[material] || material;
}

window.selectCategory = function(catName) {
  if (activeCategory === catName) {
    activeCategory = null; // Toggle collapse
  } else {
    activeCategory = catName;
  }
  renderAll();
}

window.closeCategoryDetails = function() {
  activeCategory = null;
  document.getElementById('selectedCategorySection').style.display = 'none';
  renderAll();
}

function renderCategoryOrdersList(categoryOrders) {
  const section = document.getElementById('selectedCategorySection');
  const title = document.getElementById('selectedCategoryTitle');
  const list = document.getElementById('underProcessOrdersList');
  
  title.innerHTML = `Grinding List: ${activeCategory} (${getMaterialPunjabiLabel(activeCategory)})`;
  list.innerHTML = '';
  
  // Sort orders by delivery date (earliest first)
  categoryOrders.sort((a,b) => new Date(a.deliveryDate) - new Date(b.deliveryDate));
  
  categoryOrders.forEach(o => {
    const row = document.createElement('div');
    row.className = 'order-row-card';
    
    const isOverdue = new Date(o.deliveryDate) < new Date().setHours(0,0,0,0);
    const dateColor = isOverdue ? 'color: var(--danger);' : '';
    
    row.innerHTML = `
      <div class="order-info">
        <div class="info-item" style="min-width: 60px;">
          <span class="info-label">Queue#</span>
          <span class="info-value" style="color: var(--primary);">#${o.queueNumber}</span>
        </div>
        <div class="info-item" style="min-width: 140px;">
          <span class="info-label">Customer / Customer Contact</span>
          <span class="info-value">${o.customerName}</span>
          <span style="font-size: 0.75rem; color: var(--text-muted);">${o.contactNumber || 'No Contact'}</span>
        </div>
        <div class="info-item" style="min-width: 100px;">
          <span class="info-label">Village / ਪਿੰਡ</span>
          <span class="info-value">${o.village}</span>
        </div>
        <div class="info-item" style="min-width: 90px;">
          <span class="info-label">Weight In</span>
          <span class="info-value">${o.initialWeight.toFixed(2)} kg</span>
        </div>
        <div class="info-item" style="min-width: 120px;">
          <span class="info-label">Delivery Date</span>
          <span class="info-value" style="${dateColor}">${formatDateDisplay(o.deliveryDate)}</span>
        </div>
      </div>
      <div class="order-actions">
        <button class="btn btn-primary" onclick="openWeightModal('${o.id}')"><i data-lucide="check"></i> Done (ਪੂਰਾ ਹੋ ਗਿਆ)</button>
      </div>
    `;
    list.appendChild(row);
  });
  
  section.style.display = 'block';
  lucide.createIcons();
}

function formatDateDisplay(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// --- Weight Entry Modal Controller ---
window.openWeightModal = function(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order) return;
  
  document.getElementById('modalOrderId').value = order.id;
  document.getElementById('modalWeightCustomer').textContent = order.customerName;
  document.getElementById('modalWeightMaterial').textContent = `${order.material} (${getMaterialPunjabiLabel(order.material)})`;
  document.getElementById('modalWeightInitial').textContent = order.initialWeight.toFixed(2);
  
  // Pre-fill final weight with initial weight as reference
  document.getElementById('finalWeight').value = order.initialWeight;
  
  document.getElementById('weightModal').classList.add('open');
}

window.closeWeightModal = function() {
  document.getElementById('weightModal').classList.remove('open');
  document.getElementById('weightModalForm').reset();
}

window.submitFinalWeight = async function() {
  const id = document.getElementById('modalOrderId').value;
  const finalWtInput = document.getElementById('finalWeight');
  const finalWt = parseFloat(finalWtInput.value);
  
  if (!finalWt || isNaN(finalWt) || finalWt <= 0) {
    showToast("Please enter a valid final weight", "error");
    return;
  }
  
  const order = orders.find(o => o.id === id);
  if (!order) return;
  
  order.finalWeight = finalWt;
  order.status = 'completed_pending_payment';
  order.updatedAt = Date.now();
  order.syncStatus = 'pending';
  
  saveLocalData();
  closeWeightModal();
  showToast("Order marked as Completed / ਪਿਸਾਈ ਹੋ ਗਈ", "success");
  
  // Re-render
  renderAll();
  
  // Background Sync
  if (isFirebaseConnected) {
    try {
      await uploadRecordToFirestore(order);
      saveLocalData();
      showToast("Cloud updated / ਕਲਾਊਡ ਤੇ ਅਪਡੇਟ ਹੋ ਗਿਆ", "success");
    } catch (err) {
      console.warn("Background upload failed, will sync later", err);
    }
  }
}

// --- 3. Completed View Controller (Payment Pending) ---
function renderCompleted() {
  const list = document.getElementById('completedOrdersList');
  list.innerHTML = '';
  
  const completedOrders = orders.filter(o => o.status === 'completed_pending_payment');
  
  if (completedOrders.length === 0) {
    list.innerHTML = `
      <div class="glass-card" style="text-align: center; padding: 3rem;">
        <span style="font-size: 3rem; display: block; margin-bottom: 1rem;">🎉</span>
        <h3 style="font-weight: 700; margin-bottom: 0.5rem;">No orders awaiting payment</h3>
        <p style="color: var(--text-muted);">All finished orders are paid and dispatched. Good job!</p>
      </div>
    `;
    return;
  }
  
  // Sort by update date (newest completed first)
  completedOrders.sort((a,b) => b.updatedAt - a.updatedAt);
  
  completedOrders.forEach(o => {
    const row = document.createElement('div');
    row.className = 'order-row-card';
    
    row.innerHTML = `
      <div class="order-info">
        <div class="info-item" style="min-width: 60px;">
          <span class="info-label">Queue#</span>
          <span class="info-value" style="color: var(--primary);">#${o.queueNumber}</span>
        </div>
        <div class="info-item" style="min-width: 140px;">
          <span class="info-label">Customer</span>
          <span class="info-value">${o.customerName}</span>
          <span style="font-size: 0.75rem; color: var(--text-muted);">${o.contactNumber || 'No Contact'}</span>
        </div>
        <div class="info-item" style="min-width: 110px;">
          <span class="info-label">Material</span>
          <span class="info-value">${o.material} (${getMaterialPunjabiLabel(o.material)})</span>
        </div>
        <div class="info-item" style="min-width: 90px;">
          <span class="info-label">In Weight</span>
          <span class="info-value">${o.initialWeight.toFixed(2)} kg</span>
        </div>
        <div class="info-item" style="min-width: 90px;">
          <span class="info-label">Final Weight</span>
          <span class="info-value" style="color: var(--success);">${o.finalWeight ? o.finalWeight.toFixed(2) : '0.00'} kg</span>
        </div>
        <div class="info-item" style="min-width: 110px;">
          <span class="info-label">Grinding Date</span>
          <span class="info-value">${formatDateDisplay(o.dateTime.slice(0,10))}</span>
        </div>
      </div>
      <div class="order-actions">
        <button class="btn btn-primary" onclick="openPaymentModal('${o.id}')">
          <i data-lucide="shopping-cart"></i> Final Out (ਪੇਮੈਂਟ/ਬਾਹਰ)
        </button>
      </div>
    `;
    list.appendChild(row);
  });
  
  lucide.createIcons();
}

// --- Payment Entry Modal Controller ---
window.openPaymentModal = function(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order) return;
  
  document.getElementById('modalPaymentOrderId').value = order.id;
  document.getElementById('modalPaymentCustomer').textContent = order.customerName;
  document.getElementById('modalPaymentMaterial').textContent = `${order.material} (${getMaterialPunjabiLabel(order.material)})`;
  document.getElementById('modalPaymentInitial').textContent = order.initialWeight.toFixed(2);
  document.getElementById('modalPaymentFinal').textContent = order.finalWeight ? order.finalWeight.toFixed(2) : '0.00';
  
  // Suggest a price (e.g. ₹5 per kg, default setting. Let's make a simple suggestion of ₹5/kg, or leave empty)
  const suggestedAmount = order.finalWeight ? Math.ceil(order.finalWeight * 5) : 0;
  document.getElementById('paymentAmount').value = suggestedAmount;
  
  document.getElementById('paymentModal').classList.add('open');
}

window.closePaymentModal = function() {
  document.getElementById('paymentModal').classList.remove('open');
  document.getElementById('paymentModalForm').reset();
}

window.submitPaymentDispatch = async function() {
  const id = document.getElementById('modalPaymentOrderId').value;
  const payAmtInput = document.getElementById('paymentAmount');
  const payModeInput = document.getElementById('paymentMode');
  const payAmt = parseFloat(payAmtInput.value);
  const payMode = payModeInput.value;
  
  if (isNaN(payAmt) || payAmt < 0) {
    showToast("Please enter a valid amount", "error");
    return;
  }
  
  const order = orders.find(o => o.id === id);
  if (!order) return;
  
  order.paymentAmount = payAmt;
  order.paymentMode = payMode;
  order.status = 'paid';
  order.updatedAt = Date.now();
  order.syncStatus = 'pending';
  
  saveLocalData();
  closePaymentModal();
  showToast(`Order dispatched. Collected ₹${payAmt} via ${payMode}`, "success");
  
  // Re-render
  renderAll();
  
  // Background Sync
  if (isFirebaseConnected) {
    try {
      await uploadRecordToFirestore(order);
      saveLocalData();
      showToast("Cloud synced / ਕਲਾਊਡ ਤੇ ਅਪਡੇਟ ਹੋ ਗਿਆ", "success");
    } catch (err) {
      console.warn("Background upload failed, will sync later", err);
    }
  }
}

// --- 4. Reports View Controller ---
window.toggleFilterModeInputs = function() {
  const mode = document.getElementById('reportFilterMode').value;
  const filterMonth = document.getElementById('filterMonthGroup');
  const filterStart = document.getElementById('filterStartDateGroup');
  const filterEnd = document.getElementById('filterEndDateGroup');
  
  if (mode === 'month') {
    filterMonth.style.display = 'flex';
    filterStart.style.display = 'none';
    filterEnd.style.display = 'none';
    // Set default month
    document.getElementById('filterMonth').value = new Date().toISOString().slice(0, 7);
  } else if (mode === 'range') {
    filterMonth.style.display = 'none';
    filterStart.style.display = 'flex';
    filterEnd.style.display = 'flex';
    
    // Set default range (this month start to today)
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 2).toISOString().slice(0, 10); // +1 day buffer for ISO
    const today = now.toISOString().slice(0, 10);
    
    document.getElementById('filterStartDate').value = startOfMonth;
    document.getElementById('filterEndDate').value = today;
  } else {
    filterMonth.style.display = 'none';
    filterStart.style.display = 'none';
    filterEnd.style.display = 'none';
  }
  
  applyReportFilters();
}

window.applyReportFilters = function() {
  renderReports();
}

function getFilteredOrders() {
  const mode = document.getElementById('reportFilterMode').value;
  
  if (mode === 'all') {
    return orders;
  }
  
  if (mode === 'month') {
    const selectedMonth = document.getElementById('filterMonth').value; // format "YYYY-MM"
    if (!selectedMonth) return orders;
    return orders.filter(o => o.dateTime.startsWith(selectedMonth));
  }
  
  if (mode === 'range') {
    const startStr = document.getElementById('filterStartDate').value;
    const endStr = document.getElementById('filterEndDate').value;
    if (!startStr || !endStr) return orders;
    
    const start = new Date(startStr);
    start.setHours(0,0,0,0);
    const end = new Date(endStr);
    end.setHours(23,59,59,999);
    
    return orders.filter(o => {
      const orderDate = new Date(o.dateTime);
      return orderDate >= start && orderDate <= end;
    });
  }
  
  return orders;
}

function renderReports() {
  const filtered = getFilteredOrders();
  
  // 1. Calculate General Stats
  const pendingCount = orders.filter(o => o.status === 'under_process').length;
  const completedCount = orders.filter(o => o.status === 'completed_pending_payment').length;
  
  // Total Ground Weight (completed + paid orders)
  const totalWeight = filtered
    .filter(o => o.status === 'completed_pending_payment' || o.status === 'paid')
    .reduce((sum, o) => sum + (o.finalWeight || o.initialWeight), 0);
    
  // Total Earnings
  const totalEarnings = filtered
    .filter(o => o.status === 'paid')
    .reduce((sum, o) => sum + (o.paymentAmount || 0), 0);
    
  document.getElementById('statPendingCount').textContent = pendingCount;
  document.getElementById('statCompletedCount').textContent = completedCount;
  document.getElementById('statTotalWeight').textContent = `${totalWeight.toFixed(2)} kg`;
  document.getElementById('statTotalEarnings').textContent = `₹${totalEarnings.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  // 2. Material Category Summary
  const matSummary = {};
  filtered.forEach(o => {
    // Only summarize processed material (completed/paid)
    if (o.status === 'completed_pending_payment' || o.status === 'paid') {
      const mat = o.material;
      if (!matSummary[mat]) {
        matSummary[mat] = {
          name: mat,
          weight: 0,
          orders: 0,
          earnings: 0
        };
      }
      matSummary[mat].weight += (o.finalWeight || o.initialWeight);
      matSummary[mat].orders++;
      matSummary[mat].earnings += (o.paymentAmount || 0);
    }
  });
  
  const summaryTbody = document.getElementById('materialSummaryTableBody');
  summaryTbody.innerHTML = '';
  
  const summaryRows = Object.values(matSummary);
  if (summaryRows.length === 0) {
    summaryTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">No processed orders in this period.</td></tr>`;
  } else {
    summaryRows.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight: 600;">${row.name} <span style="font-weight: normal; color: var(--text-muted); font-size: 0.8rem;">(${getMaterialPunjabiLabel(row.name)})</span></td>
        <td>${row.weight.toFixed(2)} kg</td>
        <td>${row.orders}</td>
        <td style="color: var(--success); font-weight: 600;">₹${row.earnings.toFixed(2)}</td>
      `;
      summaryTbody.appendChild(tr);
    });
  }
  
  // 3. Detailed Transaction Log Table
  const tbody = document.getElementById('reportsTableBody');
  tbody.innerHTML = '';
  
  // Sort filtered orders newest first
  const sorted = [...filtered].sort((a,b) => new Date(b.dateTime) - new Date(a.dateTime));
  
  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 2rem;">No orders matched current filters.</td></tr>`;
    return;
  }
  
  sorted.forEach(o => {
    const tr = document.createElement('tr');
    
    let statusBadge = '';
    if (o.status === 'under_process') {
      statusBadge = '<span class="badge badge-info">Grinding</span>';
    } else if (o.status === 'completed_pending_payment') {
      statusBadge = '<span class="badge badge-warning">Unpaid</span>';
    } else {
      statusBadge = '<span class="badge badge-success">Paid</span>';
    }
    
    tr.innerHTML = `
      <td>#${o.queueNumber}</td>
      <td style="font-size: 0.85rem; font-family: monospace;">${formatDateTimeDisplay(o.dateTime)}</td>
      <td>
        <span style="font-weight: 600; display:block;">${o.customerName}</span>
        <span style="font-size: 0.75rem; color: var(--text-muted);">${o.village} ${o.contactNumber ? '• ' + o.contactNumber : ''}</span>
      </td>
      <td>${o.material}</td>
      <td>${o.initialWeight.toFixed(2)} kg</td>
      <td>${o.finalWeight ? o.finalWeight.toFixed(2) + ' kg' : '-'}</td>
      <td style="font-weight: 600;">${o.paymentAmount ? '₹' + o.paymentAmount.toFixed(2) : '-'}</td>
      <td>${o.paymentMode || '-'}</td>
      <td>${statusBadge}</td>
    `;
    tbody.appendChild(tr);
  });
}

function formatDateTimeDisplay(dateTimeStr) {
  const d = new Date(dateTimeStr);
  if (isNaN(d)) return dateTimeStr;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

window.exportReportToCSV = function() {
  const filtered = getFilteredOrders();
  if (filtered.length === 0) {
    showToast("No data to export", "error");
    return;
  }
  
  // CSV Header
  let csv = 'Order/Queue#,Date & Time,Expected Delivery,Customer Name,Village,Contact,Material,In Weight(kg),Out Weight(kg),Paid Amount(INR),Payment Mode,Status\n';
  
  // Rows
  filtered.forEach(o => {
    const escapedName = `"${o.customerName.replace(/"/g, '""')}"`;
    const escapedVillage = `"${o.village.replace(/"/g, '""')}"`;
    const finalWt = o.finalWeight || '';
    const payAmt = o.paymentAmount || '';
    const payMode = o.paymentMode || '';
    
    csv += `${o.queueNumber},${o.dateTime},${o.deliveryDate},${escapedName},${escapedVillage},${o.contactNumber || ''},${o.material},${o.initialWeight},${finalWt},${payAmt},${payMode},${o.status}\n`;
  });
  
  // Download file
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Rajni_Flour_Mills_Report_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("CSV report exported successfully", "success");
}

// --- 5. Data Sync & Management View Controller ---
function renderDataSync() {
  // Can expand reports or debug info here
}

window.triggerManualSync = async function() {
  if (!db) {
    showToast("Cannot sync: Firebase client is not connected", "error");
    return;
  }
  
  try {
    await syncWithFirestore();
    showToast("Database Synced with Cloud successfully!", "success");
  } catch (err) {
    showToast("Sync Failed. Operating offline.", "error");
  }
}

window.testFirebaseConnection = async function() {
  updateSyncStatus('syncing', 'Testing Link...');
  try {
    // Attempt a lightweight fetch from firestore
    const snapshot = await getDocs(collection(db, "GrindingRecords"));
    updateSyncStatus('connected', 'Cloud Link OK');
    showToast(`Firebase Online. Found ${snapshot.size} cloud records.`, "success");
    isFirebaseConnected = true;
  } catch (err) {
    console.error(err);
    updateSyncStatus('offline', 'Link Failed');
    showToast("Connection Test Failed. Check console logs.", "error");
    isFirebaseConnected = false;
  }
}

// Bulk export locally as JSON
window.downloadBackup = function() {
  if (orders.length === 0) {
    showToast("Local database is empty, nothing to backup", "error");
    return;
  }
  
  const backupData = {};
  orders.forEach(o => {
    // Store with standard format keyed by legacy keys
    const docId = o.queueNumber + "_" + o.dateTime.slice(0, 10);
    backupData[docId] = {
      id: o.id,
      queueNumber: o.queueNumber.toString(),
      dateTime: o.dateTime,
      deliveryDate: o.deliveryDate,
      customerName: o.customerName,
      village: o.village,
      contactNumber: o.contactNumber || "",
      material: o.material,
      weight: o.initialWeight,
      initialWeight: o.initialWeight,
      finalWeight: o.finalWeight || 0,
      status: o.status,
      paymentAmount: o.paymentAmount || 0,
      paymentMode: o.paymentMode || "",
      updatedAt: o.updatedAt
    };
  });
  
  const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Rajni_Flour_Mills_Backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Backup file downloaded", "success");
}

// Bulk restore locally from uploaded JSON backup
window.uploadBackup = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  try {
    const text = await file.text();
    const backupData = JSON.parse(text);
    
    let count = 0;
    for (let key in backupData) {
      const bRecord = backupData[key];
      
      // Normalize record
      const normalized = {
        id: bRecord.id || `RFM_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        queueNumber: parseInt(bRecord.queueNumber),
        dateTime: bRecord.dateTime || new Date().toISOString(),
        deliveryDate: bRecord.deliveryDate || bRecord.dateTime ? bRecord.dateTime.slice(0,10) : new Date().toISOString().slice(0,10),
        customerName: bRecord.customerName,
        village: bRecord.village || "",
        contactNumber: bRecord.contactNumber || "",
        material: bRecord.material,
        initialWeight: parseFloat(bRecord.initialWeight || bRecord.weight || 0),
        finalWeight: parseFloat(bRecord.finalWeight) || null,
        status: bRecord.status || 'under_process',
        paymentAmount: parseFloat(bRecord.paymentAmount) || null,
        paymentMode: bRecord.paymentMode || null,
        syncStatus: 'pending', // Mark pending so it uploads during sync
        updatedAt: bRecord.updatedAt || Date.now()
      };
      
      // Look for duplicate locally to overwrite/add
      const index = orders.findIndex(o => o.id === normalized.id || (o.queueNumber === normalized.queueNumber && o.dateTime.slice(0,10) === normalized.dateTime.slice(0,10)));
      if (index > -1) {
        orders[index] = normalized;
      } else {
        orders.push(normalized);
      }
      count++;
    }
    
    saveLocalData();
    showToast(`Successfully imported ${count} records!`, "success");
    event.target.value = ''; // Reset input
    renderAll();
    
    // Attempt trigger sync
    if (isFirebaseConnected) {
      syncWithFirestore();
    }
  } catch (err) {
    console.error("Backup upload failed", err);
    showToast("Invalid backup JSON file.", "error");
  }
}

// Clear database
window.clearLocalDatabase = function() {
  if (!confirm("⚠️ WARNING: This will permanently delete all records from this browser cache. Are you absolutely sure?")) {
    return;
  }
  if (!confirm("This action cannot be undone. Please make sure you have downloaded a Backup JSON. Click OK to erase.")) {
    return;
  }
  
  orders = [];
  saveLocalData();
  showToast("Local database cleared successfully", "info");
  renderAll();
}

// --- Toast Message Component ---
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'check-circle';
  if (type === 'error') icon = 'alert-triangle';
  if (type === 'info') icon = 'info';
  
  toast.innerHTML = `
    <i data-lucide="${icon}"></i>
    <span>${message}</span>
  `;
  
  container.appendChild(toast);
  lucide.createIcons();
  
  // Slide out and remove toast after 3.5s
  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.3s ease reverse forwards';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3500);
}
