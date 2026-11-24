const PARTY_NAMES = {
  fln: '01 حزب جبهة التحرير الوطني',
  fm: '03 حزب جبهة المستقبل',
  msp: '05 حزب حركة مجتمع السلم'
};

const state = {
  totalVotes: 0,
  threshold: 0,
  coefficient: 0,
  votes: { fln: null, fm: null, msp: null },
  scenarios: []
};
let draftSaveTimer = null;
let draftSaveChain = Promise.resolve();
let restoringDraft = false;

function scheduleDraftSave() {
  if (restoringDraft) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    const snapshot = { totalVotes: totalInput.value === '' ? null : Number(totalInput.value), votes: { ...state.votes } };
    draftSaveChain = draftSaveChain.then(() => fetch('/api/draft', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot)
    })).then(async response => {
      if (!response.ok) throw new Error('تعذر حفظ المسودة تلقائياً');
      const status = document.getElementById('draftStatus');
      if (status) status.textContent = 'تم حفظ المدخلات تلقائياً';
    }).catch(err => {
      const status = document.getElementById('draftStatus');
      if (status) status.textContent = err.message;
    });
  }, 450);
}

async function loadDraft() {
  const response = await fetch('/api/draft');
  if (!response.ok) return;
  const data = await response.json();
  if (!data.draft) return;
  const draft = data.draft;
  restoringDraft = true;
  if (draft.total_votes !== null) {
    totalInput.value = draft.total_votes;
    state.totalVotes = Number(draft.total_votes);
    state.threshold = state.totalVotes * 0.05;
    state.coefficient = state.totalVotes / 19;
    thresholdEl.textContent = fmtNum(state.threshold);
    coefficientEl.textContent = fmtNum(state.coefficient, 4);
  }
  state.votes = { fln: draft.party_votes?.fln ?? null, fm: draft.party_votes?.fm ?? null, msp: draft.party_votes?.msp ?? null };
  for (const key of Object.keys(PARTY_NAMES)) {
    document.querySelector(`[data-votes="${key}"]`).textContent = state.votes[key] === null ? '—' : fmtNum(state.votes[key], 0);
  }
  restoringDraft = false;
  updateConfirmState();
  const status = document.getElementById('draftStatus');
  if (status) status.textContent = 'تم استرجاع آخر مدخلات محفوظة';
}

const fmtNum = (n, dec = 2) =>
  Number(n).toLocaleString('ar-DZ', { maximumFractionDigits: dec });

fetch('/api/me').then(r => {
  if (!r.ok) throw new Error('unauthorized');
  return r.json();
}).then(async d => {
  document.getElementById('currentUser').textContent = d.user.username;
  await loadDraft();
  loadHistory();
}).catch(() => { window.location.href = '/'; });

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
});

const totalInput = document.getElementById('totalVotes');
const thresholdEl = document.getElementById('thresholdValue');
const coefficientEl = document.getElementById('coefficientValue');

totalInput.addEventListener('input', () => {
  const raw = totalInput.value;
  const v = Number(raw);
  if (raw !== '' && Number.isSafeInteger(v) && v > 0) {
    state.totalVotes = v;
    state.threshold = v * 0.05;
    state.coefficient = v / 19;
    thresholdEl.textContent = fmtNum(state.threshold);
    coefficientEl.textContent = fmtNum(state.coefficient, 4);
  } else {
    state.totalVotes = state.threshold = state.coefficient = 0;
    thresholdEl.textContent = coefficientEl.textContent = '—';
  }
  resetResults();
  updateConfirmState();
  scheduleDraftSave();
});

let activeParty = null;
const modal = document.getElementById('modal');
const modalInput = document.getElementById('modalInput');

function openPartyModal(card) {
  activeParty = card.dataset.party;
  document.getElementById('modalTitle').textContent = PARTY_NAMES[activeParty];
  const current = state.votes[activeParty];
  modalInput.value = current === null ? '' : current;
  modal.classList.remove('hidden');
  modalInput.focus();
}

document.querySelectorAll('.party-card').forEach(card => {
  card.addEventListener('click', () => openPartyModal(card));
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPartyModal(card);
    }
  });
});

function closeModal() {
  modal.classList.add('hidden');
  activeParty = null;
}

document.getElementById('modalCancel').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

document.getElementById('modalSave').addEventListener('click', () => {
  const raw = modalInput.value;
  const value = Number(raw);
  if (raw === '' || !Number.isSafeInteger(value) || value < 0) {
    alert('أدخل عدداً صحيحاً موجباً أو صفراً');
    return;
  }
  state.votes[activeParty] = value;
  document.querySelector(`[data-votes="${activeParty}"]`).textContent = fmtNum(value, 0);
  closeModal();
  resetResults();
  updateConfirmState();
  scheduleDraftSave();
});

modalInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('modalSave').click();
  if (e.key === 'Escape') closeModal();
});

function updateConfirmState() {
  const allFilled = Object.values(state.votes).every(v => v !== null);
  document.getElementById('confirmBtn').disabled = !(allFilled && state.totalVotes > 0);
}

function resetResults() {
  const section = document.getElementById('resultsSection');
  section.classList.add('hidden');
  section.innerHTML = '';
}

