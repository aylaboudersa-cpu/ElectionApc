const PARTY_NAMES = {
  fln: '01 حزب جبهة التحرير الوطني',
  fm: '03 حزب جبهة المستقبل',
  msp: '05 حزب حركة مجتمع السلم'
};
const PARTY_KEYS = ['fln', 'fm', 'msp'];
const state = { scenarios: [], scenarioId: '', lists: {}, allocation: null };
let memberSaveTimer = null;
let memberSaveChain = Promise.resolve();
let memberSavePending = false;
const $ = id => document.getElementById(id);
const fmt = n => Number(n || 0).toLocaleString('ar-DZ');

fetch('/api/me').then(r => {
  if (!r.ok) throw new Error('unauthorized');
  return r.json();
}).then(d => { $('currentUser').textContent = d.user.username; loadScenarios(); })
  .catch(() => { window.location.href = '/'; });

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
});

async function loadScenarios() {
  const res = await fetch('/api/scenarios');
  if (!res.ok) { $('scenarioSelect').innerHTML = '<option value="">تعذر تحميل العمليات</option>'; return; }
  const data = await res.json();
  state.scenarios = data.scenarios || [];
  if (!state.scenarios.length) {
    $('scenarioSelect').innerHTML = '<option value="">لا توجد عمليات محفوظة — احسب المقاعد أولاً</option>';
    $('partySelect').disabled = true;
    return;
  }
  $('scenarioSelect').innerHTML = '<option value="">اختر العملية الانتخابية</option>' + state.scenarios.map(s =>
    `<option value="${s.id}">عملية #${s.id} — ${new Date(s.created_at).toLocaleString('ar-DZ')} — ${fmt(s.total_votes)} صوت</option>`
  ).join('');
  $('scenarioSelect').value = String(state.scenarios[0].id);
  state.scenarioId = String(state.scenarios[0].id);
  $('partySelect').disabled = false;
  await loadWorkspace();
}

$('scenarioSelect').addEventListener('change', async e => {
  state.scenarioId = e.target.value;
  await loadWorkspace();
});
$('partySelect').addEventListener('change', renderMemberInputs);

function currentMemberSnapshot() {
  return Array.from({ length: 26 }, (_, i) => {
    const no = i + 1;
    const input = document.querySelector(`.member-votes-input[data-member="${no}"]`);
    const raw = input ? input.value.trim() : '';
    return { memberNo: no, votes: raw === '' ? null : Number(raw) };
  });
}

function queueMemberAutosave() {
  const partyKey = $('partySelect').value;
  const scenarioId = state.scenarioId;
  const memberVotes = currentMemberSnapshot();
  clearTimeout(memberSaveTimer);
  memberSavePending = true;
  $('saveStatus').textContent = 'توجد تغييرات — جارٍ الحفظ تلقائياً';
  $('saveStatus').className = 'badge warn';
  memberSaveTimer = setTimeout(() => persistMemberList(partyKey, memberVotes, true, scenarioId), 500);
}

function persistMemberList(partyKey, memberVotes, automatic = false, scenarioId = state.scenarioId) {
  memberSavePending = true;
  memberSaveChain = memberSaveChain.then(async () => {
    const res = await fetch('/api/member-votes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: Number(scenarioId), partyKey, memberVotes })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذر حفظ البيانات');
    return data;
  }).then(async () => {
    memberSavePending = false;
    if (String(state.scenarioId) === String(scenarioId)) {
      const refresh = await fetch(`/api/member-workspace/${encodeURIComponent(scenarioId)}`);
      const workspace = await refresh.json();
      if (refresh.ok) {
        state.lists = workspace.lists || {};
        state.allocation = workspace.allocation;
        renderAllocation(workspace);
        if ($('partySelect').value === partyKey) {
          const saved = state.lists[partyKey] || [];
          const complete = saved.length === 26 && saved.every(x => x.votes !== null && Number.isSafeInteger(Number(x.votes)) && Number(x.votes) >= 0);
          $('saveStatus').textContent = complete ? 'تم حفظ القائمة بالكامل في قاعدة البيانات' : 'تم حفظ المسودة في قاعدة البيانات — يمكنك إكمالها لاحقاً';
          $('saveStatus').className = complete ? 'badge ok' : 'badge warn';
        }
      }
    }
  }).catch(err => {
    memberSavePending = false;
    $('saveStatus').textContent = err.message;
    $('saveStatus').className = 'badge warn';
    if (!automatic) alert(err.message);
  });
  return memberSaveChain;
}

$('membersGrid').addEventListener('input', e => {
  if (e.target.matches('.member-votes-input')) queueMemberAutosave();
});

async function loadWorkspace() {
  if (!state.scenarioId) {
    $('partySelect').disabled = true;
    $('membersGrid').innerHTML = '';
    $('seatInfo').textContent = 'اختر العملية الانتخابية لعرض عدد المقاعد.';
    return;
  }
  const res = await fetch(`/api/member-workspace/${encodeURIComponent(state.scenarioId)}`);
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'تعذر تحميل البيانات'); return; }
  state.lists = data.lists || {};
  state.allocation = data.allocation;
  const result = data.scenario.results || {};
  $('seatInfo').innerHTML = PARTY_KEYS.map(key =>
    `<span><b>${PARTY_NAMES[key]}</b>: ${fmt(result[key]?.seats)} مقعد</span>`
  ).join('');
  renderMemberInputs();
  renderAllocation(data);
}

