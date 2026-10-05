'use strict';
/**
 * MangaHive Phase 1 / Stage 5 — Reader keyboard mapping (pure domain).
 *
 * Maps key events to Reader actions. Does not touch the DOM.
 * Active only when the caller confirms the Reader is the interaction context.
 *
 * Loading: MangaHiveDomain.readerKeyboard / CommonJS.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveDomain = root.MangaHiveDomain || {};
  root.MangaHiveDomain.readerKeyboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  var EDITABLE = {
    INPUT: 1, TEXTAREA: 1, SELECT: 1
  };

  function isEditableTarget(target) {
    if (!target) return false;
    var tag = target.tagName ? String(target.tagName).toUpperCase() : '';
    if (EDITABLE[tag]) return true;
    if (target.isContentEditable) return true;
    if (target.closest) {
      try {
        if (target.closest('input, textarea, select, [contenteditable="true"]')) return true;
      } catch (e) {}
    }
    return false;
  }

  // Elements that natively consume Space/Enter (activation) — Reader must not hijack them.
  var ACTIVATABLE_TAGS = { BUTTON: 1, A: 1, SUMMARY: 1 };
  var ACTIVATABLE_ROLES = {
    button: 1, link: 1, option: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1,
    tab: 1, checkbox: 1, radio: 1, switch: 1, slider: 1, spinbutton: 1, listbox: 1, combobox: 1
  };
  // Widgets that own the arrow / Home / End keys when focused.
  var ARROW_OWNER_ROLES = {
    option: 1, listbox: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1,
    tab: 1, radio: 1, slider: 1, spinbutton: 1, combobox: 1
  };

  function roleOf(target) {
    if (!target || !target.getAttribute) return '';
    try { return String(target.getAttribute('role') || '').toLowerCase(); } catch (e) { return ''; }
  }

  /** True when the focused element is a native/ARIA control that activates on Space/Enter. */
  function isActivatableControl(target) {
    if (!target) return false;
    var tag = target.tagName ? String(target.tagName).toUpperCase() : '';
    if (ACTIVATABLE_TAGS[tag]) return true;
    return !!ACTIVATABLE_ROLES[roleOf(target)];
  }

  /** True when the focused element is a widget that uses arrows/Home/End itself. */
  function ownsArrowKeys(target) {
    if (!target) return false;
    if (ARROW_OWNER_ROLES[roleOf(target)]) return true;
    if (target.closest) {
      try { if (target.closest('[role="listbox"], [role="menu"], [role="tablist"]')) return true; } catch (e) {}
    }
    return false;
  }

  /**
   * @param {object} input
   * @param {string} input.key
   * @param {boolean} [input.shiftKey]
   * @param {boolean} [input.ctrlKey]
   * @param {boolean} [input.metaKey]
   * @param {boolean} [input.altKey]
   * @param {*} [input.target]
   * @param {boolean} input.readerActive
   * @param {boolean} [input.modalOpen] - settings/dialog open
   * @param {boolean} [input.menuOpen] - chapter/page popover open (Escape closes it first)
   * @param {string} [input.mode] - 'webtoon' | 'paged'
   * @param {string} [input.direction] - 'ltr' | 'rtl' | 'ttb'
   * @returns {{ action: string|null, preventDefault: boolean }}
   */
  function resolveKeyAction(input) {
    input = input || {};
    if (!input.readerActive) {
      return { action: null, preventDefault: false };
    }
    if (isEditableTarget(input.target)) {
      return { action: null, preventDefault: false };
    }
    if (input.ctrlKey || input.metaKey || input.altKey) {
      return { action: null, preventDefault: false };
    }

    var key = input.key;
    var mode = input.mode === 'paged' || input.mode === 'rtl' ? 'paged' : 'webtoon';
    var dir = input.direction === 'rtl' ? 'rtl' : (input.direction === 'ltr' ? 'ltr' : 'ttb');
    // paged RTL: physical left advances forward in reading order
    var rtl = mode === 'paged' && dir === 'rtl';

    if (key === 'Escape') {
      if (input.menuOpen) return { action: 'close_menu', preventDefault: true };
      if (input.modalOpen) return { action: 'close_modal', preventDefault: true };
      return { action: 'close_reader', preventDefault: true };
    }

    // A popover owns the keyboard while open (its own handler moves focus / selects).
    if (input.menuOpen) return { action: null, preventDefault: false };
    // A modal sheet owns the keyboard: no paging underneath it (Escape is handled above).
    if (input.modalOpen) return { action: null, preventDefault: false };
    // Space/Enter must activate a focused button/link/option instead of paging.
    if ((key === ' ' || key === 'Spacebar' || key === 'Enter') && isActivatableControl(input.target)) {
      return { action: null, preventDefault: false };
    }
    // Widgets like listbox options / sliders keep their arrow, Home and End keys.
    if ((key.indexOf('Arrow') === 0 || key === 'Home' || key === 'End') && ownsArrowKeys(input.target)) {
      return { action: null, preventDefault: false };
    }

    if (key === 'ArrowLeft') {
      if (mode === 'paged') {
        return {
          action: rtl ? 'next_page' : 'previous_page',
          preventDefault: true
        };
      }
      // continuous: horizontal arrows may still page for accessibility
      return { action: 'previous_page', preventDefault: true };
    }

    if (key === 'ArrowRight') {
      if (mode === 'paged') {
        return {
          action: rtl ? 'previous_page' : 'next_page',
          preventDefault: true
        };
      }
      return { action: 'next_page', preventDefault: true };
    }

    if (key === 'ArrowUp') {
      if (mode === 'paged') return { action: 'previous_page', preventDefault: true };
      return { action: 'scroll_up', preventDefault: true };
    }

    if (key === 'ArrowDown') {
      if (mode === 'paged') return { action: 'next_page', preventDefault: true };
      return { action: 'scroll_down', preventDefault: true };
    }

    if (key === 'PageUp') {
      return { action: 'previous_page', preventDefault: true };
    }
    if (key === 'PageDown') {
      return { action: 'next_page', preventDefault: true };
    }

    if (key === ' ' || key === 'Spacebar') {
      if (input.shiftKey) return { action: 'previous_page', preventDefault: true };
      return { action: 'next_page', preventDefault: true };
    }

    if (key === 'Home') {
      return { action: 'first_page', preventDefault: true };
    }
    if (key === 'End') {
      return { action: 'last_page', preventDefault: true };
    }

    return { action: null, preventDefault: false };
  }

  return {
    isEditableTarget: isEditableTarget,
    isActivatableControl: isActivatableControl,
    ownsArrowKeys: ownsArrowKeys,
    resolveKeyAction: resolveKeyAction
  };
});
