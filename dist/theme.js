(() => {
  const root = document.documentElement;
  const key = 'atlas-theme';
  const color = document.querySelector('meta[name="theme-color"]');
  function readTheme() {
    try {
      return localStorage.getItem(key) === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }
  let theme = readTheme();

  function apply() {
    root.dataset.theme = theme;
    color.content = theme === 'dark' ? '#101816' : '#f4f3ed';
  }

  apply();

  function bootTheme() {
    const button = document.getElementById('theme');
    if (!button || button.dataset.ready === 'true') return;
    button.dataset.ready = 'true';
    const icon = button.querySelector('span');

    function paint() {
      const action = theme === 'dark' ? 'Light mode' : 'Dark mode';
      button.replaceChildren(icon, document.createTextNode(' ' + action));
      button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      button.title = action + ' (D)';
      button.setAttribute('aria-keyshortcuts', 'D');
    }

    function setTheme(next) {
      theme = next;
      try { localStorage.setItem(key, theme); } catch {}
      apply();
      paint();
      document.dispatchEvent(new Event('atlas-theme-change'));
    }

    paint();
    button.addEventListener('click', () => setTheme(theme === 'dark' ? 'light' : 'dark'));
    document.addEventListener('keydown', event => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== 'd' && event.key !== 'D') return;
      if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      setTheme(theme === 'dark' ? 'light' : 'dark');
    });
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      theme = readTheme();
      apply();
      paint();
      document.dispatchEvent(new Event('atlas-theme-change'));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootTheme);
  else bootTheme();
})();
