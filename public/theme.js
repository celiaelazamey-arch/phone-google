/*
 * مُحلّل السمة قبل الرسم (WP-1.3، UX-003، DEC-049). سكربت كلاسيكي صغير يُحمَّل في <head> قبل أوراق الأنماط
 * (CSP: script-src 'self' — لا سكربت مضمّن) فيضع data-theme على <html> قبل أول رسم: لا وميض.
 *
 * القاعدة: اختيار مخزّن صالح (`dark`/`oled`/`light` في localStorage['celia_theme']) يُطبَّق؛ غير ذلك («يتبع النظام»)
 * تُزال السمة ويقرر prefers-color-scheme عبر theme.css. المفتاح نفسه الذي يستخدمه الاستوديو (app.js) فيبقى
 * الاختيار الصريح مشتركًا بين الصفحات؛ قيمة لا يعرفها الاستوديو (oled) يعاملها هو كـdark.
 */
(function () {
  'use strict';
  var KEY = 'celia_theme';
  var THEMES = ['dark', 'oled', 'light'];
  var SYSTEM = 'system';
  var root = document.documentElement;

  function readStored() {
    try {
      var value = window.localStorage.getItem(KEY);
      return THEMES.indexOf(value) === -1 ? SYSTEM : value;
    } catch (error) {
      return SYSTEM; // وضع خاص/تخزين معطّل: اتبع النظام بلا خطأ
    }
  }

  function writeStored(choice) {
    try {
      if (choice === SYSTEM) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, choice);
    } catch (error) {
      /* لا تخزين → الاختيار يعيش لهذه الصفحة فقط */
    }
  }

  function systemPrefersLight() {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    } catch (error) {
      return false;
    }
  }

  function apply(choice) {
    if (THEMES.indexOf(choice) === -1) {
      root.removeAttribute('data-theme');
      choice = SYSTEM;
    } else {
      root.setAttribute('data-theme', choice);
    }
    root.setAttribute('data-theme-resolved', choice === SYSTEM ? (systemPrefersLight() ? 'light' : 'dark') : choice);
    return choice;
  }

  var current = apply(readStored());

  function syncSwitchers() {
    var nodes = document.querySelectorAll('select[data-theme-switcher]');
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].value !== current) nodes[i].value = current;
    }
  }

  function set(choice) {
    current = apply(THEMES.indexOf(choice) === -1 ? SYSTEM : choice);
    writeStored(current);
    syncSwitchers();
    return current;
  }

  window.celiaTheme = {
    themes: THEMES.slice(),
    get: function () {
      return current;
    },
    resolved: function () {
      return root.getAttribute('data-theme-resolved');
    },
    set: set
  };

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (target && target.matches && target.matches('select[data-theme-switcher]')) set(target.value);
  });
  document.addEventListener('DOMContentLoaded', syncSwitchers);
  try {
    var query = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    if (query && typeof query.addEventListener === 'function') {
      query.addEventListener('change', function () {
        apply(current);
      });
    }
  } catch (error) {
    /* بلا matchMedia: السمة الصريحة فقط */
  }
})();