function renderMemberInputs() {
  const key = $('partySelect').value;
  $('selectedPartyTitle').textContent = PARTY_NAMES[key];
  const saved = state.lists[key] || [];
  const byNo = new Map(saved.map(x => [Number(x.memberNo), x.votes === null ? '' : Number(x.votes)]));
  $('membersGrid').innerHTML = Array.from({ length: 26 }, (_, i) => {
    const no = i + 1;
    const value = byNo.has(no) ? byNo.get(no) : '';
    return `<label class="member-input-card"><span class="member-id">${String(no).padStart(2, '0')}</span><span class="member-input-label">عدد الأصوات</span><input class="member-votes-input" type="number" min="0" step="1" inputmode="numeric" data-member="${no}" value="${value}" placeholder="0" aria-label="أصوات العضو ${String(no).padStart(2, '0')}"></label>`;
  }).join('');
  $('saveMembersBtn').disabled = !state.scenarioId;
  $('clearMembersBtn').disabled = !state.scenarioId;
  const complete = saved.length === 26 && saved.every(x => x.votes !== null && Number.isSafeInteger(Number(x.votes)) && Number(x.votes) >= 0);
  $('saveStatus').textContent = complete ? 'القائمة محفوظة بالكامل' : saved.length ? 'مسودة محفوظة — بعض الخانات فارغة' : 'لم تُدخل بيانات بعد';
  $('saveStatus').className = complete ? 'badge ok' : saved.length ? 'badge warn' : 'badge';
}

$('saveMembersBtn').addEventListener('click', async () => {
  clearTimeout(memberSaveTimer);
  const partyKey = $('partySelect').value;
  const scenarioId = state.scenarioId;
  const memberVotes = currentMemberSnapshot();
  const btn = $('saveMembersBtn');
  btn.disabled = true; btn.textContent = 'جاري الحفظ...';
  await persistMemberList(partyKey, memberVotes, false, scenarioId);
  btn.textContent = 'حفظ أصوات القائمة الآن'; btn.disabled = !state.scenarioId;
});

$('clearMembersBtn').addEventListener('click', () => {
  if (!confirm('هل تريد تفريغ جميع خانات هذه القائمة؟ سيتم حفظ الفراغات تلقائياً في قاعدة البيانات بعد التأكيد.')) return;
  document.querySelectorAll('.member-votes-input').forEach(input => input.value = '');
  queueMemberAutosave();
});

function renderAllocation(data) {
  const box = $('allocationResults');
  if (!data.allListsSaved || !data.allocation) {
    const status = PARTY_KEYS.map(key => {
      const savedList = data.lists[key];
      const complete = Array.isArray(savedList) && savedList.length === 26 && savedList.every(x => x.votes !== null && Number.isSafeInteger(Number(x.votes)) && Number(x.votes) >= 0);
      const started = Array.isArray(savedList) && savedList.length > 0;
      return `<span class="chip ${complete ? 'chip-done' : ''}">${PARTY_NAMES[key]}: ${complete ? 'مكتملة' : started ? 'مسودة محفوظة' : 'لم تبدأ'}</span>`;
    }).join('');
    $('completionStatus').textContent = 'القوائم غير مكتملة';
    $('completionStatus').className = 'badge warn';
    box.innerHTML = `<div class="completion-chips">${status}</div><p class="muted small">يظهر ترتيب الفائزين تلقائياً بعد حفظ جميع الأعضاء الـ26 في كل قائمة حزبية.</p>`;
    return;
  }
  $('completionStatus').textContent = 'اكتمل إدخال القوائم الثلاث';
  $('completionStatus').className = 'badge ok';
  box.innerHTML = PARTY_KEYS.map(key => {
    const item = data.allocation[key];
    const winners = new Set(item.winners);
    const rows = item.ranked.map((member, index) => `
      <tr class="${winners.has(Number(member.memberNo)) ? 'winner-row' : ''}">
        <td>${index + 1}</td>
        <td><strong>${String(member.memberNo).padStart(2, '0')}</strong></td>
        <td>${fmt(member.votes)}</td>
        <td>${winners.has(Number(member.memberNo)) ? '<span class="badge ok">فائز بمقعد</span>' : '<span class="muted">—</span>'}</td>
      </tr>`).join('');
    return `<article class="party-allocation"><div class="allocation-head"><h3>${PARTY_NAMES[key]}</h3><span class="chip">${fmt(item.seats)} مقعد</span></div>
      ${item.seats === 0 ? '<p class="muted small">هذا الحزب لم يحصل على مقاعد في العملية المحددة.</p>' : ''}
      ${item.tieAtCutoff ? '<p class="tie-warning">تنبيه: يوجد تعادل في الأصوات عند حد آخر مقعد. ترتيب التعادل الحالي مؤقت حسب الرقم التعريفي الأصغر.</p>' : ''}
      <div class="table-wrap"><table class="results-table member-ranking-table"><thead><tr><th>الترتيب</th><th>رقم العضو</th><th>الأصوات</th><th>النتيجة</th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
  }).join('') + '<p class="muted small">الترتيب تنازلي حسب عدد الأصوات. عند تساوي الأصوات، يُستخدم الرقم التعريفي الأصغر كفاصل مؤقت للترتيب.</p>';
}
