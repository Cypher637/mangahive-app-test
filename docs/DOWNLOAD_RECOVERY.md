# Download Recovery

At startup MangaHive reconstructs persisted download jobs from IndexedDB.

Interrupted queued/resolving/downloading jobs are returned to the queue. Paused jobs remain paused. Completed jobs are not re-downloaded automatically.

Staging data is separate from completed chapter records so a process crash cannot make a partially downloaded chapter appear complete.
