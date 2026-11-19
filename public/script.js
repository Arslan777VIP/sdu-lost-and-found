const get = id => document.getElementById(id);
const authForm = get('auth-form');
const itemForm = get('item-form');
const claimForm = get('claim-form');
const state = { user: null, items: [], view: 'board', register: false, editId: null, claimId: null, afterLogin: null };

async function api(url, method = 'GET', data) {
  const options = method === 'GET' ? {} : {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {})
  };
  const response = await fetch('/api' + url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Запрос не выполнен.');
  return result;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className = 'plain') {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', event => run(event.currentTarget, action));
  return node;
}

function notice(text) {
  get('notice').textContent = text;
  get('notice').hidden = !text;
}

async function run(control, action, errorOutput = notice) {
  control.disabled = true;
  errorOutput('');
  try {
    await action();
  } catch (error) {
    errorOutput(error.message);
  } finally {
    control.disabled = false;
  }
}

function bindForm(form, action) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    const error = form.querySelector('.form-error');
    const data = Object.fromEntries(new FormData(form));
    run(event.submitter, () => action(data), message => {
      error.textContent = message;
      error.hidden = !message;
    });
  });
}

function openDialog(id) {
  const dialog = get(id);
  const error = dialog.querySelector('.form-error');
  error.textContent = '';
  error.hidden = true;
  dialog.showModal();
}

function showAuth(action = null) {
  state.afterLogin = action;
  authForm.reset();
  setAuthMode(false);
  openDialog('auth-dialog');
}

function setAuthMode(register) {
  state.register = register;
  get('auth-title').textContent = register ? 'Регистрация' : 'Вход';
  get('name-label').hidden = !register;
  authForm.elements.name.required = register;
  authForm.elements.password.autocomplete = register ? 'new-password' : 'current-password';
  authForm.querySelector('[type=submit]').textContent = register ? 'Зарегистрироваться' : 'Войти';
  get('auth-switch').textContent = register ? 'У меня уже есть аккаунт' : 'Создать аккаунт';
  authForm.querySelector('.form-error').hidden = true;
}

function updateProfile() {
  get('profile').textContent = state.user?.name || '';
  for (const id of ['profile', 'logout-button', 'claims-tab']) get(id).hidden = !state.user;
  get('login-button').hidden = Boolean(state.user);
}

function chooseView(view) {
  state.view = view;
  for (const name of ['board', 'claims']) {
    get(name).hidden = name !== view;
    get(name + '-tab').classList.toggle('active', name === view);
    if (name === view) get(name + '-tab').setAttribute('aria-current', 'true');
    else get(name + '-tab').removeAttribute('aria-current');
  }
}

async function refreshBoard() {
  state.items = (await api('/items')).items;
  renderBoard();
}

function renderBoard() {
  const search = get('search').value.trim().toLowerCase();
  const kind = get('kind-filter').value;
  const items = state.items.filter(item => (!kind || kind === item.kind) &&
    (item.title + ' ' + item.location + ' ' + item.category).toLowerCase().includes(search));
  get('items').replaceChildren(...items.map(renderItem));
  if (!items.length) get('items').append(element('p', 'Объявлений не найдено.', 'empty'));
}

function renderItem(item) {
  const card = element('article', '', 'card');
  const label = item.status === 'closed' ? 'Закрыто' : item.kind === 'found' ? 'Находка' : 'Пропажа';
  card.append(
    element('p', label, 'badge ' + (item.status === 'closed' ? 'closed' : item.kind)),
    element('h3', item.title),
    element('p', item.category + ' · ' + item.location, 'meta'),
    element('p', item.description),
    element('p', 'Автор: ' + item.author, 'meta')
  );
  if (item.status === 'closed') return card;
  const actions = element('div', '', 'card-actions');
  if (item.author_id === state.user?.id) {
    actions.append(
      button('Редактировать', () => showItemForm(item)),
      button('Удалить', async () => {
        if (!confirm('Удалить объявление и связанные заявки?')) return;
        await api('/items/' + item.id, 'DELETE');
        await refreshBoard();
        notice('Объявление удалено.');
      }, 'plain danger')
    );
  } else if (item.has_claim) {
    actions.append(element('p', 'Вы уже отправили заявку.', 'meta'));
  } else {
    const label = item.kind === 'found' ? 'Это моя вещь' : 'Я нашёл вещь';
    actions.append(button(label, () => {
      if (!state.user) showAuth(() => showClaimForm(item));
      else showClaimForm(item);
    }, 'primary'));
  }
  card.append(actions);
  return card;
}

