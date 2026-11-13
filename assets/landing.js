// Marketing links open at the introduction, including previously shared #book links.
// Once the page is open, its navigation and Book now links still work normally.
(() => {
  const query = new URLSearchParams(location.search);
  if (query.has('held') || query.has('cancel') || query.has('resume')) return;
  if (location.hash && !['#book', '#top'].includes(location.hash)) return;
  if (location.hash === '#book') history.replaceState(history.state, '', location.pathname + location.search);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const showIntroduction = () => {
    if (!location.hash || location.hash === '#top') window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  };
  showIntroduction();
  window.addEventListener('pageshow', showIntroduction, { once: true });
})();
