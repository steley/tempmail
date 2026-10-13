/**
 * TempMail.cc — 2026 frontend refresh (vanilla JS, no jQuery/Semantic UI)
 * Socket protocol kept identical to forsaken-mail:
 *   emit: 'request shortid' | 'set shortid'
 *   on:   'shortid' (id)  |  'mail' ({ html, text, headers })
 */

(function () {
  'use strict';

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

  var mails = [];       // keep full mail objects by index
  var currentMail = -1;
  var currentId = null; // last mailbox name acked by the server
  var editing = false;

  /* ---------- helpers ---------- */

  function setStatus(cls, text) {
    $statusDot.className = 'conn-status ' + cls;
    $statusText.textContent = text;
  }

  function setMailAddress(id) {
    currentId = id;
    try { localStorage.setItem('shortid', id); } catch (e) { /* private mode */ }
    $shortid.value = id + '@' + location.hostname;
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

  /* ---------- clipboard ---------- */

  $copyBtn.addEventListener('click', function () {
    var text = $shortid.value;
    if (!text) return;
    function done() { showToast(); }
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
    socket.emit('request shortid', true);
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
    socket.emit('set shortid', name);   // no page reload needed; UI updates on server ack
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
    if (e.target.hasAttribute && e.target.hasAttribute('data-close')) $raw.hidden = true;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$raw.hidden) $raw.hidden = true;
  });

  /* ---------- socket ---------- */

  var socket = io();

  socket.on('connect', function () {
    setStatus('connected', 'Connected — live inbox active');
    var shortid = null;
    try { shortid = localStorage.getItem('shortid'); } catch (e) {}
    if (shortid) {
      socket.emit('set shortid', shortid);
    } else {
      socket.emit('request shortid', true);
    }
  });

  socket.on('disconnect', function () {
    setStatus('disconnected', 'Disconnected — reconnecting…');
  });

  socket.on('shortid', function (id) {
    setMailAddress(id);
    setStatus('connected', 'Connected — live inbox active');
  });

  socket.on('shortid rejected', function (data) {
    var reason = data && data.reason === 'reserved'
      ? 'That name is reserved — pick another'
      : 'Invalid name — use 1-32 letters, digits, . _ -';
    setStatus('error', reason);
    // revert display to the address we actually hold (localStorage was never updated)
    try {
      var saved = localStorage.getItem('shortid');
      if (saved) $shortid.value = saved + '@' + location.hostname;
      else if (currentId) $shortid.value = currentId + '@' + location.hostname;
    } catch (e) { /* private mode */ }
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
    $maillist.prepend(li);
    $empty.style.display = 'none';
  });
})();
