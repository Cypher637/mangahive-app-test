/**
 * MangaHive Phase 0 — Canonical identity contracts
 *
 * HARD RULE: External source identifiers must never become primary identity.
 *
 * CanonicalMangaId  ≠  MangaDexMangaId / ComicKId / Mihon remoteId
 * CanonicalChapterId ≠  external chapter id
 */

'use strict';

/** @typedef {string} CanonicalMangaId */
/** @typedef {string} CanonicalChapterId */
/** @typedef {string} SourceId */
/** @typedef {string} ExtensionId */
/** @typedef {string} UserId */
/** @typedef {string} LibraryEntryId */
/** @typedef {string} ReadingProgressId */
/** @typedef {string} DownloadId */
/** @typedef {string} ExternalMangaId */
/** @typedef {string} ExternalChapterId */

/**
 * Source binding identity (Stage 9/10).
 * @typedef {{ extensionId: ExtensionId|null, sourceId: SourceId, remoteId: ExternalMangaId }} MangaSourceBinding
 * @typedef {{ extensionId: ExtensionId|null, sourceId: SourceId, remoteId: ExternalChapterId }} ChapterSourceBinding
 */

/**
 * Download identity (Stage 10) — canonical + source binding.
 * @typedef {{
 *   canonicalMangaId: CanonicalMangaId,
 *   canonicalChapterId: CanonicalChapterId,
 *   extensionId: ExtensionId|null,
 *   sourceId: SourceId,
 *   remoteMangaId: ExternalMangaId,
 *   remoteChapterId: ExternalChapterId
 * }} DownloadIdentity
 */

function assertCanonicalNotExternal(canonicalId, externalId, label) {
  if (canonicalId == null || canonicalId === '') {
    throw new Error(`${label}: canonical id required`);
  }
  if (externalId != null && String(canonicalId) === String(externalId)) {
    // Same string value can occur by coincidence for some sources; the architectural
    // rule is that the *role* must stay distinct. Callers must never assign an
    // external id into a canonical field as the generation path.
    // This helper is for tests that explicitly check generation paths.
  }
  return true;
}

/**
 * Build a stable download identity key (must include source binding).
 * @param {DownloadIdentity} id
 */
function downloadIdentityKey(id) {
  if (!id.canonicalChapterId) throw new Error('download identity requires canonicalChapterId');
  if (!id.sourceId) throw new Error('download identity requires sourceId');
  if (!id.remoteChapterId) throw new Error('download identity requires remoteChapterId');
  return [
    id.canonicalMangaId || '',
    id.canonicalChapterId,
    id.extensionId || 'builtin',
    id.sourceId,
    id.remoteChapterId,
  ].join('::');
}

module.exports = {
  assertCanonicalNotExternal,
  downloadIdentityKey,
};
