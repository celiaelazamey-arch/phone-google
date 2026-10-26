/* ============================================================
   Celia 2026 — Landing interactions (سيليا)
   External file only (CSP: script-src 'self'). Progressive:
   the page is fully readable/usable without JavaScript.
   ============================================================ */
(function () {
  'use strict';

  document.documentElement.classList.add('js');
  var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  function toArabicDigits(value) {
    return String(value).replace(/[0-9]/g, function (d) { return AR_DIGITS[Number(d)]; });
  }

  /* ---------- Sticky navbar + scroll progress ---------- */
  var navbar = document.getElementById('navbar');
  var progress = document.getElementById('scroll-progress');
  var ticking = false;
  function onScroll() {
    var y = window.scrollY || 0;
    if (navbar) navbar.classList.toggle('scrolled', y > 24);
    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? Math.min(1, y / max) : 0;
      progress.style.transform = 'scaleX(' + ratio + ')';
    }
    ticking = false;
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; window.requestAnimationFrame(onScroll); }
  }, { passive: true });
  onScroll();

  /* ---------- Mobile nav ---------- */
  var navToggle = document.getElementById('nav-toggle');
  var navMenu = document.getElementById('nav-menu');
  function closeNav(restoreFocus) {
    if (!navMenu || !navToggle) return;
    var wasOpen = navMenu.classList.contains('open');
    navMenu.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', 'فتح قائمة التنقل');
    if (restoreFocus && wasOpen) navToggle.focus();
  }
  if (navToggle && navMenu) {
    navToggle.addEventListener('click', function () {
      var open = navMenu.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? 'إغلاق قائمة التنقل' : 'فتح قائمة التنقل');
    });
    navMenu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () { closeNav(false); });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNav(true); });
    document.addEventListener('click', function (e) {
      if (navMenu.classList.contains('open') && !navbar.contains(e.target)) closeNav(false);
    });
  }

  /* ---------- Active section highlight ---------- */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-menu a[href^="#"]'));
  if ('IntersectionObserver' in window && navLinks.length) {
    var byHash = {};
    navLinks.forEach(function (l) { byHash[l.getAttribute('href')] = l; });
    var sectionObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        navLinks.forEach(function (l) {
          l.classList.remove('active-link');
          l.removeAttribute('aria-current');
        });
        var link = byHash['#' + entry.target.id];
        if (link) {
          link.classList.add('active-link');
          link.setAttribute('aria-current', 'location');
        }
      });
    }, { rootMargin: '-35% 0px -55% 0px' });
    ['features', 'showcase', 'tools', 'pricing', 'faq'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) sectionObserver.observe(el);
    });
  }

  /* ---------- Scroll reveal (staggered via CSS --d) ---------- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if ('IntersectionObserver' in window && !prefersReduced) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('inview');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(function (el) { revealObserver.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('inview'); });
  }

  /* ---------- Animated counters (Arabic-Indic digits) ---------- */
  var counters = Array.prototype.slice.call(document.querySelectorAll('.counter'));
  function runCounter(el) {
    var target = Number(el.getAttribute('data-target') || '0');
    var suffix = el.getAttribute('data-suffix') || '';
    if (prefersReduced) { el.textContent = toArabicDigits(target) + suffix; return; }
    var start = null;
    var duration = 1400;
    function frame(ts) {
      if (!start) start = ts;
      var p = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = toArabicDigits(Math.round(target * eased)) + suffix;
      if (p < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }
  if ('IntersectionObserver' in window) {
    var counterObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { runCounter(entry.target); counterObserver.unobserve(entry.target); }
      });
    }, { threshold: 0.5 });
    counters.forEach(function (c) { counterObserver.observe(c); });
  } else {
    counters.forEach(runCounter);
  }

  /* ---------- Magnetic buttons + card glow (fine pointers only) ---------- */
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (finePointer && !prefersReduced) {
    document.querySelectorAll('.magnetic').forEach(function (btn) {
      btn.addEventListener('pointermove', function (e) {
        var rect = btn.getBoundingClientRect();
        var x = (e.clientX - rect.left - rect.width / 2) * 0.12;
        var y = (e.clientY - rect.top - rect.height / 2) * 0.18;
        btn.style.setProperty('--mx', x.toFixed(1) + 'px');
        btn.style.setProperty('--my', y.toFixed(1) + 'px');
      });
      btn.addEventListener('pointerleave', function () {
        btn.style.setProperty('--mx', '0px');
        btn.style.setProperty('--my', '0px');
      });
    });
    document.querySelectorAll('.card').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var rect = card.getBoundingClientRect();
        card.style.setProperty('--gx', ((e.clientX - rect.left) / rect.width * 100).toFixed(1) + '%');
        card.style.setProperty('--gy', ((e.clientY - rect.top) / rect.height * 100).toFixed(1) + '%');
      });
    });

    /* Phone tilt */
    var phone = document.getElementById('phone');
    var heroVisual = phone ? phone.parentElement : null;
    if (phone && heroVisual) {
      heroVisual.addEventListener('pointermove', function (e) {
        var rect = heroVisual.getBoundingClientRect();
        var rx = ((e.clientY - rect.top) / rect.height - 0.5) * -7;
        var ry = ((e.clientX - rect.left) / rect.width - 0.5) * 9;
        phone.style.transform = 'rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
      });
      heroVisual.addEventListener('pointerleave', function () { phone.style.transform = ''; });
    }
  }

  /* ---------- Live chat typing loop ---------- */
  var chatLog = document.getElementById('chat-log');
  var typingBubble = document.getElementById('typing-bubble');
  var chatSteps = [
    { dir: 'out', text: 'تم التنسيق مساءً. سأرسل التذكير قبل الموعد، ولأي تفاصيل عن الطلب سيتابعك موظف مختص مباشرة.' },
    { dir: 'in', text: 'ممتاز، هل يمكنك إرسال ملف العقد على البريد؟' },
    { dir: 'out', text: 'وجدت الملف في Drive — بياناته جاهزة الآن في مساحة العمل، وفريقنا سيشاركه معك بأمان من القناة الرسمية.' }
  ];
  if (chatLog && typingBubble && !prefersReduced) {
    var stepIndex = 0;
    var chatTimer = null;
    var chatVisible = false;
    function playStep() {
      if (!chatVisible) return;
      var step = chatSteps[stepIndex % chatSteps.length];
      stepIndex += 1;
      if (step.dir === 'out') {
        typingBubble.hidden = false;
        chatTimer = window.setTimeout(function () {
          typingBubble.hidden = true;
          appendBubble(step);
          chatTimer = window.setTimeout(playStep, 2600);
        }, 1300);
      } else {
        appendBubble(step);
        chatTimer = window.setTimeout(playStep, 2200);
      }
    }
    function appendBubble(step) {
      var bubbles = chatLog.querySelectorAll('.bubble:not(.typing)');
      if (bubbles.length > 5 && bubbles[0]) bubbles[0].remove();
      var p = document.createElement('p');
      p.className = 'bubble ' + step.dir;
      p.textContent = step.text;
      chatLog.insertBefore(p, typingBubble);
    }
    if ('IntersectionObserver' in window) {
      var chatObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          chatVisible = entry.isIntersecting;
          if (chatVisible && !chatTimer) chatTimer = window.setTimeout(playStep, 1600);
          if (!chatVisible && chatTimer) { window.clearTimeout(chatTimer); chatTimer = null; typingBubble.hidden = true; }
        });
      }, { threshold: 0.3 });
      chatObserver.observe(chatLog);
    }
  }

  /* ---------- Showcase tabs (full keyboard support) ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function activateTab(tab, focusPanel) {
    tabs.forEach(function (t) {
      var selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.setAttribute('tabindex', selected ? '0' : '-1');
      var panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    });
    if (focusPanel) tab.focus();
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { activateTab(tab, false); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowLeft') next = tabs[(index + 1) % tabs.length]; /* RTL: left = next */
      else if (e.key === 'ArrowRight') next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); activateTab(next, true); }
    });
  });

  /* ---------- FAQ accordion ---------- */
  var faqButtons = Array.prototype.slice.call(document.querySelectorAll('.faq-btn'));
  faqButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var isOpen = btn.getAttribute('aria-expanded') === 'true';
      faqButtons.forEach(function (other) {
        other.setAttribute('aria-expanded', 'false');
        var otherPanel = document.getElementById(other.getAttribute('aria-controls'));
        if (otherPanel) otherPanel.hidden = true;
        var item = other.closest('.faq-item');
        if (item) item.classList.remove('open');
      });
      if (!isOpen) {
        btn.setAttribute('aria-expanded', 'true');
        var panel = document.getElementById(btn.getAttribute('aria-controls'));
        if (panel) panel.hidden = false;
        var parentItem = btn.closest('.faq-item');
        if (parentItem) parentItem.classList.add('open');
      }
    });
  });

  /* ---------- Pricing toggle ---------- */
  var billingButtons = Array.prototype.slice.call(document.querySelectorAll('[data-billing]'));
  function setBilling(mode) {
    billingButtons.forEach(function (b) {
      var active = b.getAttribute('data-billing') === mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('.price .amount').forEach(function (amount) {
      var value = amount.getAttribute(mode === 'yearly' ? 'data-yearly' : 'data-monthly');
      if (!value || amount.textContent === value) return;
      amount.textContent = value;
      if (!prefersReduced) {
        amount.classList.remove('flip');
        void amount.offsetWidth; /* restart animation */
        amount.classList.add('flip');
      }
    });
    document.querySelectorAll('.price .per').forEach(function (per) {
      var value = per.getAttribute(mode === 'yearly' ? 'data-yearly' : 'data-monthly');
      if (value) per.textContent = value;
    });
  }
  billingButtons.forEach(function (b) {
    b.addEventListener('click', function () { setBilling(b.getAttribute('data-billing')); });
  });

  /* ---------- Lead form (demo: local-only, no network) ---------- */
  var leadForm = document.getElementById('lead-form');
  if (leadForm) {
    leadForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = document.getElementById('lead-name');
      var email = document.getElementById('lead-email');
      var errorEl = document.getElementById('form-error');
      var successEl = document.getElementById('form-success');
      var nameOk = name && name.value.trim().length >= 2;
      var emailOk = email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim());
      if (name) {
        name.classList.toggle('invalid', !nameOk);
        name.setAttribute('aria-invalid', String(!nameOk));
      }
      if (email) {
        email.classList.toggle('invalid', !emailOk);
        email.setAttribute('aria-invalid', String(!emailOk));
      }
      if (!nameOk || !emailOk) {
        if (successEl) successEl.hidden = true;
        if (errorEl) {
          errorEl.hidden = false;
          errorEl.textContent = !nameOk ? 'فضلًا أدخل اسمك الكامل (حرفان على الأقل).' : 'فضلًا أدخل بريدًا إلكترونيًا صحيحًا.';
        }
        (!nameOk ? name : email).focus();
        return;
      }
      if (errorEl) errorEl.hidden = true;
      try {
        window.sessionStorage.setItem('celia-lead-name', name.value.trim());
      } catch (err) { /* storage may be unavailable; the demo still succeeds */ }
      if (successEl) {
        successEl.hidden = false;
        successEl.textContent = 'أهلًا ' + name.value.trim() + '! تم الحفظ محليًا في متصفحك (تجريبيًا، دون أي إرسال خارجي). خطوتك التالية: افتح التجربة الحية الآن.';
      }
      leadForm.querySelector('button[type="submit"]').textContent = 'تم الحفظ محليًا — التجربة الحية من الأسفل';
    });
  }

  /* ---------- Live status probe (same-origin; static shim serves it on Pages) ---------- */
  var liveStatusText = document.getElementById('live-status-text');
  if (liveStatusText && typeof window.fetch === 'function') {
    var healthUrl = new URL('./health', window.location.href).toString();
    window.fetch(healthUrl, { headers: { accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('health-not-ok')); })
      .then(function (data) {
        var tools = data.toolsCount || data.tools || 12;
        liveStatusText.textContent = 'المساحة الحية تعمل الآن · ' + toArabicDigits(tools) + ' أداة متصلة';
      })
      .catch(function () {
        liveStatusText.textContent = 'افتح المساحة الحية وجرّب الأدوات الـ١٢ الآن';
      });
  }

  /* ---------- Back to top ---------- */
  var toTop = document.getElementById('to-top');
  if (toTop) {
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: prefersReduced ? 'auto' : 'smooth' });
    });
  }
})();
