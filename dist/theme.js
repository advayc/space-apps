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
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme');
    function update() {
      apply();
      button.setAttribute('aria-pressed', theme === 'dark');
      document.dispatchEvent(new Event('atlas-theme-change'));
    }
    button.setAttribute('aria-pressed', theme === 'dark');
    button.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, theme); } catch {}
      update();
    });
    window.addEventListener('pageshow', event => {
      if (event.persisted) {
        theme = readTheme();
        update();
      }
    });
  });
})();