function showItemForm(item) {
  state.editId = item?.id ?? null;
  itemForm.reset();
  if (item) {
    for (const field of ['kind', 'title', 'category', 'location', 'description']) {
      itemForm.elements[field].value = item[field];
    }
  }
  get('item-title').textContent = item ? 'Редактировать объявление' : 'Новое объявление';
  itemForm.querySelector('[type=submit]').textContent = item ? 'Сохранить' : 'Опубликовать';
  openDialog('item-dialog');
}

function showClaimForm(item) {
  state.claimId = item.id;
  claimForm.reset();
  get('claim-title').textContent = item.kind === 'found' ? 'Заявка на возврат' : 'Сообщить о находке';
  get('claim-item').textContent = item.title;
  get('proof-label').textContent = item.kind === 'found' ? 'Опишите отличительные признаки' : 'Расскажите, где находится вещь';
  openDialog('claim-dialog');
}

async function refreshClaims() {
  const { claims } = await api('/claims');
  get('claim-list').replaceChildren(...claims.map(renderClaim));
  if (!claims.length) get('claim-list').append(element('p', 'Заявок пока нет.', 'empty'));
}

function renderClaim(claim) {
  const card = element('article', '', 'card');
  const incoming = claim.author_id === state.user.id;
  const labels = { pending: 'На рассмотрении', accepted: 'Подтверждена', rejected: 'Отклонена' };
  card.append(
    element('p', labels[claim.status], 'badge ' + (claim.status === 'rejected' ? 'closed' : '')),
    element('h3', claim.title),
    element('p', incoming ? 'От: ' + claim.claimant : 'Исходящая заявка', 'meta'),
    element('p', claim.proof)
  );
  if (incoming && claim.status === 'pending') {
    const actions = element('div', '', 'card-actions');
    const decide = async status => {
      actions.hidden = true;
      try {
        await api('/claims/' + claim.id, 'PATCH', { status });
        await refreshClaims();
        notice(status === 'accepted' ? 'Заявка подтверждена. Объявление закрыто.' : 'Заявка отклонена.');
      } finally {
        actions.hidden = false;
      }
    };
    actions.append(button('Подтвердить', () => decide('accepted'), 'primary'), button('Отклонить', () => decide('rejected')));
    card.append(actions);
  }
  return card;
}

bindForm(authForm, async data => {
  const { user } = await api(state.register ? '/register' : '/login', 'POST', data);
  state.user = user;
  updateProfile();
  await refreshBoard();
  get('auth-dialog').close();
  const next = state.afterLogin;
  state.afterLogin = null;
  if (next) next();
});

bindForm(itemForm, async data => {
  const editing = state.editId !== null;
  await api(editing ? '/items/' + state.editId : '/items', editing ? 'PATCH' : 'POST', data);
  get('item-dialog').close();
  await refreshBoard();
  chooseView('board');
  notice(editing ? 'Изменения сохранены.' : 'Объявление опубликовано.');
});

bindForm(claimForm, async data => {
  await api('/items/' + state.claimId + '/claims', 'POST', data);
  get('claim-dialog').close();
  await refreshBoard();
  notice('Заявка отправлена.');
});

get('login-button').addEventListener('click', () => showAuth());
get('auth-switch').addEventListener('click', () => setAuthMode(!state.register));
get('logout-button').addEventListener('click', event => run(event.currentTarget, async () => {
  await api('/logout', 'POST');
  state.user = null;
  updateProfile();
  get('claim-list').replaceChildren();
  chooseView('board');
  await refreshBoard();
}));
get('board-tab').addEventListener('click', event => run(event.currentTarget, async () => {
  await refreshBoard();
  chooseView('board');
}));
get('claims-tab').addEventListener('click', event => run(event.currentTarget, async () => {
  await refreshClaims();
  chooseView('claims');
}));
get('publish-button').addEventListener('click', () => {
  if (state.user) showItemForm();
  else showAuth(() => showItemForm());
});
get('search').addEventListener('input', renderBoard);
get('kind-filter').addEventListener('change', renderBoard);
document.querySelectorAll('[data-close]').forEach(control => {
  control.addEventListener('click', () => control.closest('dialog').close());
});

async function init() {
  const { user } = await api('/session');
  state.user = user;
  updateProfile();
  chooseView('board');
  await refreshBoard();
}

init().catch(error => notice(error.message));
