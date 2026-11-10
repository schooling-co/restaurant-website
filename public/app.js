const state = { menu: [], tables: [], cart: new Map(), token: localStorage.getItem('restaurantOwnerToken') || '', stripeEnabled: false };
const $ = (selector) => document.querySelector(selector);
const money = (value) => `$${Number(value).toFixed(2)}`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const queryTable = new URLSearchParams(location.search).get('table');
let selectedQrTable = queryTable && /^\d+$/.test(queryTable) ? Number(queryTable) : null;

async function api(url, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...options.headers };
  const response = await fetch(url, { ...options, headers });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}
function showMessage(message, isError = false) {
  const box = $('#orderMessage');
  box.textContent = message;
  box.classList.remove('hidden', 'error-notice');
  if (isError) box.classList.add('error-notice');
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function safeImage(name) {
  const urls = [
    'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=900&q=80',
    'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=900&q=80',
    'https://images.unsplash.com/photo-1559737558-2f5a35f4523b?auto=format&fit=crop&w=900&q=80'
  ];
  return urls[Math.abs([...name].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % urls.length];
}
function renderMenu() {
  const grid = $('#menuGrid');
  grid.replaceChildren();
  if (!state.menu.length) { grid.innerHTML = '<p class="muted">No menu items are currently available.</p>'; return; }
  for (const item of state.menu) {
    const card = document.createElement('article');
    card.className = 'menu-card';
    card.innerHTML = `<img class="dish-image" src="${safeImage(item.name)}" alt="${escapeHtml(item.name)}" loading="lazy"><div class="menu-content"><div class="menu-title"><h3>${escapeHtml(item.name)}</h3><span class="menu-price">${money(item.price)}</span></div><p class="menu-category">${escapeHtml(item.category)}</p><p class="menu-description">${escapeHtml(item.description)}</p><button class="button primary add-cart" data-add="${item.id}">Add to order</button></div>`;
    grid.append(card);
  }
}
function updateCart() {
  const host = $('#cartItems');
  host.replaceChildren();
  if (!state.cart.size) host.innerHTML = '<p class="muted">Your cart is empty. Add something delicious from the menu.</p>';
  for (const [id, quantity] of state.cart) {
    const item = state.menu.find((entry) => entry.id === id);
    if (!item) continue;
    const row = document.createElement('div');
    row.className = 'cart-line';
    row.innerHTML = `<div><strong>${escapeHtml(item.name)}</strong><br><span class="muted">${money(item.price)} each</span></div><div class="quantity-control"><button type="button" data-change="${id}" data-by="-1" aria-label="Remove one">−</button><span>${quantity}</span><button type="button" data-change="${id}" data-by="1" aria-label="Add one">+</button><button type="button" class="remove-item" data-remove="${id}">Remove</button></div><strong>${money(item.price * quantity)}</strong>`;
    host.append(row);
  }
  const total = [...state.cart].reduce((sum, [id, quantity]) => sum + (state.menu.find((item) => item.id === id)?.price || 0) * quantity, 0);
  $('#cartTotal').textContent = money(total);
}
function renderTables() {
  const host = $('#publicTables');
  host.replaceChildren();
  for (const table of state.tables) {
    const card = document.createElement('article');
    card.className = 'table-card';
    card.innerHTML = `<div class="table-head"><h3>Table ${table.id}</h3><span class="status ${table.status}">${escapeHtml(table.status)}</span></div><p class="muted">Seats ${table.seats}</p>`;
    host.append(card);
  }
  const select = $('#tableSelect');
  select.innerHTML = '<option value="">Choose your table</option>';
  state.tables.forEach((table) => {
    const option = document.createElement('option');
    option.value = table.id;
    option.textContent = `Table ${table.id} · ${table.seats} seats`;
    select.append(option);
  });
  if (selectedQrTable && state.tables.some((table) => table.id === selectedQrTable)) {
    $('#orderType').value = 'dine-in';
    select.value = String(selectedQrTable);
    $('#tableNotice').textContent = `Welcome! Your QR code is for Table ${selectedQrTable}.`;
    $('#tableNotice').classList.remove('hidden');
  }
  updateTableField();
}
function updateTableField() {
  const dineIn = $('#orderType').value === 'dine-in';
  $('#tableField').classList.toggle('hidden', !dineIn);
  $('#tableSelect').required = dineIn;
  if (dineIn && selectedQrTable) $('#tableSelect').value = String(selectedQrTable);
}
async function loadOwnerData() {
  const [orders, tables] = await Promise.all([api('/api/owner/orders'), api('/api/tables')]);
  state.tables = tables;
  renderTables();
  renderOrders(orders);
  await renderAdminMenu();
  await renderAdminTables();
}
function renderOrders(orders) {
  const host = $('#ordersList');
  host.replaceChildren();
  if (!orders.length) { host.innerHTML = '<p class="muted">No orders yet. New customer orders will appear here.</p>'; return; }
  const statuses = ['received', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
  for (const order of orders) {
    const card = document.createElement('article');
    card.className = 'order-card';
    const lineItems = order.items.map((item) => `${item.quantity} × ${escapeHtml(item.name)} (${money(item.unit_price)})`).join(' · ');
    card.innerHTML = `<div class="order-card-head"><h4>Order #${order.id} · ${escapeHtml(order.customer_name)}</h4><strong>${money(order.total)}</strong></div><p>${escapeHtml(order.order_type)}${order.table_id ? ` · Table ${order.table_id}` : ''} · ${escapeHtml(order.phone)} · ${escapeHtml(order.created_at)}</p><p>${lineItems}</p><p>Payment: ${escapeHtml(order.payment_status)}${order.payment_method === 'in_person' ? ' · Pay at restaurant' : ' · Card'}</p><div class="order-controls"><label for="order-status-${order.id}">Status</label><select id="order-status-${order.id}" data-order-status="${order.id}">${statuses.map((status) => `<option ${status === order.status ? 'selected' : ''}>${status}</option>`).join('')}</select></div>`;
    host.append(card);
  }
}
async function renderAdminMenu() {
  const allMenu = await api('/api/owner/menu');
  const host = $('#adminMenu');
  host.replaceChildren();
  allMenu.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    row.innerHTML = `<p><strong>${escapeHtml(item.name)}</strong> · ${money(item.price)} · ${item.available ? 'Available' : 'Hidden'}</p><button class="button secondary" data-availability="${item.id}" data-next="${!item.available}">${item.available ? 'Hide item' : 'Show item'}</button>`;
    host.append(row);
  });
}
async function renderAdminTables() {
  const host = $('#adminTables');
  host.replaceChildren();
  for (const table of state.tables) {
    const row = document.createElement('div');
    row.className = 'admin-row';
    row.innerHTML = `<div><strong>Table ${table.id}</strong><p class="muted">${table.seats} seats · ${escapeHtml(table.status)}</p><div class="qr-print hidden" id="qr-${table.id}"></div></div><div class="table-actions"><select data-table-status="${table.id}" aria-label="Table ${table.id} status"><option ${table.status === 'Available' ? 'selected' : ''}>Available</option><option ${table.status === 'Occupied' ? 'selected' : ''}>Occupied</option><option ${table.status === 'Reserved' ? 'selected' : ''}>Reserved</option></select><button class="button secondary" data-qr="${table.id}">Show QR</button></div>`;
    host.append(row);
  }
}
async function refreshDashboard() {
  try { await loadOwnerData(); } catch (error) { showMessage(error.message, true); }
}

$('#menuGrid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-add]');
  if (!button) return;
  const id = Number(button.dataset.add);
  state.cart.set(id, Math.min(20, (state.cart.get(id) || 0) + 1));
  updateCart();
  $('#order').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#cartItems').addEventListener('click', (event) => {
  const change = event.target.closest('[data-change]');
  const remove = event.target.closest('[data-remove]');
  if (remove) state.cart.delete(Number(remove.dataset.remove));
  if (change) {
    const id = Number(change.dataset.change);
    const next = (state.cart.get(id) || 0) + Number(change.dataset.by);
    if (next < 1) state.cart.delete(id); else state.cart.set(id, Math.min(20, next));
  }
  updateCart();
});
$('#orderType').addEventListener('change', updateTableField);
$('#checkoutForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.cart.size) return showMessage('Add at least one item before placing your order.', true);
  const form = new FormData(event.currentTarget);
  const payload = {
    customerName: form.get('customerName'), phone: form.get('phone'), orderType: form.get('orderType'),
    tableId: form.get('orderType') === 'dine-in' ? Number(form.get('tableId')) : null,
    paymentMethod: form.get('paymentMethod'), items: [...state.cart].map(([id, quantity]) => ({ id, quantity }))
  };
  const button = $('#placeOrder');
  button.disabled = true;
  button.textContent = 'Sending order…';
  $('#orderMessage').classList.add('hidden');
  try {
    const result = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
    if (result.checkoutUrl) { location.assign(result.checkoutUrl); return; }
    state.cart.clear();
    updateCart();
    event.currentTarget.reset();
    updateTableField();
    showMessage(`Thanks! Your order #${result.orderId} has been received. ${result.message}`);
  } catch (error) { showMessage(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Place order'; }
});

$('#portalOpen').addEventListener('click', () => $('#ownerModal').classList.remove('hidden'));
$('#portalClose').addEventListener('click', () => $('#ownerModal').classList.add('hidden'));
$('#ownerModal').addEventListener('click', (event) => { if (event.target.id === 'ownerModal') $('#ownerModal').classList.add('hidden'); });
$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    const result = await api('/api/owner/login', { method: 'POST', body: JSON.stringify({ password: $('#ownerPassword').value }) });
    state.token = result.token;
    localStorage.setItem('restaurantOwnerToken', state.token);
    $('#loginForm').classList.add('hidden');
    $('#dashboard').classList.remove('hidden');
    await refreshDashboard();
  } catch (error) { $('#loginError').textContent = error.message; }
});
$('#logout').addEventListener('click', () => {
  state.token = '';
  localStorage.removeItem('restaurantOwnerToken');
  $('#dashboard').classList.add('hidden');
  $('#loginForm').classList.remove('hidden');
  $('#ownerPassword').value = '';
});
$('#menuForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/owner/menu', { method: 'POST', body: JSON.stringify({ name: form.get('name'), category: form.get('category'), description: form.get('description'), price: Number(form.get('price')) }) });
    event.currentTarget.reset();
    await initMenu();
    await renderAdminMenu();
  } catch (error) { alert(error.message); }
});
$('#tableForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/owner/tables', { method: 'POST', body: JSON.stringify({ seats: Number(form.get('seats')) }) });
    event.currentTarget.reset();
    await loadOwnerData();
  } catch (error) { alert(error.message); }
});
$('#adminMenu').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-availability]');
  if (!button) return;
  try {
    await api(`/api/owner/menu/${button.dataset.availability}`, { method: 'PATCH', body: JSON.stringify({ available: button.dataset.next === 'true' }) });
    await initMenu();
    await renderAdminMenu();
  } catch (error) { alert(error.message); }
});
$('#adminTables').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-table-status]');
  if (!select) return;
  try {
    await api(`/api/owner/tables/${select.dataset.tableStatus}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) });
    await loadTables();
  } catch (error) { alert(error.message); }
});
$('#adminTables').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-qr]');
  if (!button) return;
  const target = $(`#qr-${button.dataset.qr}`);
  if (!target.classList.contains('hidden')) { target.classList.add('hidden'); button.textContent = 'Show QR'; return; }
  try {
    const qr = await api(`/api/owner/tables/${button.dataset.qr}/qr`);
    target.innerHTML = `<img src="${qr.dataUrl}" alt="QR code for table ${button.dataset.qr}"><a href="${escapeHtml(qr.url)}" target="_blank" rel="noreferrer">${escapeHtml(qr.url)}</a><button type="button" class="button secondary" data-print="${button.dataset.qr}">Print QR</button>`;
    target.classList.remove('hidden');
    button.textContent = 'Hide QR';
  } catch (error) { alert(error.message); }
});
$('#adminTables').addEventListener('click', (event) => {
  const print = event.target.closest('[data-print]');
  if (!print) return;
  const image = $(`#qr-${print.dataset.print} img`).src;
  const popup = window.open('', '_blank', 'width=500,height=600');
  if (!popup) return alert('Please allow pop-ups to print table QR codes.');
  popup.document.write(`<title>Table ${print.dataset.print} QR</title><body style="font:20px sans-serif;text-align:center;padding:30px"><h1>Table ${print.dataset.print}</h1><img style="width:320px" src="${image}" onload="window.print()"></body>`);
  popup.document.close();
});
$('#ordersList').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-order-status]');
  if (!select) return;
  try {
    await api(`/api/owner/orders/${select.dataset.orderStatus}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) });
    await refreshDashboard();
  } catch (error) { alert(error.message); }
});

async function initMenu() {
  state.menu = await api('/api/menu');
  renderMenu();
  updateCart();
}
async function loadTables() {
  state.tables = await api('/api/tables');
  renderTables();
}
async function init() {
  try {
    const config = await api('/api/config');
    $('#brandName').textContent = config.restaurant.name;
    $('#footerName').textContent = config.restaurant.name;
    $('#restaurantAddress').textContent = config.restaurant.address;
    $('#restaurantPhone').textContent = config.restaurant.phone;
    $('#footerContact').textContent = `${config.restaurant.address} · ${config.restaurant.phone}`;
    state.stripeEnabled = config.stripeEnabled;
    if (state.stripeEnabled) $('#paymentMethod').insertAdjacentHTML('beforeend', '<option value="stripe">Pay securely by card</option>');
    await Promise.all([initMenu(), loadTables()]);
    const paymentStatus = new URLSearchParams(location.search).get('payment');
    if (paymentStatus === 'success') showMessage('Payment submitted. The restaurant will confirm the order when Stripe verifies payment.');
    if (paymentStatus === 'cancelled') showMessage('Card payment was cancelled. Your order was not paid; you can place it again and pay at the restaurant.', true);
    if (state.token) {
      $('#loginForm').classList.add('hidden');
      $('#dashboard').classList.remove('hidden');
      await refreshDashboard();
    }
  } catch (error) {
    $('#menuGrid').innerHTML = `<p class="muted">Could not connect to the ordering server: ${escapeHtml(error.message)}. Please refresh the page.</p>`;
  }
}
init();
