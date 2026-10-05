# Source Development

A compatible Mihon extension must:

- use a supported `tachiyomix` API profile;
- declare the extension feature and entry metadata expected by the detector;
- expose valid package-owned source entry classes;
- provide stable Mihon source IDs;
- use the host-provided network path rather than shipping a second unrestricted socket stack;
- return bounded manga/chapter/page data.

Source developers should not rely on MangaHive-specific private classes. Compatibility belongs in the pinned compat layer and the JDK-only SPI boundary.
