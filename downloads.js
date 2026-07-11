'use strict';

(function initializeModule(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root && root.document) {
    api.init(root.document);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDownloadsPage() {
  const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
  const SAFE_IMAGE = /^images\/[A-Za-z0-9][A-Za-z0-9._\/-]*\.(?:gif|jpe?g|png|webp)$/i;

  function isSafeLocalImagePath(value) {
    return typeof value === 'string'
      && value.length <= 240
      && SAFE_IMAGE.test(value)
      && !value.includes('..')
      && !value.includes('//')
      && !value.includes('\\');
  }

  function init(documentRef) {
    const lightbox = documentRef.getElementById('lightbox');
    const lightboxImage = documentRef.getElementById('lightbox-img');
    const closeButton = lightbox ? lightbox.querySelector('[data-lightbox-close]') : null;
    let returnFocus = null;

    function toggleExpand(button) {
      const targetId = button.dataset.expandTarget || '';
      if (!SAFE_ID.test(targetId)) {
        return false;
      }

      const details = documentRef.getElementById(targetId);
      if (!details) {
        return false;
      }

      const expanded = details.classList.toggle('show');
      details.setAttribute('aria-hidden', expanded ? 'false' : 'true');
      button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      button.textContent = expanded ? 'Show Less' : 'Read More';
      return expanded;
    }

    function closeLightbox(options = {}) {
      if (!lightbox || !lightboxImage) {
        return false;
      }

      const wasOpen = lightbox.classList.contains('show');
      lightbox.classList.remove('show');
      lightbox.setAttribute('aria-hidden', 'true');
      lightboxImage.removeAttribute('src');
      lightboxImage.setAttribute('alt', '');

      if (wasOpen && options.restoreFocus !== false && returnFocus && typeof returnFocus.focus === 'function') {
        returnFocus.focus();
      }
      returnFocus = null;
      return wasOpen;
    }

    function openLightbox(trigger) {
      if (!lightbox || !lightboxImage || !closeButton) {
        return false;
      }

      const source = trigger.getAttribute('src') || '';
      if (!isSafeLocalImagePath(source)) {
        return false;
      }

      returnFocus = trigger;
      lightboxImage.setAttribute('src', source);
      lightboxImage.setAttribute('alt', trigger.getAttribute('alt') || 'Screenshot preview');
      lightbox.classList.add('show');
      lightbox.setAttribute('aria-hidden', 'false');
      closeButton.focus();
      return true;
    }

    Array.from(documentRef.querySelectorAll('[data-expand-target]')).forEach((button) => {
      button.addEventListener('click', () => toggleExpand(button));
    });

    Array.from(documentRef.querySelectorAll('[data-lightbox]')).forEach((image) => {
      image.addEventListener('click', () => openLightbox(image));
      image.addEventListener('keydown', (keyboardEvent) => {
        if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
          keyboardEvent.preventDefault();
          openLightbox(image);
        }
      });
    });

    if (closeButton) {
      closeButton.addEventListener('click', () => closeLightbox());
    }

    if (lightbox) {
      lightbox.addEventListener('click', (mouseEvent) => {
        if (mouseEvent.target === lightbox) {
          closeLightbox();
        }
      });
    }

    documentRef.addEventListener('keydown', (keyboardEvent) => {
      if (!lightbox || !lightbox.classList.contains('show')) {
        return;
      }

      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault();
        closeLightbox();
      } else if (keyboardEvent.key === 'Tab' && closeButton) {
        keyboardEvent.preventDefault();
        closeButton.focus();
      }
    });

    return { closeLightbox, openLightbox, toggleExpand };
  }

  return { init, isSafeLocalImagePath };
});
