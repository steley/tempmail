/**
 * Analytics loader — the ONLY place analytics lives.
 *
 * Self-hosting: replace this file with your own tracking code, or
 * blank it out to disable analytics entirely. No HTML edits needed.
 *
 * Note: the server CSP (src/web/app.js) currently whitelists
 * googletagmanager.com and *.google-analytics.com / *.analytics.google.com.
 * If you swap in another provider, update the CSP `script-src` and
 * `connect-src` directives accordingly.
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
