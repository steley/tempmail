/**
 * Analytics loader — the ONLY place analytics lives.
 *
 * Self-hosting: replace this file with your own tracking code, or
 * blank it out to disable analytics entirely. No HTML edits needed.
 *
 * CSP: Google's analytics origins are whitelisted by default. For another
 * provider, set ANALYTICS_CSP_EXTRA (its origins) and optionally
 * ANALYTICS_DISABLED=1 on the server — see README "Analytics".
 */
(function () {
  var GA_ID = 'G-ZH4T4XZ5BR'; // set to '' to disable

  if (!GA_ID) return;

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', GA_ID, { anonymize_ip: true });
})();
