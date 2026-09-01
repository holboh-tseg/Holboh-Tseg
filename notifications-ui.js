/* ============================================================================
   notifications-ui.js
   ----------------------------------------------------------------------------
   Turns the existing static bell button (.icon-btn[aria-label="Мэдэгдэл"])
   into a working notification dropdown. Include this AFTER your existing
   <script src="supabase-client.js"> tag on any page that has the bell —
   it reuses the same global `supabaseClient` object those pages already
   set up, so nothing else needs to change.

   Requires supabase_schema_notifications.sql to have been run once.
   ============================================================================ */
(function () {
  const TYPE_ICON = {
    application_confirmed: '✅',
    application_cancelled: '⚠️',
    certificate_issued: '🎓',
    new_applicant: '🙋',
    new_report: '🚩'
  };

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function timeAgo(iso) {
    const d = new Date(iso);
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'дөнгөж сая';
    if (mins < 60) return `${mins} мин өмнө`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} цаг өмнө`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} өдрийн өмнө`;
    return d.toLocaleDateString('mn-MN');
  }

  // ---------- data layer (talks directly to the shared supabaseClient) ----------

  async function getMyNotifications(userId, limit) {
    const { data, error } = await supabaseClient
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit || 20);
    if (error) { console.error(error); return []; }
    return data || [];
  }

  async function getUnreadCount(userId) {
    const { count, error } = await supabaseClient
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);
    if (error) { console.error(error); return 0; }
    return count || 0;
  }

  async function markRead(id) {
    const { error } = await supabaseClient
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id);
    if (error) console.error(error);
  }

  async function markAllRead(userId) {
    const { error } = await supabaseClient
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);
    if (error) console.error(error);
  }

  // ---------- rendering ----------

  function renderList(bodyEl, items) {
    if (!items.length) {
      bodyEl.innerHTML = `<div class="notif-empty">Одоогоор мэдэгдэл алга.</div>`;
      return;
    }
    bodyEl.innerHTML = `<ul class="notif-list">${items.map(n => `
      <li>
        <button type="button" class="notif-item ${n.is_read ? '' : 'is-unread'}" data-id="${n.id}" data-link="${escapeHtml(n.link || '')}">
          <p class="notif-item-title">${TYPE_ICON[n.type] || '🔔'} ${escapeHtml(n.title)}</p>
          ${n.body ? `<p class="notif-item-body">${escapeHtml(n.body)}</p>` : ''}
          <span class="notif-item-time">${timeAgo(n.created_at)}</span>
        </button>
      </li>`).join('')}</ul>`;
  }

  // ---------- bell wiring ----------

  function buildPanel() {
    const panel = document.createElement('div');
    panel.className = 'notif-panel';
    panel.innerHTML = `
      <div class="notif-panel-head">
        <h4>Мэдэгдэл</h4>
        <button type="button" class="notif-mark-all">Бүгдийг уншсан гэж тэмдэглэх</button>
      </div>
      <div class="notif-panel-body"><div class="notif-loading">Ачааллаж байна…</div></div>
    `;
    return panel;
  }

  function initBell(btn, userId) {
    // Wrap the button so the dropdown has a positioned ancestor, without
    // nesting interactive elements inside the <button> itself.
    const wrap = document.createElement('span');
    wrap.className = 'notif-wrap';
    btn.parentNode.insertBefore(wrap, btn);
    wrap.appendChild(btn);

    const dot = btn.querySelector('.notif-dot');
    const panel = buildPanel();
    wrap.appendChild(panel);

    const body = panel.querySelector('.notif-panel-body');
    const markAllBtn = panel.querySelector('.notif-mark-all');

    async function refreshBadge() {
      const count = await getUnreadCount(userId);
      if (dot) {
        dot.textContent = count > 9 ? '9+' : (count > 0 ? String(count) : '');
        dot.classList.toggle('is-unread', count > 0);
      }
    }

    async function loadList() {
      body.innerHTML = `<div class="notif-loading">Ачааллаж байна…</div>`;
      renderList(body, await getMyNotifications(userId, 20));
    }

    function open() { panel.classList.add('is-open'); loadList(); }
    function close() { panel.classList.remove('is-open'); }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.contains('is-open') ? close() : open();
    });

    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });

    body.addEventListener('click', async (e) => {
      const item = e.target.closest('.notif-item');
      if (!item) return;
      const id = item.dataset.id;
      const link = item.dataset.link;
      if (item.classList.contains('is-unread')) {
        item.classList.remove('is-unread');
        await markRead(id);
        refreshBadge();
      }
      if (link) window.location.href = link;
    });

    markAllBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await markAllRead(userId);
      refreshBadge();
      loadList();
    });

    refreshBadge();

    // Live badge updates via Supabase Realtime — falls back to silent
    // no-op if realtime isn't enabled on the table yet.
    try {
      supabaseClient
        .channel('notifications-' + userId)
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
          () => refreshBadge()
        )
        .subscribe();
    } catch (err) {
      console.warn('Realtime notifications unavailable:', err);
    }
  }

  async function boot() {
    const btn = document.querySelector('.icon-btn[aria-label="Мэдэгдэл"]');
    if (!btn || typeof supabaseClient === 'undefined') return;

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    initBell(btn, user.id);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
