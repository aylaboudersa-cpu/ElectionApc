fetch('/api/me').then(r => {
  if (r.ok) window.location.href = '/dashboard';
}).catch(() => {});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const login = tab.dataset.tab === 'login';
    document.getElementById('loginForm').classList.toggle('hidden', !login);
    document.getElementById('registerForm').classList.toggle('hidden', login);
  });
});

function showMsg(el, text, ok = false) {
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'error');
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('loginMsg');
  const { res, data } = await postJson('/api/login', {
    username: document.getElementById('loginUsername').value.trim(),
    password: document.getElementById('loginPassword').value
  });
  if (res.ok) {
    showMsg(msg, 'تم الدخول، جارٍ تحويلك...', true);
    window.location.href = '/dashboard';
  } else showMsg(msg, data.error || 'خطأ في الدخول');
});

document.getElementById('registerForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('regMsg');
  const { res, data } = await postJson('/api/register', {
    username: document.getElementById('regUsername').value.trim(),
    password: document.getElementById('regPassword').value
  });
  if (res.ok) {
    showMsg(msg, 'تم إنشاء الحساب، جارٍ تحويلك...', true);
    window.location.href = '/dashboard';
  } else showMsg(msg, data.error || 'خطأ في التسجيل');
});
