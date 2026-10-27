/*
 * سيليا — تفاعل خريطة Google المجانية.
 * تصفية حالة فقط؛ المحتوى كله ثابت في HTML حتى تعمل الصفحة بلا JavaScript.
 */
const chips = [...document.querySelectorAll('.gm-chip')];
const cards = [...document.querySelectorAll('.gm-card')];

const counts = cards.reduce((acc, card) => {
  acc[card.dataset.status] = (acc[card.dataset.status] || 0) + 1;
  return acc;
}, {});
document.getElementById('gm-count-all').textContent = `(${cards.length})`;

function applyFilter(filter) {
  for (const chip of chips) {
    const active = chip.dataset.filter === filter;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  for (const card of cards) {
    card.hidden = filter !== 'all' && card.dataset.status !== filter;
  }
}

for (const chip of chips) {
  chip.addEventListener('click', () => applyFilter(chip.dataset.filter));
}

document.getElementById('gm-stamp').textContent =
  `CeliaOS free-tier map · ${new Date().toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' })}`;
window.__GMAP_BOOTED = true;