document.getElementById('confirmBtn').addEventListener('click', async () => {
  const button = document.getElementById('confirmBtn');
  button.disabled = true;
  button.textContent = 'جاري الحساب...';
  try {
    const res = await fetch('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalVotes: state.totalVotes,
        fln: state.votes.fln,
        fm: state.votes.fm,
        msp: state.votes.msp
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'خطأ في الحساب');
    renderResults(data);
    clearTimeout(draftSaveTimer);
    await draftSaveChain;
    await fetch('/api/draft', { method: 'DELETE' });
    const draftStatus = document.getElementById('draftStatus');
    if (draftStatus) draftStatus.textContent = 'حُفظت العملية في السجل';
    await loadHistory();
  } catch (err) {
    alert(err.message);
  } finally {
    button.textContent = 'تأكيد القيم المدخلة';
    updateConfirmState();
  }
});

document.getElementById('resetBtn').addEventListener('click', () => {
  state.totalVotes = state.threshold = state.coefficient = 0;
  state.votes = { fln: null, fm: null, msp: null };
  totalInput.value = '';
  thresholdEl.textContent = coefficientEl.textContent = '—';
  document.querySelectorAll('[data-votes]').forEach(el => el.textContent = '—');
  resetResults();
  updateConfirmState();
  scheduleDraftSave();
});

function renderResults(data) {
  const section = document.getElementById('resultsSection');
  section.classList.remove('hidden');
  const rows = Object.entries(data.results).map(([key, result]) => `
    <tr>
      <td>${PARTY_NAMES[key]}</td>
      <td>${fmtNum(result.votes, 0)}</td>
      <td><strong>${result.seats}</strong>${result.extraSeat ? ' <span class="badge gold">مقعد بأكبر البواقي</span>' : ''}</td>
      <td>${result.eligible ? fmtNum(result.remainder) : '—'}</td>
      <td>${result.belowThreshold
        ? '<span class="badge warn">مستبعد — أقل من 5%</span>'
        : '<span class="badge ok">مؤهل للتوزيع</span>'}</td>
    </tr>`).join('');

  section.innerHTML = `
    <h2 class="section-title">نتائج توزيع المقاعد</h2>
    <div class="results-meta">
      <span>عتبة 5%: <strong>${fmtNum(data.threshold)}</strong> صوت</span>
      <span>أصوات الأحزاب المؤهلة: <strong>${fmtNum(data.eligibleVotes ?? 0, 0)}</strong></span>
      <span>معامل المقعد بعد الاستبعاد: <strong>${fmtNum(data.coefficient, 4)}</strong></span>
      <span>مجموع المقاعد: <strong>${fmtNum(data.totalAllocatedSeats ?? 19, 0)} / 19</strong></span>
    </div>
    <div class="table-wrap">
      <table class="results-table">
        <thead><tr><th>الحزب</th><th>الأصوات</th><th>المقاعد</th><th>باقي القسمة</th><th>الحالة</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted small">يُستبعد تلقائياً كل حزب تقل أصواته عن 5% من مجموع الأصوات الصحيحة، ولا يحصل على أي مقعد. يُحسب معامل المقعد بقسمة مجموع أصوات الأحزاب المؤهلة فقط على 19، ثم توزّع المقاعد المتبقية حسب أكبر البواقي بين الأحزاب المؤهلة. الحزب الذي يبلغ 5% بالضبط يبقى مؤهلاً.</p>`;
}

async function loadHistory() {
  const response = await fetch('/api/scenarios');
  if (response.status === 401) { window.location.href = '/'; return; }
  const data = await response.json();
  state.scenarios = data.scenarios || [];
  const list = document.getElementById('historyList');
  if (!data.scenarios || !data.scenarios.length) {
    list.innerHTML = '<p class="muted">لا توجد سجلات بعد.</p>';
    return;
  }
  list.innerHTML = data.scenarios.map(s => `
    <article class="history-item">
      <div class="history-head">
        <strong>${new Date(s.created_at).toLocaleString('ar-DZ')}</strong>
        <span class="muted">إجمالي الأصوات: ${fmtNum(s.total_votes, 0)}</span>
      </div>
      <div class="history-results">
        ${Object.entries(s.results).map(([key, result]) =>
          `<span class="chip">${PARTY_NAMES[key]}: ${result.belowThreshold ? 'مستبعد' : `${result.seats} مقعد`}</span>`
        ).join('')}
      </div>
      <button class="btn-ghost restore-scenario-btn" type="button" data-scenario-id="${s.id}">استرجاع الأرقام للتعديل</button>
    </article>`).join('');
  list.querySelectorAll('.restore-scenario-btn').forEach(button => button.addEventListener('click', () => {
    const scenario = state.scenarios.find(item => Number(item.id) === Number(button.dataset.scenarioId));
    if (!scenario) return;
    restoringDraft = true;
    totalInput.value = scenario.total_votes;
    state.totalVotes = Number(scenario.total_votes);
    state.threshold = state.totalVotes * 0.05;
    state.coefficient = state.totalVotes / 19;
    thresholdEl.textContent = fmtNum(state.threshold);
    coefficientEl.textContent = fmtNum(state.coefficient, 4);
    state.votes = { fln: Number(scenario.votes.fln), fm: Number(scenario.votes.fm), msp: Number(scenario.votes.msp) };
    for (const key of Object.keys(PARTY_NAMES)) document.querySelector(`[data-votes="${key}"]`).textContent = fmtNum(state.votes[key], 0);
    restoringDraft = false;
    resetResults(); updateConfirmState(); scheduleDraftSave();
    const status = document.getElementById('draftStatus');
    if (status) status.textContent = 'تم استرجاع الأرقام؛ التعديل والحساب سيحفظان كعملية جديدة للحفاظ على السجل الأصلي';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
}
