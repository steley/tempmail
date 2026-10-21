/**
 * TempMail.cc — 2026 frontend refresh (vanilla JS, no jQuery/Semantic UI)
 * Socket protocol kept identical to forsaken-mail:
 *   emit: 'request shortid' | 'set shortid'
 *   on:   'shortid' (id)  |  'mail' ({ html, text, headers })
 */

(function () {
  'use strict';

  // PWA: register the service worker (root pages only; the SW handles all
  // caching itself, this is just the bootstrap)
  if ('serviceWorker' in navigator && location.pathname === '/') {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* non-fatal */ });
  }

  var $shortid = document.getElementById('shortid');
  var $copyBtn = document.getElementById('copyBtn');
  var $copyToast = document.getElementById('copyToast');
  var $refresh = document.getElementById('refreshShortid');
  var $edit = document.getElementById('editShortid');
  var $maillist = document.getElementById('maillist');
  var $empty = document.getElementById('emptyState');
  var $mailcard = document.getElementById('mailcard');
  var $mailSubject = document.getElementById('mailSubject');
  var $mailFrom = document.getElementById('mailFrom');
  var $mailFrame = document.getElementById('mailFrame');
  var $viewRaw = document.getElementById('viewRaw');
  var $deleteMail = document.getElementById('deleteMail');
  var $closeMail = document.getElementById('closeMail');
  var $raw = document.getElementById('raw');
  var $rawContent = document.getElementById('rawContent');
  var $statusDot = document.getElementById('statusDot');
  var $statusText = document.getElementById('statusText');
  var $recoverBtn = document.getElementById('recoverBtn');
  var $emptyHint = document.getElementById('emptyHint');
  var $emptyTitle = document.querySelector('.empty-title');
  var mails = [];       // keep full mail objects (each has a store-assigned _id)
  var currentMailId = null; // _id of the mail open in the viewer
  var currentId = null; // last mailbox name acked by the server
  var editing = false;
  var autoClaim = false; // true while restoring the saved mailbox on connect
  var localId = 0;      // fallback ids for mails that arrive without one

  // find a mail's array index by its id
  function idxOf(id) {
    if (id == null) return -1;
    for (var i = 0; i < mails.length; i++) {
      if (mails[i]._id === id) return i;
    }
    return -1;
  }

  /* ---------- helpers ---------- */

  // user-facing text comes from the server (errors.js catalog) so there is one
  // copy of it; this is only the fallback for a payload without a message
  var GENERIC_ERROR = 'Something went wrong on our side. Please try again.';

  function setStatus(cls, text) {
    $statusDot.className = 'conn-status ' + cls;
    $statusText.textContent = text;
  }

  function setMailAddress(id) {
    currentId = id;
    try { localStorage.setItem('shortid', id); } catch (e) { /* private mode */ }
    var full = id + '@' + location.hostname;
    $shortid.value = full;
    fitAddress();
    drawQR(full);
    resetEmptyHints();
  }

  // shrink the address font until it fits the visible width (single-line
  // input can't wrap; long hostnames overflow on narrow screens). One pass:
  // scale the current size by the overflow ratio instead of stepping down.
  function fitAddress() {
    if (editing || !$shortid.value) return;
    $shortid.style.fontSize = '';
    var size = parseFloat(getComputedStyle($shortid).fontSize);
    var width = $shortid.scrollWidth;
    if (width > $shortid.clientWidth) {
      $shortid.style.fontSize = Math.max(9, Math.floor(size * $shortid.clientWidth / width)) + 'px';
    }
  }
  window.addEventListener('resize', fitAddress);

  /* ---------- QR code ---------- */

  function drawQR(text) {
    var canvas = document.getElementById('qrCanvas');
    if (!canvas || !window.qrcode || !text) return;
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      var ctx = canvas.getContext('2d');
      var count = qr.getModuleCount();
      var quiet = 2; // 每侧 2 模块，外围白边由卡片白底补足
      var scale = Math.floor(120 / (count + quiet * 2));
      var size = (count + quiet * 2) * scale; // 画布随内容收紧，不留多余白边
      canvas.width = size;
      canvas.height = size;
      var offset = quiet * scale;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#17202a';
      for (var r = 0; r < count; r++) {
        for (var c = 0; c < count; c++) {
          if (qr.isDark(r, c)) ctx.fillRect(offset + c * scale, offset + r * scale, scale, scale);
        }
      }
    } catch (e) { /* QR 失败不影响主功能 */ }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDate(d) {
    var t = new Date(d);
    if (isNaN(t)) return '';
    var now = new Date();
    var sameDay = t.getFullYear() === now.getFullYear() &&
      t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
    if (sameDay) return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return t.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function showToast() {
    $copyToast.classList.add('show');
    setTimeout(function () { $copyToast.classList.remove('show'); }, 1400);
  }

  // 复制成功后短暂显示 ✓（两个图标都在 HTML 里，切换 class 即可）
  var iconTimer = null;
  function flashCopyIcon() {
    var btn = $copyBtn;
    if (iconTimer) clearTimeout(iconTimer);
    btn.classList.add('copied');
    iconTimer = setTimeout(function () {
      btn.classList.remove('copied');
      iconTimer = null;
    }, 1400);
  }

  /* ---------- clipboard ---------- */

  $copyBtn.addEventListener('click', function () {
    var text = $shortid.value;
    if (!text) return;
    function done() { showToast(); flashCopyIcon(); }
    function fallback() {
      $shortid.removeAttribute('disabled');
      $shortid.select();
      try { document.execCommand('copy'); } catch (e) {}
      $shortid.blur();
      if (!editing) $shortid.setAttribute('disabled', '');
      done();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  });

  /* ---------- address controls ---------- */

  function exitEdit() {
    editing = false;
    $shortid.setAttribute('disabled', '');
    $shortid.placeholder = 'Loading ...';
    var saved = null;
    try { saved = localStorage.getItem('shortid'); } catch (e) {}
    // fall back to whatever was on screen before editing started — a first-time
    // visitor has no saved name, only the one painted before the socket opened
    var restore = saved || pendingName;
    if (restore) $shortid.value = restore + '@' + location.hostname;
    fitAddress();
    if (restore) drawQR(restore + '@' + location.hostname);
  }

  $refresh.addEventListener('click', function () {
    socket.emit('request shortid', clientToken);
  });

  $edit.addEventListener('click', function () {
    if (!editing) {
      editing = true;
      $shortid.removeAttribute('disabled');
      $shortid.style.fontSize = ''; // back to the 16px editing size (iOS zoom)
      $shortid.value = '';
      $shortid.placeholder = 'Enter name without @' + location.hostname;
      $shortid.focus();
      return;
    }
    var name = ($shortid.value || '').trim().split('@')[0];
    if (!name) {
      exitEdit();  // empty input -> revert to current address
      return;
    }
    editing = false;
    $shortid.setAttribute('disabled', '');
    $shortid.placeholder = 'Loading ...';
    socket.emit('set shortid', name, clientToken);   // no page reload needed; UI updates on server ack
  });

  $shortid.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $edit.click(); }
    if (e.key === 'Escape') exitEdit();
  });

  /* ---------- empty-state hints (staged diagnostics) ---------- */

  // An empty inbox is not just "no mail yet" — as time passes without a
  // delivery, tell the user what is most likely going on instead of leaving
  // them refreshing blindly.
  var hintTimer1 = null, hintTimer2 = null;

  function clearEmptyHints() {
    if (hintTimer1) { clearTimeout(hintTimer1); hintTimer1 = null; }
    if (hintTimer2) { clearTimeout(hintTimer2); hintTimer2 = null; }
    if ($emptyHint) { $emptyHint.hidden = true; $emptyHint.textContent = ''; }
    if ($emptyTitle) $emptyTitle.textContent = 'Waiting for your first email…';
  }

  function resetEmptyHints() {
    clearEmptyHints();
    if ($maillist.children.length === 0 && $empty.style.display !== 'none') {
      hintTimer1 = setTimeout(function () {
        if ($maillist.children.length) return;
        $emptyHint.textContent = 'Still nothing? Double-check the address above was copied completely — some sites take a minute or two to send.';
        $emptyHint.hidden = false;
      }, 20000);
      hintTimer2 = setTimeout(function () {
        if ($maillist.children.length) return;
        $emptyHint.textContent = 'No mail after a few minutes? Many sites block disposable email addresses — that block happens on their side, not here. Try another site, or set a custom address.';
        $emptyHint.hidden = false;
      }, 60000);
    }
  }

  /* ---------- recovery link ---------- */

  // A high-entropy token the server hands out per mailbox; opening
  // /?r=TOKEN reclaims that mailbox (with its buffered mail) until it expires.
  var recoveryToken = null;
  var recoveryExp = 0;

  function updateRecoverBtn() {
    var alive = recoveryToken && (!recoveryExp || recoveryExp > Date.now());
    $recoverBtn.hidden = !alive;
  }

  function saveRecovery() {
    try {
      if (recoveryToken) {
        localStorage.setItem('recovery', JSON.stringify({ token: recoveryToken, exp: recoveryExp }));
      } else {
        localStorage.removeItem('recovery');
      }
    } catch (e) { /* private mode */ }
    updateRecoverBtn();
  }

  $recoverBtn.addEventListener('click', function () {
    if (!recoveryToken) return;
    var link = location.origin + '/?r=' + recoveryToken;
    function done() { showToast(); }
    function fallback() {
      // clipboard API unavailable (http / old browser): prompt survives
      window.prompt('Copy this recovery link:', link);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, fallback);
    } else {
      fallback();
    }
  });

  /* ---------- mail list & view ---------- */

  function openMail(id) {
    var idx = idxOf(id);
    var mail = mails[idx];
    if (!mail) return;
    currentMailId = id;
    $mailSubject.textContent = (mail.headers && mail.headers.subject) || 'No Subject';
    $mailFrom.textContent = 'From: ' + ((mail.headers && mail.headers.from) || 'unknown') +
      ' · ' + formatDate(mail.headers && mail.headers.date);

    // unhide BEFORE loading content: WebKit does not render documents that
    // start loading inside a display:none subtree — the card must be visible
    // when the iframe navigation begins
    $mailcard.hidden = false;
    $empty.style.display = 'none';
    $mailcard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // render inside a sandboxed iframe: scripts/plugins blocked
    var html = mail.html || ('<pre style="white-space:pre-wrap;font:13px/1.5 monospace;padding:16px;">' +
      escapeHtml(mail.text || '(empty message)') + '</pre>');
    $mailFrame.setAttribute('sandbox', 'allow-popups'); // deliberately no allow-scripts
    // force a real navigation: WebKit (Safari) shows a BLANK document when
    // srcdoc is (re-)assigned on an iframe that was display:none — e.g. after
    // collapse/reopen or while the card was hidden. removeAttribute makes the
    // next srcdoc assignment always a fresh load, on every engine.
    $mailFrame.removeAttribute('srcdoc');
    $mailFrame.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<base target="_blank"><style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#17202a;margin:16px;word-break:break-word}img{max-width:100%}</style>' +
      '</head><body>' + html + '</body></html>';

    var items = $maillist.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', +items[i].dataset.mailId === id); // list is newest-first
    }
  }

  function closeMail() {
    $mailcard.hidden = true;
    currentMailId = null;
    var items = $maillist.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
    if ($maillist.children.length === 0) { $empty.style.display = ''; resetEmptyHints(); }
  }

  $closeMail.addEventListener('click', closeMail);

  $viewRaw.addEventListener('click', function () {
    var idx = idxOf(currentMailId);
    if (idx < 0 || !mails[idx]) return;
    $rawContent.textContent = JSON.stringify(mails[idx], null, 2);
    $raw.hidden = false;
    if (window.Prism) Prism.highlightElement($rawContent);
  });

  // manual delete: ask the server (which owns the replay buffer) to remove
  // this mail; every tab on the mailbox removes it on 'mail deleted'
  $deleteMail.addEventListener('click', function () {
    if (currentMailId == null) return;
    socket.emit('delete mail', currentMailId, function (res) {
      if (!res || !res.ok) setStatus('error', 'Could not delete this email. Please try again.');
    });
  });

  $raw.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-close]')) $raw.hidden = true;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$raw.hidden) $raw.hidden = true;
  });

  /* ---------- first paint ---------- */

  // The address used to appear only after 'request shortid' came back — the
  // page's largest element sat empty for a whole round trip. Render one
  // immediately instead: the saved name when there is one, otherwise a locally
  // generated name that the server confirms on connect (and silently swaps if
  // it happens to be taken). Same alphabet as src/lib/id.js so names look
  // identical no matter which side produced them.
  var pendingName = null;

  function randomMailboxName(len) {
    var A = 'abcdefghjkmnpqrstuvwxyz23456789';
    var base = A.length;                       // 31
    var limit = Math.floor(256 / base) * base; // 248: discard the biased tail
    var out = '';
    var buf = new Uint8Array(len + 8);
    while (out.length < len) {
      crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length && out.length < len; i++) {
        if (buf[i] < limit) out += A[buf[i] % base];
      }
    }
    return out;
  }

  (function primeAddress() {
    if (!window.crypto || !crypto.getRandomValues) return; // no CSPRNG: keep the loading state
    var saved = null;
    try { saved = localStorage.getItem('shortid'); } catch (e) {}
    if (!saved) pendingName = randomMailboxName(8);
    var full = (saved || pendingName) + '@' + location.hostname;
    $shortid.value = full;
    fitAddress();
    drawQR(full);
  })();

  /* ---------- socket ---------- */

  // per-tab claim token, kept in sessionStorage (NOT localStorage):
  // two tabs sharing one token would each auto-claim the same address on
  // reconnect and kick each other in an endless reconnect loop. sessionStorage
  // still survives reloads and tab restores — the case the token exists for.
  // After a full browser restart the mailbox is free anyway (the server reaps
  // dead sockets in ~25s), so a per-tab token loses nothing.
  var clientToken = null;
  try {
    clientToken = sessionStorage.getItem('shortid_token');
    if (!clientToken) {
      clientToken = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : Date.now() + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      sessionStorage.setItem('shortid_token', clientToken);
    }
  } catch (e) { clientToken = null; /* private mode: reclaim just won't work */ }

  // try WebSocket first (saves the polling handshake round trips); fall back
  // to polling if WS is blocked by a strict network
  var socket = io({ transports: ['websocket', 'polling'] });

  // recovery token: ?r=TOKEN in the URL wins (link from another device /
  // saved bookmark); otherwise fall back to the one saved in localStorage.
  // The parameter is stripped from the address bar immediately so the user
  // doesn't reshare a page URL containing the token.
  var urlRecovery = null;
  try {
    var url = new URL(location.href);
    urlRecovery = url.searchParams.get('r');
    if (urlRecovery) {
      url.searchParams.delete('r');
      history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
    } else {
      var savedRec = JSON.parse(localStorage.getItem('recovery') || 'null');
      if (savedRec && savedRec.token && (!savedRec.exp || savedRec.exp > Date.now())) {
        recoveryToken = savedRec.token;
        recoveryExp = savedRec.exp || 0;
        updateRecoverBtn();
      }
    }
  } catch (e) { /* malformed URL / private mode */ }

  socket.on('connect', function () {
    // don't claim "Connected" yet — the address still needs a server round
    // trip (allocate/reclaim) before it shows up; report that honestly
    setStatus('connecting', 'Syncing mailbox…');
    var shortid = null;
    try { shortid = localStorage.getItem('shortid'); } catch (e) {}
    if (urlRecovery) {
      // ?r= link: recover even if localStorage knows another address.
      // Consume it — later reconnects use the stored token path instead.
      autoClaim = true;
      socket.emit('recover', urlRecovery, clientToken);
      recoveryToken = urlRecovery; // shown immediately; 'recovery' event confirms with an expiry
      urlRecovery = null;
    } else if (shortid) {
      autoClaim = true;
      socket.emit('set shortid', shortid, clientToken);
    } else if (recoveryToken) {
      // storage says "fresh browser" but we still hold a live recovery token
      autoClaim = true;
      socket.emit('recover', recoveryToken, clientToken);
    } else if (pendingName) {
      // the name already rendered on first paint — claim that one instead of
      // asking for a new one. A taken name falls through to the auto-claim
      // fallback in 'shortid rejected' below.
      autoClaim = true;
      socket.emit('set shortid', pendingName, clientToken);
    } else {
      socket.emit('request shortid', clientToken);
    }
  });

  socket.on('recovery', function (data) {
    if (!data || !data.token) return;
    recoveryToken = data.token;
    recoveryExp = data.expiresAt || 0;
    saveRecovery();
  });

  socket.on('recovery rejected', function () {
    // expired/invalid token — forget it and fall back to a fresh mailbox
    urlRecovery = null;
    recoveryToken = null;
    recoveryExp = 0;
    saveRecovery();
    autoClaim = true;
    socket.emit('request shortid', clientToken);
  });

  socket.on('disconnect', function () {
    setStatus('disconnected', 'Disconnected — reconnecting…');
  });

  socket.on('shortid', function (id) {
    autoClaim = false;
    pendingName = null; // server owns the name now
    setMailAddress(id);
    setStatus('connected', 'Connected — live inbox active');
  });

  // server instance id, sent with every claim. A change means the server was
  // restarted: its in-memory store (and mail ids) are gone, so keep no local
  // state that references the previous generation — otherwise id collisions
  // with the fresh store would break opens and deletes.
  var serverBoot = null;
  socket.on('boot', function (data) {
    var id = data && data.id;
    if (!id) return;
    if (serverBoot && serverBoot !== id) {
      mails = [];
      currentMailId = null;
      $mailcard.hidden = true;
      $maillist.innerHTML = '';
      if ($maillist.children.length === 0) { $empty.style.display = ''; resetEmptyHints(); }
    }
    serverBoot = id;
  });

  socket.on('shortid rejected', function (data) {
    var wasAuto = autoClaim;
    autoClaim = false;

    // stale restore or a first-paint name the server won't take: fall back to
    // a server-allocated mailbox instead of leaving the user on a dead address
    if (data && wasAuto && (data.code === 'E_SHORTID_TAKEN' || data.code === 'E_SHORTID_RESERVED')) {
      try { localStorage.removeItem('shortid'); } catch (e) {}
      pendingName = null;
      $shortid.placeholder = 'Loading ...';
      socket.emit('request shortid', clientToken);
      return;
    }

    // message text is the server's (single source of truth)
    setStatus('error', (data && data.message) || GENERIC_ERROR);
    // revert display to the address we actually hold (localStorage was never updated)
    try {
      var saved = localStorage.getItem('shortid');
      if (saved) $shortid.value = saved + '@' + location.hostname;
      else if (currentId) $shortid.value = currentId + '@' + location.hostname;
      fitAddress();
    } catch (e) { /* private mode */ }
  });

  socket.on('server error', function (data) {
    var text = (data && data.message) || GENERIC_ERROR;
    if (data && data.code) text += ' [' + data.code + ']';
    setStatus('error', text);
  });

  function addMail(mail, notify) {
    if (!mail || !mail.headers) return;
    // id safety net: a server restarted under this open tab assigns fresh ids
    // and mails kept from before the restart have none — give them a local
    // one so they stay openable (server-side delete just won't find them)
    if (mail._id == null) mail._id = 'c' + (++localId);
    // dedup: a reconnect replays 'mail history' — don't add the same mail twice
    if (idxOf(mail._id) !== -1) return;
    // browser notification (suppressed for history replay)
    if (notify && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification('New mail from ' + (mail.headers && mail.headers.from));
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission(function (permission) {
          if (permission === 'granted') {
            new Notification('New mail from ' + (mail.headers && mail.headers.from));
          }
        });
      }
    }

    mails.push(mail);
    // cap: keep the newest 50 — long-open tabs must not grow without bound
    if (mails.length > 50) {
      mails.shift();
      var list = $maillist.querySelectorAll('li');
      if (list.length) list[list.length - 1].remove(); // oldest is last (newest-first list)
    }
    // li carries the store-assigned _id, not an index — deletes never shift ids

    var li = document.createElement('li');
    li.dataset.mailId = mail._id;
    li.innerHTML =
      '<span class="from">' + escapeHtml(mail.headers && mail.headers.from) + '</span>' +
      '<span class="subject">' + escapeHtml((mail.headers && mail.headers.subject) || 'No Subject') + '</span>' +
      '<span class="time">' + escapeHtml(formatDate(mail.headers && mail.headers.date)) + '</span>';
    li.addEventListener('click', function () {
      // toggle: clicking the open mail collapses it, otherwise open it
      var id = +this.dataset.mailId;
      if (currentMailId === id && !$mailcard.hidden) closeMail();
      else openMail(id);
    });
    li.classList.add('new');
    li.addEventListener('animationend', function () { li.classList.remove('new'); }, { once: true });
    $maillist.prepend(li);
    $empty.style.display = 'none';
    clearEmptyHints();
  }

  socket.on('mail', function (mail) { addMail(mail, true); });

  // a mail was removed (manual delete) — sync every open tab on the mailbox
  socket.on('mail deleted', function (data) {
    var id = data && data.id;
    var idx = idxOf(id);
    if (idx === -1) return;
    mails.splice(idx, 1);
    var li = $maillist.querySelector('li[data-mail-id="' + id + '"]');
    if (li) li.remove();
    if (currentMailId === id) closeMail();
    if ($maillist.children.length === 0 && $mailcard.hidden) {
      $empty.style.display = '';
      resetEmptyHints();
    }
  });

  // mails that arrived while this browser was disconnected — the server keeps
  // a 30-minute in-memory buffer and flushes it once per claim
  socket.on('mail history', function (list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i++) addMail(list[i], false);
  });
})();
