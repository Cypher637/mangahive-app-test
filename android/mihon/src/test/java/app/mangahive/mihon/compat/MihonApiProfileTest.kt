package app.mangahive.mihon.compat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the HONESTY of the profile data, not the upstream API (that is the compile gate in android/mihon-compat).
 * Pure JVM; needs no Android SDK.
 */
class MihonApiProfileTest {

    @Test fun profilesAreDefinedAndUnique() {
        assertEquals(listOf("MIHON_1_6", "MIHON_1_4"), MihonApiProfiles.all.map { it.id })
    }

    @Test fun noProfileClaimsRuntimeSupportInStage1() {
        assertTrue(MihonApiProfiles.all.none { it.runtimeImplemented })
    }

    @Test fun mihon16PinsTheUpstreamArtifact() {
        val p = MihonApiProfiles.MIHON_1_6
        assertEquals("com.github.mihonapp:tachiyomix:1.6", p.artifact.value)
        assertEquals("1.6.0", p.releaseTag.value)
    }

    @Test fun unresolvedPinsAreExplicitAndExplained() {
        for (p in MihonApiProfiles.all) for (pin in listOf(p.artifact, p.releaseTag, p.releaseCommit)) {
            if (!pin.resolved) assertTrue("${p.id}: unresolved pin must say so", pin.evidence.startsWith("UNRESOLVED"))
            assertTrue("${p.id}: every pin needs evidence", pin.evidence.isNotBlank())
        }
    }

    @Test fun everyProfileStatesWhatItDoesNotSupport() {
        for (p in MihonApiProfiles.all) {
            assertTrue("${p.id} must list unsupported capabilities", p.unsupportedCapabilities.isNotEmpty())
            assertTrue(
                "${p.id} must disclaim blanket compatibility",
                p.unsupportedCapabilities.any {
                    it.contains("every published extension", ignoreCase = true) || it.contains("until the 1.4 artifact", ignoreCase = true)
                },
            )
        }
    }

    @Test fun noUniversalCompatibilityLanguage() {
        for (p in MihonApiProfiles.all) {
            val claims = p.supportedCapabilities
            assertTrue("${p.id}: capabilities are targets only", claims.all { it.startsWith("TARGET (not implemented)") })
            assertFalse(claims.any { it.contains("universal", ignoreCase = true) || it.contains("all extensions", ignoreCase = true) })
        }
    }

    @Test fun keiSourceIsNotPartOfTheMihonContract() {
        val p = MihonApiProfiles.MIHON_1_6
        assertFalse((p.sourceContract + p.modelContract + p.networkContract).any { it.contains("KeiSource") })
        assertTrue(p.notes.any { it.contains("KeiSource") && it.contains("NOT part of this contract") })
    }
}
