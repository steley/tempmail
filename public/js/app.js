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

  // activate the async-loaded prism stylesheet (CSP forbids inline onload
  // handlers, so the media flip happens here instead)
  var $prismCss = document.querySelector('link[href*="prism.css"]');
  if ($prismCss) $prismCss.media = 'all';

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
  var $closeMail = document.getElementById('closeMail');
  var $raw = document.getElementById('raw');
  var $rawContent = document.getElementById('rawContent');
  var $statusDot = document.getElementById('statusDot');
  var $statusText = document.getElementById('statusText');
  var $copyIcon = document.getElementById('copyIcon');
  var copyIconHTML = $copyIcon ? $copyIcon.outerHTML : '';

  var mails = [];       // keep full mail objects by index
  var currentMail = -1;
  var currentId = null; // last mailbox name acked by the server
  var editing = false;
  var autoClaim = false; // true while restoring the saved mailbox on connect

  /* ---------- helpers ---------- */

  // canonical code -> user message; unknown codes fall back to E_INTERNAL,
  // so the server can ship new codes without waiting for this file
  var ERROR_MESSAGES = {
    E_NOT_FOUND: 'The page you are looking for does not exist or has moved.',
    E_INTERNAL: 'Something went wrong on our side. Please try again.',
    E_RATE_LIMITED: 'Too many messages — some deliveries to this inbox were dropped for a minute.',
    E_SHORTID_INVALID: 'Invalid name — use 1-32 letters, digits, . _ -',
    E_SHORTID_RESERVED: 'That name is reserved — pick another',
    E_SHORTID_TAKEN: 'That address is being used by someone else — pick another'
  };

  function messageForCode(code) {
    return ERROR_MESSAGES[code] || ERROR_MESSAGES.E_INTERNAL;
  }

  function setStatus(cls, text) {
    $statusDot.className = 'conn-status ' + cls;
    $statusText.textContent = text;
  }

  function setMailAddress(id) {
    currentId = id;
    try { localStorage.setItem('shortid', id); } catch (e) { /* private mode */ }
    var full = id + '@' + location.hostname;
    $shortid.value = full;
    drawQR(full);
  }

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

  // 复制成功后图标短暂变 ✓，1.4s 后还原
  var iconTimer = null;
  function flashCopyIcon() {
    if (!$copyIcon) return;
    if (iconTimer) clearTimeout(iconTimer);
    $copyIcon.outerHTML =
      '<svg id="copyIcon" class="copy-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    $copyIcon = document.getElementById('copyIcon');
    iconTimer = setTimeout(function () {
      $copyIcon.outerHTML = copyIconHTML;
      $copyIcon = document.getElementById('copyIcon');
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
    if (saved) $shortid.value = saved + '@' + location.hostname;
  }

  $refresh.addEventListener('click', function () {
    socket.emit('request shortid', clientToken);
  });

  $edit.addEventListener('click', function () {
    if (!editing) {
      editing = true;
      $shortid.removeAttribute('disabled');
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

  /* ---------- mail list & view ---------- */

  function openMail(idx) {
    var mail = mails[idx];
    if (!mail) return;
    currentMail = idx;
    $mailSubject.textContent = (mail.headers && mail.headers.subject) || 'No Subject';
    $mailFrom.textContent = 'From: ' + ((mail.headers && mail.headers.from) || 'unknown') +
      ' · ' + formatDate(mail.headers && mail.headers.date);

    // render inside a sandboxed iframe: scripts/plugins blocked
    var html = mail.html || ('<pre style="white-space:pre-wrap;font:13px/1.5 monospace;padding:16px;">' +
      escapeHtml(mail.text || '(empty message)') + '</pre>');
    $mailFrame.setAttribute('sandbox', 'allow-popups'); // deliberately no allow-scripts
    $mailFrame.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<base target="_blank"><style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#17202a;margin:16px;word-break:break-word}img{max-width:100%}</style>' +
      '</head><body>' + html + '</body></html>';

    $mailcard.hidden = false;
    $empty.style.display = 'none';
    $mailcard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    var items = $maillist.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items.length - 1 - i === idx); // list is newest-first
    }
  }

  function closeMail() {
    $mailcard.hidden = true;
    currentMail = -1;
    var items = $maillist.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
    if ($maillist.children.length === 0) $empty.style.display = '';
  }

  $closeMail.addEventListener('click', closeMail);

  $viewRaw.addEventListener('click', function () {
    if (currentMail < 0 || !mails[currentMail]) return;
    $rawContent.textContent = JSON.stringify(mails[currentMail], null, 2);
    $raw.hidden = false;
    if (window.Prism) Prism.highlightElement($rawContent);
  });

  $raw.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-close]')) $raw.hidden = true;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$raw.hidden) $raw.hidden = true;
  });

  /* ---------- socket ---------- */

  // persistent per-browser token: lets the server tell "this same tab/browser
  // reconnecting" apart from "a stranger" when reclaiming a mailbox after a
  // transport drop — otherwise a zombie socket holds the name for ~25s and the
  // client silently falls back to a brand-new address (the disappearing-inbox bug)
  var clientToken = null;
  try {
    clientToken = localStorage.getItem('shortid_token');
    if (!clientToken) {
      clientToken = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : Date.now() + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      localStorage.setItem('shortid_token', clientToken);
    }
  } catch (e) { clientToken = null; /* private mode: reclaim just won't work */ }

  // try WebSocket first (saves the polling handshake round trips); fall back
  // to polling if WS is blocked by a strict network
  var socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', function () {
    // don't claim "Connected" yet — the address still needs a server round
    // trip (allocate/reclaim) before it shows up; report that honestly
    setStatus('connecting', 'Syncing mailbox…');
    var shortid = null;
    try { shortid = localStorage.getItem('shortid'); } catch (e) {}
    if (shortid) {
      autoClaim = true;
      socket.emit('set shortid', shortid, clientToken);
    } else {
      socket.emit('request shortid', clientToken);
    }
  });

  socket.on('disconnect', function () {
    setStatus('disconnected', 'Disconnected — reconnecting…');
  });

  socket.on('shortid', function (id) {
    autoClaim = false;
    setMailAddress(id);
    setStatus('connected', 'Connected — live inbox active');
  });

  socket.on('shortid rejected', function (data) {
    var wasAuto = autoClaim;
    autoClaim = false;
    var reason = data && data.reason;
    var code = (data && data.code) || null;

    // stale restore: saved address is now held by someone else (or a zombie
    // socket from before the reload) — silently fall back to a fresh mailbox
    if (reason === 'taken' && wasAuto) {
      try { localStorage.removeItem('shortid'); } catch (e) {}
      socket.emit('request shortid', true);
      return;
    }

    // prefer the canonical code; fall back to the legacy reason field
    var message = code
      ? messageForCode(code)
      : reason === 'taken'
        ? messageForCode('E_SHORTID_TAKEN')
        : reason === 'reserved'
          ? messageForCode('E_SHORTID_RESERVED')
          : messageForCode('E_SHORTID_INVALID');
    setStatus('error', message);
    // revert display to the address we actually hold (localStorage was never updated)
    try {
      var saved = localStorage.getItem('shortid');
      if (saved) $shortid.value = saved + '@' + location.hostname;
      else if (currentId) $shortid.value = currentId + '@' + location.hostname;
    } catch (e) { /* private mode */ }
  });

  socket.on('server error', function (data) {
    var code = data && data.code;
    var text = messageForCode(code);
    if (code) text += ' [' + code + ']';
    setStatus('error', text);
  });

  socket.on('mail', function (mail) {
    // browser notification
    if ('Notification' in window) {
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
      if (currentMail > -1) currentMail--;
      if (currentMail < 0) closeMail();
    }
    var idx = mails.length - 1;

    var li = document.createElement('li');
    li.innerHTML =
      '<span class="from">' + escapeHtml(mail.headers && mail.headers.from) + '</span>' +
      '<span class="subject">' + escapeHtml((mail.headers && mail.headers.subject) || 'No Subject') + '</span>' +
      '<span class="time">' + escapeHtml(formatDate(mail.headers && mail.headers.date)) + '</span>';
    li.addEventListener('click', function () { openMail(idx); });
    li.classList.add('new');
    li.addEventListener('animationend', function () { li.classList.remove('new'); }, { once: true });
    $maillist.prepend(li);
    $empty.style.display = 'none';
  });
})();
