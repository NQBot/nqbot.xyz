'use strict';

(function initializeModule(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root && root.document) {
    api.init(root.document);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAlgoPage() {
  const ALLOWED_SESSIONS = new Set(['all', 'US', 'Asian', 'European']);
  const SECTION_BOUNDARIES = ['cat-header', 'appointment-box', 'summary-section'];

  function isSectionBoundary(element) {
    return SECTION_BOUNDARIES.some((className) => element.classList.contains(className));
  }

  function categoryHasVisibleCard(header) {
    let sibling = header.nextElementSibling;

    while (sibling && !isSectionBoundary(sibling)) {
      if (sibling.classList.contains('algo-card') && !sibling.classList.contains('hidden')) {
        return true;
      }
      sibling = sibling.nextElementSibling;
    }

    return false;
  }

  function filterSession(documentRef, requestedSession) {
    const session = ALLOWED_SESSIONS.has(requestedSession) ? requestedSession : 'all';
    const cards = Array.from(documentRef.querySelectorAll('.algo-card'));
    const buttons = Array.from(documentRef.querySelectorAll('[data-session-filter]'));
    const categories = Array.from(documentRef.querySelectorAll('.cat-header'));

    buttons.forEach((button) => {
      const selected = button.dataset.sessionFilter === session;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });

    cards.forEach((card) => {
      const sessions = (card.dataset.sessions || '').split(',').map((value) => value.trim());
      const visible = session === 'all' || sessions.includes(session);
      card.classList.toggle('hidden', !visible);
    });

    categories.forEach((category) => {
      category.classList.toggle('hidden', !categoryHasVisibleCard(category));
    });

    return session;
  }

  function init(documentRef) {
    const buttons = Array.from(documentRef.querySelectorAll('[data-session-filter]'));

    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        filterSession(documentRef, button.dataset.sessionFilter);
      });
    });

    return { filterSession: (session) => filterSession(documentRef, session) };
  }

  return { filterSession, init };
});
