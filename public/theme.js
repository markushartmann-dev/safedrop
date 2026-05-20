(function () {
  'use strict';

  var THEMES = {
    dark: {
      '--bg':            '#0f0f17',
      '--card':          'rgba(20,20,33,.9)',
      '--input-bg':      'rgba(255,255,255,.05)',
      '--border':        'rgba(255,255,255,.08)',
      '--accent':        '#6366f1',
      '--accent-dk':     '#4f46e5',
      '--glow':          'rgba(99,102,241,.22)',
      '--glow-ambient':  'rgba(99,102,241,.09)',
      '--success':       '#10b981',
      '--danger':        '#ef4444',
      '--text':          '#e2e8f0',
      '--muted':         '#64748b',
      '--dim':           '#94a3b8',
      /* admin / login / download aliases */
      '--ibg':  'rgba(255,255,255,.05)',
      '--bdr':  'rgba(255,255,255,.08)',
      '--ac':   '#6366f1',
      '--ac2':  '#4f46e5',
      '--ok':   '#10b981',
      '--warn': '#f59e0b',
      '--err':  '#ef4444',
      '--tx':   '#e2e8f0',
      '--mt':   '#64748b',
      '--dm':   '#94a3b8',
      '--side': '#0f0f1a',
    },
    light: {
      '--bg':            '#f1f5f9',
      '--card':          'rgba(255,255,255,.97)',
      '--input-bg':      'rgba(0,0,0,.05)',
      '--border':        'rgba(0,0,0,.12)',
      '--accent':        '#6366f1',
      '--accent-dk':     '#4f46e5',
      '--glow':          'rgba(99,102,241,.15)',
      '--glow-ambient':  'rgba(99,102,241,.06)',
      '--success':       '#059669',
      '--danger':        '#dc2626',
      '--text':          '#1e293b',
      '--muted':         '#475569',  /* darkened for WCAG AA on #f1f5f9 */
      '--dim':           '#334155',
      '--ibg':  'rgba(0,0,0,.05)',
      '--bdr':  'rgba(0,0,0,.12)',
      '--ac':   '#6366f1',
      '--ac2':  '#4f46e5',
      '--ok':   '#059669',
      '--warn': '#b45309',
      '--err':  '#dc2626',
      '--tx':   '#1e293b',
      '--mt':   '#475569',  /* darkened */
      '--dm':   '#334155',
      '--side': '#e2e8f0',
    },
    kitty: {
      '--bg':            '#fff0f6',
      '--card':          'rgba(255,255,255,.97)',
      '--input-bg':      'rgba(233,30,140,.05)',
      '--border':        'rgba(233,30,140,.2)',
      '--accent':        '#e91e8c',
      '--accent-dk':     '#c2185b',
      '--glow':          'rgba(233,30,140,.22)',
      '--glow-ambient':  'rgba(233,30,140,.07)',
      '--success':       '#b5006d',
      '--danger':        '#c62828',
      '--text':          '#4a0030',
      '--muted':         '#9c1957',  /* darkened for WCAG AA on #fff0f6 */
      '--dim':           '#6a0136',
      '--ibg':  'rgba(233,30,140,.05)',
      '--bdr':  'rgba(233,30,140,.2)',
      '--ac':   '#e91e8c',
      '--ac2':  '#c2185b',
      '--ok':   '#b5006d',
      '--warn': '#c05000',
      '--err':  '#c62828',
      '--tx':   '#4a0030',
      '--mt':   '#9c1957',  /* darkened */
      '--dm':   '#6a0136',
      '--side': '#fce4ec',
    },
    veeam: {
      '--bg':            '#071120',
      '--card':          'rgba(8,22,45,.97)',
      '--input-bg':      'rgba(0,179,54,.05)',
      '--border':        'rgba(0,179,54,.15)',
      '--accent':        '#00b336',
      '--accent-dk':     '#009429',
      '--glow':          'rgba(0,179,54,.22)',
      '--glow-ambient':  'rgba(0,179,54,.08)',
      '--success':       '#00b336',
      '--danger':        '#ef4444',
      '--text':          '#ddf0e4',
      '--muted':         '#3d6e4d',
      '--dim':           '#6aaa7e',
      '--ibg':  'rgba(0,179,54,.05)',
      '--bdr':  'rgba(0,179,54,.15)',
      '--ac':   '#00b336',
      '--ac2':  '#009429',
      '--ok':   '#00b336',
      '--warn': '#f59e0b',
      '--err':  '#ef4444',
      '--tx':   '#ddf0e4',
      '--mt':   '#3d6e4d',
      '--dm':   '#6aaa7e',
      '--side': '#040d18',
    }
  };

  function applyVars(name) {
    var vars = THEMES[name] || THEMES.dark;
    var root = document.documentElement;
    for (var k in vars) { root.style.setProperty(k, vars[k]); }
  }

  var _current = localStorage.getItem('fs-theme') || 'dark';
  applyVars(_current); // prevent FOUC – runs synchronously before layout

  function apply(name) {
    if (!THEMES[name]) name = 'dark';
    _current = name;
    localStorage.setItem('fs-theme', name);
    applyVars(name);
    document.querySelectorAll('.theme-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.theme === name);
    });
    if (typeof window.onThemeChange === 'function') window.onThemeChange(name);
  }

  function renderSwitcher(containerId) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var cur = _current;
    var SVG = {
      dark:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>',
      light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
      veeam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
      kitty: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="13" height="13"><path d="M12 21.593c-5.63-5.539-11-10.297-11-14.402 0-3.791 3.068-5.191 5.281-5.191 1.312 0 4.151.501 5.719 4.457 1.59-3.968 4.464-4.447 5.726-4.447 2.54 0 5.274 1.621 5.274 5.181 0 4.069-5.136 8.625-11 14.402z"/></svg>'
    };
    var labels = { dark: 'Dark Mode', light: 'Light Mode', veeam: 'Veeam Corporate', kitty: 'Hello Kitty' };
    el.innerHTML = ['dark','light','veeam','kitty'].map(function(t) {
      return '<button class="theme-btn' + (cur===t?' active':'') + '" data-theme="' + t + '" title="' + labels[t] + '">' + SVG[t] + '</button>';
    }).join('');
    el.querySelectorAll('.theme-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { apply(btn.dataset.theme); });
    });
  }

  window.fsTheme = { apply: apply, current: function () { return _current; }, renderSwitcher: renderSwitcher };
})();
