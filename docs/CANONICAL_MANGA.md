# Canonical Manga

MangaHive treats a manga as a first-class local identity independent of any provider. The existing series ID is retained as the canonical ID for backward compatibility.

A canonical manga can have many `sourceMappings`. A source mapping identifies one remote representation and never becomes the canonical identity itself.

Automatic cross-source linking requires an exact existing binding or a unique strong metadata match (title plus year and/or author evidence). Exact-title-only results are candidates, not automatic merges.
